// The colour the sidebar borrows from herdr: its accent, for the selected box. herdr
// does not hand plugins its theme, so it comes from config.toml; without one the
// sidebar uses the terminal's plain cyan.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { herdrHome } from "./paths.ts";

export type Theme = { accent: string | null };

export const noTheme: Theme = { accent: null };

const HEX = /^#?([0-9a-f]{6})$/i;

/** `#rrggbb` normalised, or null for anything else (herdr also accepts names like "reset"). */
export function hexColor(v: string | undefined): string | null {
  const m = v ? HEX.exec(v.trim()) : null;
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

/**
 * The accent colour out of herdr's config.toml: `[ui] accent` wins over
 * `[theme.custom] accent`. Just enough TOML
 * for `key = "value"` lines under `[section]` headers; anything else is skipped.
 */
export function parseTheme(toml: string): Theme {
  const vals: Record<string, string> = {};
  let section = "";
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1]!.trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (kv) vals[`${section}.${kv[1]}`] = kv[2]!;
  }
  return { accent: hexColor(vals["ui.accent"]) ?? hexColor(vals["theme.custom.accent"]) };
}

export const herdrConfigFile = join(herdrHome, "config.toml");

/** herdr's accent, or none when the config is missing or unreadable. `PACK_ACCENT` overrides. */
export function loadTheme(file = herdrConfigFile, env: NodeJS.ProcessEnv = process.env): Theme {
  let t: Theme = noTheme;
  try {
    if (existsSync(file)) t = parseTheme(readFileSync(file, "utf8"));
  } catch {}
  return { accent: hexColor(env.PACK_ACCENT) ?? t.accent };
}
