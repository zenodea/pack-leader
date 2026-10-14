// Where Pack Leader keeps things. herdr hands plugin commands their dirs; panes and
// agents don't get those variables, so the same locations are worked out by hand.
import { existsSync, mkdirSync } from "node:fs";
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
/** Where the state lives when herdr does not say: `$XDG_STATE_HOME/herdr/plugins/pack-leader`. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env, h = home): string {
  return join(env.XDG_STATE_HOME || join(h, ".local", "state"), "herdr", "plugins", "pack-leader");
}

/**
 * `HERDR_PLUGIN_STATE_DIR` always wins over the XDG default: herdr hands it to plugin
 * commands, and tests use it to isolate. Panes and agents do not get it, so a herdr
 * that points it somewhere else splits the state in two; see `stateDirDivergence`.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env, h = home): string {
  return env.HERDR_PLUGIN_STATE_DIR || defaultStateDir(env, h);
}

/**
 * Set when `HERDR_PLUGIN_STATE_DIR` names a different dir than the XDG default and the
 * default holds a state.json too: commands run without the variable (from panes) then
 * read and write the other file. `update()` logs it once per process as `state.dir_divergent`.
 */
export function stateDirDivergence(env: NodeJS.ProcessEnv = process.env, h = home): { env_dir: string; default_dir: string } | null {
  const envDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!envDir) return null;
  const def = defaultStateDir(env, h);
  if (resolve(envDir) === resolve(def) || !existsSync(join(def, "state.json"))) return null;
  return { env_dir: resolve(envDir), default_dir: def };
}

/** Runs, tasks, workers, messages: the state that outlives any agent's context. */
export const stateDir = resolveStateDir();
export const stateFile = join(stateDir, "state.json");
export const lockDir = join(stateDir, "state.lock");
export const logFile = join(stateDir, "events.jsonl");

/** Where the skill stub goes: every harness that has a skills directory. */
export const skillDirs: Record<string, string> = {
  claude: join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills", "pack-leader"),
  codex: join(process.env.CODEX_HOME || join(home, ".codex"), "skills", "pack-leader"),
  pi: join(process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "skills", "pack-leader"),
};
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
