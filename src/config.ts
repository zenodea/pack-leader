// Defaults for new workers: which harness, and per harness which model and
// thinking level. `pack-leader config set` writes them; explicit flags on
// `worker start` win over them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, ensureDir } from "./paths.ts";

export type KindDefaults = { model?: string | null; thinking?: string | null; [key: string]: unknown };
export type Placement = "tab" | "split";
export type WorktreeMode = "on" | "off" | "leader";
export type HandoffSettings = { enabled: boolean; at_tokens: number };
export type Settings = { placement: Placement; worktree: WorktreeMode; observer: boolean; stall_minutes: number; handoff: HandoffSettings };
export type Config = {
  kind?: string | null;
  kinds: Record<string, KindDefaults>;
  placement?: Placement;
  worktree?: WorktreeMode;
  observer?: boolean;
  stall_minutes?: number;
  handoff?: Partial<HandoffSettings>;
  [key: string]: unknown;
};

export const PLACEMENTS: readonly Placement[] = ["tab", "split"];
export const WORKTREE_MODES: readonly WorktreeMode[] = ["on", "off", "leader"];
export const DEFAULT_SETTINGS: Settings = { placement: "tab", worktree: "leader", observer: true, stall_minutes: 20, handoff: { enabled: false, at_tokens: 200_000 } };

export function settingsOf(config: Config): Settings {
  return {
    placement: config.placement ?? DEFAULT_SETTINGS.placement,
    worktree: config.worktree ?? DEFAULT_SETTINGS.worktree,
    observer: config.observer ?? DEFAULT_SETTINGS.observer,
    stall_minutes: config.stall_minutes ?? DEFAULT_SETTINGS.stall_minutes,
    handoff: {
      enabled: config.handoff?.enabled ?? DEFAULT_SETTINGS.handoff.enabled,
      at_tokens: config.handoff?.at_tokens ?? DEFAULT_SETTINGS.handoff.at_tokens,
    },
  };
}

export function parseTokens(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(text);
  if (!m) throw new Error(`"${text}" is not a token count; use a number such as 200000, 200k or 1m`);
  const scale = { "": 1, k: 1_000, m: 1_000_000 }[m[2]!.toLowerCase() as "" | "k" | "m"];
  const n = Math.round(Number(m[1]) * scale);
  if (n < 1_000) throw new Error(`a handoff below 1k tokens would fire on every check; got ${n}`);
  return n;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}m`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

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

  validateSettings(value);
  return { ...value, kind: value.kind ?? null, kinds } as Config;
}

function validateSettings(value: Record<string, unknown>): void {
  const present = (key: string) => Object.hasOwn(value, key) && value[key] !== undefined;
  if (present("placement") && !PLACEMENTS.includes(value.placement as Placement)) throw invalidConfig(`"placement" must be one of ${PLACEMENTS.join(", ")}`);
  if (present("worktree") && !WORKTREE_MODES.includes(value.worktree as WorktreeMode)) throw invalidConfig(`"worktree" must be one of ${WORKTREE_MODES.join(", ")}`);
  if (present("observer") && typeof value.observer !== "boolean") throw invalidConfig('"observer" must be true or false');
  if (present("stall_minutes") && !isWholeAtLeast(value.stall_minutes, 0)) throw invalidConfig('"stall_minutes" must be a whole number of minutes, 0 for off');
  if (!present("handoff")) return;
  if (!isRecord(value.handoff)) throw invalidConfig('"handoff" must be an object');
  const { enabled, at_tokens } = value.handoff;
  if (enabled !== undefined && typeof enabled !== "boolean") throw invalidConfig('"handoff.enabled" must be true or false');
  if (at_tokens !== undefined && !isWholeAtLeast(at_tokens, 1_000)) throw invalidConfig('"handoff.at_tokens" must be a whole number of tokens, at least 1000');
}

function isWholeAtLeast(value: unknown, min: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min;
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
