// Defaults for new workers: which harness, and per harness which model and
// thinking level. `pack-leader config set` writes them; explicit flags on
// `worker start` win over them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, ensureDir } from "./paths.ts";

export type KindDefaults = { model?: string | null; thinking?: string | null };
export type Config = { kind?: string | null; kinds: Record<string, KindDefaults> };

export const configFile = join(configDir, "config.json");

export function loadConfig(): Config {
  try {
    if (!existsSync(configFile)) return { kinds: {} };
    const data = JSON.parse(readFileSync(configFile, "utf8")) as Partial<Config>;
    return { kind: data.kind ?? null, kinds: data.kinds ?? {} };
  } catch {
    return { kinds: {} };
  }
}

export function saveConfig(config: Config): Config {
  ensureDir(configDir);
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  return config;
}

export function defaultsFor(config: Config, kind: string): KindDefaults {
  return config.kinds[kind] ?? {};
}
