import { join, relative, sep } from "path";
import { readdir } from "fs/promises";
import {
  BASE_DOCKERFILE,
  PREBUILD_SCRIPT,
  PREBUILD_VERSION,
  TOOLCHAIN_SCOPE,
  loadRequirements,
  subrecipeScope,
  type Scope,
} from "./common";
import { resolveToolchains, toolchainsOf } from "./toolchains";
import { isSubrecipe, type Requirement } from "./types";

export function hashFile(alg: Bun.SupportedCryptoAlgorithms, bytes: Uint8Array) {
  return new Bun.CryptoHasher(alg).update(bytes).digest("hex");
}

export function updateHash(hash: Bun.CryptoHasher, ...parts: (string | Uint8Array)[]) {
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
}

export async function listFiles(dir: string) {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll(sep, "/"))
      .toSorted();
  } catch {
    return [];
  }
}

export async function hashDir(hash: Bun.CryptoHasher, dir: string) {
  for (const path of await listFiles(dir)) {
    updateHash(hash, path, await Bun.file(join(dir, path)).bytes());
  }
}

export async function hashInputs(requirement: Requirement, scope: Scope): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");

  updateHash(
    hash,
    String(PREBUILD_VERSION),
    await Bun.file(BASE_DOCKERFILE).text(),
    await Bun.file(PREBUILD_SCRIPT).text(),
    JSON.stringify(requirement),
  );
  await hashDir(hash, join(scope.recipeDir, requirement.name));

  for (const toolchain of await resolveToolchains(toolchainsOf(requirement))) {
    updateHash(hash, await hashInputs(toolchain, TOOLCHAIN_SCOPE));
  }

  if (isSubrecipe(requirement)) {
    const sub = subrecipeScope(scope, requirement.name);
    for (const subrequirement of await loadRequirements(sub.recipeDir)) {
      updateHash(hash, await hashInputs(subrequirement, sub));
    }
  }

  return hash.digest("hex");
}
