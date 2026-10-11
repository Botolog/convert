import { join } from "path";
import { TOOLCHAIN_SCOPE } from "./common";
import type { Toolchain, ToolchainsConfig } from "./types";

export function toolchainsOf(requirement: Toolchain): string[] {
  return requirement.toolchains ?? [];
}

// the named toolchains plus everything they need, dependencies first
export async function resolveToolchains(names: string[]): Promise<Toolchain[]> {
  if (!names.length) return [];
  const configPath = join(TOOLCHAIN_SCOPE.recipeDir, "toolchains.config.ts");
  const toolchains: ToolchainsConfig = (await import(configPath)).default;
  const byName = new Map(toolchains.map((toolchain) => [toolchain.name, toolchain]));
  const resolved = new Map<string, Toolchain>();
  const visiting = new Set<string>();

  function visit(name: string) {
    if (resolved.has(name)) return;
    const toolchain = byName.get(name);
    if (!toolchain) throw new Error(`Unknown toolchain ${name}.`);
    if (visiting.has(name)) throw new Error(`Toolchain ${name} depends on itself.`);
    visiting.add(name);
    for (const dependency of toolchainsOf(toolchain)) visit(dependency);
    resolved.set(name, toolchain);
  }

  for (const name of names) visit(name);
  return [...resolved.values()];
}
