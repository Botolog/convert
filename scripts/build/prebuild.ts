import { join, relative } from "path";
import { cp, lutimes, mkdir, readdir, rm } from "fs/promises";
import { $ } from "bun";
import type { ArgsDef, ParsedArgs } from "citty";
import { assembleAll, prepareSource } from "./assemble";
import {
  BASE_DOCKERFILE,
  CACHE_DIR,
  PREBUILD_SCRIPT,
  ROOT_SCOPE,
  TOOLCHAIN_SCOPE,
  findPrebuilts,
  loadRequirements,
  prebuiltPath,
  subrecipeScope,
  type Scope,
} from "./common";
import { hashFile, hashInputs } from "./hash";
import { resolveToolchains, toolchainsOf } from "./toolchains";
import {
  hasSource,
  isPrebuilt,
  isSubrecipe,
  type PrebuildRequirement,
  type RequirementsConfig,
} from "./types";

const PLATFORM = "linux/amd64";

const PACK_SCRIPT = `
  cd /pack
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    --mode=a+rX,u+w,go-w --format=gnu -cf - out | gzip -9n > out.tar.gz
`;

export const prebuildArgs = {
  verbose: { type: "boolean", description: "Be louder" },
  force: { type: "boolean", description: "Rebuild, even if the inputs didn't change" },
  check: {
    type: "boolean",
    description: "Rebuild and verify the prebuilt artifacts without writing",
  },
  "keep-tmp": { type: "boolean", description: "Keep the prebuild folder for manual investigation" },
} as const satisfies ArgsDef;

export type PrebuildArgs = ParsedArgs<typeof prebuildArgs>;

// with --check, failures are collected here instead of stopping the run
type CheckReport = { passed: string[]; failed: { name: string; error: string }[] };

let baseImage: Promise<string> | undefined;

function getBaseImage() {
  return (baseImage ??= (async () => {
    const dockerfile = await Bun.file(BASE_DOCKERFILE).bytes();
    const tag = `convert-build:${hashFile("sha256", dockerfile).slice(0, 16)}`;
    const { exitCode } = await $`docker image inspect ${tag}`.quiet().nothrow();
    if (exitCode !== 0) {
      console.log(`Building base image ${tag}...`);
      await $`docker build --platform=${PLATFORM} -t ${tag} - < ${BASE_DOCKERFILE}`;
    }
    return tag;
  })());
}

async function prepareToolchains(requirement: PrebuildRequirement, args: PrebuildArgs) {
  const toolchains = await resolveToolchains(toolchainsOf(requirement));
  // toolchains are only cached locally, so --force and --check are for the recipe itself
  const toolchainArgs = Object.assign({}, args, { force: false, check: false });
  await prebuildAll(toolchains, TOOLCHAIN_SCOPE, toolchainArgs, false);
  await assembleAll(toolchains, TOOLCHAIN_SCOPE, { verbose: args.verbose });
  return toolchains;
}

type DockerOptions = {
  mounts: Record<string, string>; // host path -> container path
  env?: Record<string, string>;
  network?: boolean;
};

async function dockerRun(command: string[], { mounts, env = {}, network = false }: DockerOptions) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const vars = { HOME: "/tmp", SOURCE_DATE_EPOCH: "0", TZ: "UTC", LC_ALL: "C", ...env };

  const args = [
    "run",
    "--rm",
    `--platform=${PLATFORM}`,
    ...(network ? [] : ["--network=none"]),
    ...(uid !== undefined && gid !== undefined ? [`--user=${uid}:${gid}`] : []),
    ...Object.entries(mounts).flatMap(([host, container]) => ["-v", `${host}:${container}`]),
    ...Object.entries(vars).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
  ];
  await $`docker ${args} ${await getBaseImage()} ${command}`;
}

async function prebuild(
  requirement: PrebuildRequirement,
  scope: Scope,
  args: PrebuildArgs,
  report?: CheckReport,
) {
  if (report) {
    try {
      await prebuild(requirement, scope, args);
      report.passed.push(requirement.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      report.failed.push({ name: requirement.name, error: message });
    }
    return;
  }

  const inputs = await hashInputs(requirement, scope);
  const existing = await findPrebuilts(requirement, scope);

  if (args.check) {
    const expectedPath = prebuiltPath(requirement, scope, inputs);
    const expectedFile = Bun.file(expectedPath);
    if (!(await expectedFile.exists())) {
      throw new Error(
        `Prebuilt ${requirement.name} is missing or out of date, expected ${relative(ROOT_SCOPE.prebuiltDir, expectedPath)}.`,
      );
    }
    const expected = hashFile("sha256", await expectedFile.bytes());
    const actual = hashFile("sha256", await build(requirement, scope, args));
    if (actual !== expected) {
      throw new Error(
        `Prebuilt ${requirement.name} is not reproducible (committed sha256 ${expected}, built sha256 ${actual}).`,
      );
    }
    const stale = existing.filter((prebuilt) => prebuilt.inputs !== inputs);
    if (stale.length) {
      throw new Error(
        `Found stale prebuilt ${stale.map(({ path }) => relative(ROOT_SCOPE.prebuiltDir, path)).join(", ")}.`,
      );
    }
    console.log(`Prebuilt ${requirement.name} is correct (sha256 ${actual}).`);
    return;
  }

  if (!args.force && existing.some((prebuilt) => prebuilt.inputs === inputs)) {
    for (const prebuilt of existing) {
      if (prebuilt.inputs !== inputs) await removeStale(prebuilt.path, args);
    }
    if (args.verbose) console.log(`Prebuilt ${requirement.name} is up to date.`);
    return;
  }

  const tarball = await build(requirement, scope, args);
  for (const { path } of existing) await removeStale(path, args);
  await Bun.write(prebuiltPath(requirement, scope, inputs), tarball);
  console.log(`Prebuilt ${requirement.name} (sha256 ${hashFile("sha256", tarball)}).`);
}

async function build(
  requirement: PrebuildRequirement,
  scope: Scope,
  args: PrebuildArgs,
): Promise<Uint8Array> {
  const sub = subrecipeScope(scope, requirement.name);
  await assembleAll(await loadRequirements(sub.recipeDir), sub, { verbose: args.verbose });
  const toolchains = (await prepareToolchains(requirement, args)).map(({ name }) => name);

  const tmp = join(CACHE_DIR, `prebuild-${crypto.randomUUID()}`);
  const sourceDir = join(tmp, "source");
  const requirementsDir = join(tmp, "requirements");
  const outDir = join(tmp, "out");
  await mkdir(outDir, { recursive: true });

  try {
    // the build gets its own copy of the sources, so it can build in-tree
    if (hasSource(requirement)) {
      await prepareSource(requirement, scope, sourceDir, { verbose: args.verbose });
    } else {
      await mkdir(sourceDir, { recursive: true });
    }
    // and of its requirements
    await cp(sub.outDir, requirementsDir, { recursive: true, verbatimSymlinks: true });
    for (const entry of await readdir(requirementsDir, { recursive: true, withFileTypes: true })) {
      // autoconf stuff
      await lutimes(join(entry.parentPath, entry.name), 0, 0);
    }

    const usingToolchains = toolchains.length ? ` with ${toolchains.join(", ")}` : "";
    console.log(`Prebuilding ${requirement.name}${usingToolchains}...`);
    await dockerRun(["sh", "-eu", "/prebuild.sh", requirement.prebuild], {
      mounts: {
        [PREBUILD_SCRIPT]: "/prebuild.sh:ro",
        [sub.recipeDir]: "/recipe:ro",
        [requirementsDir]: "/requirements",
        [TOOLCHAIN_SCOPE.recipeDir]: "/setup:ro",
        ...Object.fromEntries(
          toolchains.map((name) => [join(TOOLCHAIN_SCOPE.outDir, name), `/toolchains/${name}:ro`]),
        ),
        [sourceDir]: "/source",
        [outDir]: "/out",
      },
      env: {
        SOURCE_DIR: "/source",
        RECIPE_DIR: "/recipe",
        REQUIREMENTS_DIR: "/requirements",
        OUT_DIR: "/out",
        TOOLCHAINS_DIR: "/toolchains",
        SETUP_DIR: "/setup",
        TOOLCHAINS: toolchains.join(" "),
      },
      network: requirement.allowNetwork,
    });

    if (!(await readdir(outDir)).length) {
      throw new Error(`Prebuild script for ${requirement.name} produced no output.`);
    }

    await dockerRun(["sh", "-euc", PACK_SCRIPT], { mounts: { [tmp]: "/pack" } });

    return await Bun.file(join(tmp, "out.tar.gz")).bytes();
  } finally {
    if (!args["keep-tmp"]) await rm(tmp, { recursive: true, force: true });
    else {
      console.log(`Keeping folder ${tmp}.`);
      console.log("You should probably delete it after you are done.");
    }
  }
}

export async function prebuildAll(
  requirements: RequirementsConfig,
  scope: Scope,
  args: PrebuildArgs,
  prune = true,
) {
  const report: CheckReport | undefined = args.check ? { passed: [], failed: [] } : undefined;
  await prebuildTree(requirements, scope, args, prune, report);
  if (!report) return;

  console.log("\nCheck summary:");
  for (const name of report.passed) console.log(`  ok    ${name}`);
  for (const { name, error } of report.failed) console.log(`  FAIL  ${name}: ${error}`);
  const total = report.passed.length + report.failed.length;
  console.log(`${total} checked, ${report.passed.length} passed, ${report.failed.length} failed.`);
  if (report.failed.length) process.exitCode = 1;
}

async function prebuildTree(
  requirements: RequirementsConfig,
  scope: Scope,
  args: PrebuildArgs,
  prune: boolean,
  report?: CheckReport,
) {
  // one at a time, builds are heavy
  for (const requirement of requirements) {
    if (!isSubrecipe(requirement)) continue;
    const sub = subrecipeScope(scope, requirement.name);
    await prebuildTree(await loadRequirements(sub.recipeDir), sub, args, true, report);
    if (isPrebuilt(requirement)) await prebuild(requirement, scope, args, report);
  }

  if (prune) await removeOrphans(requirements, scope, args, report);
}

async function removeStale(path: string, args: PrebuildArgs, report?: CheckReport) {
  if (args.check) {
    const name = relative(ROOT_SCOPE.prebuiltDir, path);
    const error = `Found stale prebuilt ${name}.`;
    if (!report) throw new Error(error);
    console.error(error);
    report.failed.push({ name, error: "stale" });
    return;
  }
  await rm(path, { recursive: true, force: true });
  console.log(`Removed stale prebuilt ${relative(ROOT_SCOPE.prebuiltDir, path)}.`);
}

async function removeOrphans(
  requirements: RequirementsConfig,
  scope: Scope,
  args: PrebuildArgs,
  report?: CheckReport,
) {
  let entries;
  try {
    entries = await readdir(scope.prebuiltDir, { withFileTypes: true });
  } catch {
    return;
  }

  const subrecipes = new Set(requirements.filter(isSubrecipe).map((r) => r.name));
  const prebuilts = new Set(
    (
      await Promise.all(requirements.filter(isPrebuilt).map((r) => findPrebuilts(r, scope)))
    ).flatMap((found) => found.map(({ path }) => path)),
  );

  for (const entry of entries) {
    const path = join(scope.prebuiltDir, entry.name);
    const keep = entry.isDirectory() ? subrecipes.has(entry.name) : prebuilts.has(path);
    if (!keep) await removeStale(path, args, report);
  }
}
