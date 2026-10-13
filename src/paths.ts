// Where Pack Leader keeps things. herdr hands plugin commands their dirs; panes and
// agents don't get those variables, so the same locations are worked out by hand.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const home = homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
const xdgState = process.env.XDG_STATE_HOME || join(home, ".local", "state");

/** The Pack Leader checkout (or herdr's install of it). */
export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packLeaderBin = join(pluginRoot, "bin", "pack-leader");
export const guideFile = join(pluginRoot, "docs", "guide.md");
export const skillStubFile = join(pluginRoot, "skill", "SKILL.md");

export const herdrHome = join(xdgConfig, "herdr");
export const herdrState = join(xdgState, "herdr");
export const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

/** User settings (none yet). */
export const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || join(herdrHome, "plugins", "config", "pack-leader");
/** Runs, tasks, workers, messages: the state that outlives any agent's context. */
export const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || join(herdrState, "plugins", "pack-leader");
export const stateFile = join(stateDir, "state.json");
export const lockDir = join(stateDir, "state.lock");
export const logFile = join(stateDir, "events.jsonl");

/** Where the Claude Code skill stub goes. */
export const claudeSkillDir = join(home, ".claude", "skills", "pack-leader");
export const localBin = join(home, ".local", "bin");

export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  if (env.HERDR_SESSION) return join(herdrHome, "sessions", env.HERDR_SESSION, "herdr.sock");
  return join(herdrHome, "herdr.sock");
}

export function ensureDir(dir: string, mode = 0o700): string {
  mkdirSync(dir, { recursive: true, mode });
  return dir;
}
