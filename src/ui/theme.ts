import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { herdrHome } from "../core/paths.ts";

export type Theme = { accent: string | null };

export const noTheme: Theme = { accent: null };

const HEX = /^#?([0-9a-f]{6})$/i;

export function hexColor(v: string | undefined): string | null {
  const m = v ? HEX.exec(v.trim()) : null;
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

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

export function loadTheme(file = herdrConfigFile, env: NodeJS.ProcessEnv = process.env): Theme {
  let t: Theme = noTheme;
  try {
    if (existsSync(file)) t = parseTheme(readFileSync(file, "utf8"));
  } catch {}
  return { accent: hexColor(env.PACK_ACCENT) ?? t.accent };
}
