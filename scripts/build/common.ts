import { isAbsolute, join, normalize } from "path";
import { mkdir, readdir, rm, rename, chmod, stat } from "fs/promises";
import JSZip from "jszip";
import type { ArgsDef } from "citty";
import type { PrebuildRequirement, RequirementsConfig } from "./types";
import { $ } from "bun";

const OUT_DIR = join(import.meta.dir, "../../built");
export const CACHE_DIR = join(import.meta.dir, "../../.cache/convert-build");
export const DOWNLOADS_DIR = join(CACHE_DIR, "downloads");
const RECIPE_DIR = join(import.meta.dir, "../../recipe");
const PREBUILT_DIR = join(import.meta.dir, "../../prebuilt");

export const PREBUILD_VERSION = 1;

export const PACK_IMAGE =
  "debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

export type Scope = {
  recipeDir: string;
  outDir: string;
  stateDir: string;
  prebuiltDir: string;
};

export const ROOT_SCOPE: Scope = {
  recipeDir: RECIPE_DIR,
  outDir: OUT_DIR,
  stateDir: CACHE_DIR,
  prebuiltDir: PREBUILT_DIR,
};

export function subrecipeScope(scope: Scope, name: string): Scope {
  const stateDir = join(scope.stateDir, "subrecipes", name);
  return {
    recipeDir: join(scope.recipeDir, name),
    outDir: join(stateDir, "requirements"),
    stateDir,
    prebuiltDir: join(scope.prebuiltDir, name),
  };
}

export async function loadRequirements(recipeDir: string): Promise<RequirementsConfig> {
  const configPath = join(recipeDir, "requirements.config.ts");
  if (!(await Bun.file(configPath).exists())) return [];
  return (await import(configPath)).default;
}

export const selectArgs = {
  requirements: {
    type: "positional",
    required: false,
    description: "Names of the top-level requirements to build",
  },
  all: { type: "boolean", description: "Build every requirement" },
} as const satisfies ArgsDef;

export function selectRequirements(
  requirements: RequirementsConfig,
  names: string[],
  all: boolean | undefined,
): RequirementsConfig {
  if (all && names.length) throw new Error("Pass either requirement names or --all, not both.");
  if (all) return requirements;
  if (!names.length)
    throw new Error("Pass requirement names to build, or --all to build everything.");

  const byName = new Map(requirements.map((requirement) => [requirement.name, requirement]));
  const unknown = names.filter((name) => !byName.has(name));
  if (unknown.length) throw new Error(`Unknown requirements: ${unknown.join(", ")}.`);
  return [...new Set(names)].map((name) => byName.get(name)!);
}

export function prebuiltPath(requirement: PrebuildRequirement, scope: Scope, inputs: string) {
  return join(scope.prebuiltDir, `${requirement.name}-${inputs}.tar.gz`);
}

export async function findPrebuilts(requirement: PrebuildRequirement, scope: Scope) {
  const pattern = new RegExp(`^${RegExp.escape(requirement.name)}-([0-9a-f]{64})\\.tar\\.gz$`);
  let entries: string[];
  try {
    entries = await readdir(scope.prebuiltDir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const inputs = pattern.exec(entry)?.[1];
    return inputs ? [{ path: join(scope.prebuiltDir, entry), inputs }] : [];
  });
}

async function extractInto(outPath: string, extract: (dir: string) => Promise<void>) {
  const tmp = join(CACHE_DIR, `tmp-${crypto.randomUUID()}`);
  try {
    await mkdir(tmp, { recursive: true });
    await rm(outPath, { recursive: true, force: true });

    await extract(tmp);

    // unwrap a single top-level directory, like the one github archives have
    const entries = await readdir(tmp, { withFileTypes: true });
    const [inner] = entries;
    if (entries.length === 1 && inner.isDirectory()) await rename(join(tmp, inner.name), outPath);
    else await rename(tmp, outPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function extractTarball(outPath: string, tarball: Uint8Array) {
  await extractInto(outPath, (dir) => new Bun.Archive(tarball).extract(dir).then(() => {}));
}

export async function extractTarballNative(outPath: string, tarball: Uint8Array) {
  await extractInto(outPath, async (dir) => {
    const tmp = join(CACHE_DIR, `tmp-${crypto.randomUUID()}`);
    try {
      await Bun.write(tmp, tarball);
      await $`tar -xf ${tmp} -C ${dir}`;
      // tar respects permissions unlike others, so we need to fix them
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        await chmod(path, (await stat(path)).mode | 0o200); // u+w
      }
    } finally {
      await rm(tmp, { force: true });
    }
  });
}

export async function extractZip(outPath: string, zip: Uint8Array) {
  await extractInto(outPath, async (dir) => {
    const archive = await JSZip.loadAsync(zip);
    for (const entry of Object.values(archive.files)) {
      if (entry.dir) continue;
      const path = normalize(entry.name);
      if (isAbsolute(path) || path.startsWith("..")) {
        throw new Error(`Zip entry ${entry.name} escapes the output directory.`);
      }
      await Bun.write(join(dir, path), await entry.async("uint8array"));
      const mode = Number(entry.unixPermissions ?? 0) & 0o777;
      if (mode) await chmod(join(dir, path), mode | 0o200);
    }
  });
}
