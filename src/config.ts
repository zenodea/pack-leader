// Defaults for new workers: which harness, and per harness which model and
// thinking level. `pack-leader config set` writes them; explicit flags on
// `worker start` win over them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, ensureDir } from "./paths.ts";

export type KindDefaults = { model?: string | null; thinking?: string | null; [key: string]: unknown };
export type Config = { kind?: string | null; kinds: Record<string, KindDefaults>; [key: string]: unknown };

export const configFile = join(configDir, "config.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidConfig(reason: string): Error {
  return new Error(`Invalid configuration at ${configFile}: ${reason}. Fix or move the file, then retry.`);
}

function validateConfig(value: unknown): Config {
  if (!isRecord(value)) throw invalidConfig("the top-level value must be a JSON object");
  if (Object.hasOwn(value, "kind") && value.kind !== null && typeof value.kind !== "string") {
    throw invalidConfig('"kind" must be a string or null');
  }

  const rawKinds = value.kinds;
  if (rawKinds !== undefined && rawKinds !== null && !isRecord(rawKinds)) {
    throw invalidConfig('"kinds" must be an object or null');
  }

  const kinds: Record<string, KindDefaults> = {};
  if (isRecord(rawKinds)) {
    for (const [kind, rawDefaults] of Object.entries(rawKinds)) {
      if (!isRecord(rawDefaults)) throw invalidConfig(`"kinds.${kind}" must be an object`);
      for (const field of ["model", "thinking"] as const) {
        if (Object.hasOwn(rawDefaults, field) && rawDefaults[field] !== null && typeof rawDefaults[field] !== "string") {
          throw invalidConfig(`"kinds.${kind}.${field}" must be a string or null`);
        }
      }
      // Define rather than assign so a valid JSON key such as "__proto__" is data,
      // not a special setter on Object.prototype.
      Object.defineProperty(kinds, kind, { value: rawDefaults, enumerable: true, writable: true, configurable: true });
    }
  }

  return { ...value, kind: value.kind ?? null, kinds } as Config;
}

export function loadConfig(): Config {
  let text: string;
  try {
    text = readFileSync(configFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kinds: {} };
    const detail = (err as Error).message;
    throw new Error(`Cannot read configuration at ${configFile}: ${detail}. Check that the file is readable, or move it aside and retry.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw invalidConfig(`invalid JSON (${(err as Error).message})`);
  }
  return validateConfig(value);
}

export function saveConfig(config: Config): Config {
  ensureDir(configDir);
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  return config;
}

export function defaultsFor(config: Config, kind: string): KindDefaults {
  return Object.hasOwn(config.kinds, kind) ? config.kinds[kind]! : {};
}
