// The state that outlives any agent's context: runs, tasks, workers and
// messages, in one JSON file written atomically under a directory lock. Every
// pack-leader command is a short-lived process, so the file is the only shared memory.
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, lockDir, logFile, stateDir, stateFile } from "./paths.ts";
import type { AgentStatus } from "./herdr.ts";

export type TaskStatus = "pending" | "dispatched" | "succeeded" | "failed" | "blocked";
export type MessageType = "done" | "ask" | "reply" | "heartbeat" | "note" | "followup" | "attention";

export type Run = {
  id: string;
  objective: string;
  status: "active" | "closed";
  created_at: string;
  closed_at?: string;
  /** The agent you talk to. */
  orchestrator: { pane_id: string | null; workspace_id: string | null; tab_id: string | null; cwd: string };
  /** The sidebar pane pack-leader opened for this run, if any. */
  sidebar_pane_id?: string | null;
  /** Set while sync() cannot reach herdr: worker liveness verdicts are stale until it clears. */
  herdr_unreachable_since?: string | null;
};

export type Task = {
  id: string;
  run_id: string;
  title: string;
  spec: string;
  status: TaskStatus;
  depends_on: string[];
  /** The worker owning the current attempt. */
  worker: string | null;
  dispatch_id: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  outcome: { summary: string; files_modified: string[]; report_path: string | null } | null;
};

export type Worker = {
  name: string;
  run_id: string;
  kind: string;
  pane_id: string;
  cwd: string;
  task_id: string | null;
  dispatch_id: string | null;
  started_at: string;
  /** What herdr last told us, so transitions can be noticed between commands. */
  last_status: AgentStatus | "exited";
  last_seq: number;
  last_seen: string;
  /** Pack Leader split this pane; releasing the worker may close it. */
  owns_pane: boolean;
  /** Pack Leader created a whole tab for the worker (hidden placement); release closes the tab. */
  tab_id?: string | null;
  owns_tab?: boolean;
  /** Seen working since the current dispatch: only then does a later idle mean "finished without reporting". */
  worked?: boolean;
  /** herdr's state_change_seq when the dispatch was prompted. */
  seq_at_dispatch?: number;
  retained: boolean;
  /** sync()'s verdict: agent seen in its pane, pane alive but no agent past the grace, or pane gone twice running. */
  liveness?: Liveness;
  liveness_reason?: string;
  /** The first sync that did not find the pane; a second one in a row makes it exited. */
  missing_since?: string | null;
  /** The first sync that found the pane without an agent. */
  agent_missing_since?: string | null;
  /** The dispatch an `unverifiable` attention was raised for (once per dispatch). */
  unverifiable_dispatch?: string | null;
  /** When a `stalled` attention was raised; cleared by any sign of life (heartbeat, ask, done, herdr state change). */
  stalled_since?: string | null;
};

/** What an attention message is about: herdr's agent state, or Pack Leader's own liveness findings. */
export type AttentionStatus = AgentStatus | "exited" | "unverifiable" | "stalled";

export type Liveness = "live" | "unverifiable" | "exited";

export type Message = {
  id: string;
  run_id: string;
  ts: string;
  type: MessageType;
  from: string;
  /** A worker name for followups and replies, "orchestrator" otherwise. */
  to: string;
  task_id: string | null;
  dispatch_id: string | null;
  body: string;
  outcome?: "succeeded" | "failed";
  files_modified?: string[];
  report_path?: string | null;
  status?: AttentionStatus;
  /** For a reply: the ask it answers. */
  reply_to?: string;
  /** For an ask: the answers the worker offers (`pack-leader ask --options a,b,c`). */
  options?: string[];
  /** For a reply to an ask with options: the chosen option (or the free text with `--free`). */
  answer?: string;
  /** For a reply to an ask with options: the chosen option's index, null for a `--free` answer. */
  option_index?: number | null;
  /** Acknowledged by the orchestrator (or read by the worker, for followups). */
  acked: boolean;
  /** A followup queued because the worker was busy; delivered by prompt later. */
  delivered?: boolean;
};

/**
 * One hand-over of a task to a worker: the exact text it was prompted with, and
 * how it ended. Created where the dispatch id is minted, settled by `done` (or as
 * failed by a forced release or a worker that exited owing a report).
 */
export type Dispatch = {
  id: string;
  run_id: string;
  task_id: string;
  worker: string;
  /** The task's attempt number this dispatch is. */
  attempt: number;
  /** The prompt text the worker received. */
  preamble: string;
  cwd: string;
  started_at: string;
  settled_at?: string;
  outcome?: "succeeded" | "failed";
  /** The failed dispatch this one retries. */
  retry_of?: string;
  /** The worker's screen, saved when it was released. */
  archive_path?: string;
  archive_error?: string;
};

export type State = {
  version: 1;
  runs: Record<string, Run>;
  tasks: Record<string, Task>;
  workers: Record<string, Worker>;
  messages: Message[];
  /** Optional: files written before dispatch records existed have none. */
  dispatches?: Record<string, Dispatch>;
  seq: number;
};

export const emptyState = (): State => ({ version: 1, runs: {}, tasks: {}, workers: {}, messages: [], dispatches: {}, seq: 0 });

export const now = () => new Date().toISOString();

/**
 * A missing file is an empty state. A file that exists but cannot be parsed,
 * or has a version this build does not understand, is moved aside to
 * `<file>.corrupt-<ISO timestamp>` and logged as a `state.corrupt` event, so
 * the next writer starts from an empty state instead of overwriting the only
 * copy of whatever was there.
 */
export function load(file = stateFile, logTo = logFile): State {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyState();
    throw err;
  }
  let reason: string;
  try {
    const s = JSON.parse(raw) as State;
    if (s && typeof s === "object" && s.version === 1) return { ...emptyState(), ...s };
    reason = `unsupported state version ${JSON.stringify(s?.version)}`;
  } catch (err: any) {
    reason = `parse error: ${err?.message ?? String(err)}`;
  }
  const base = `${file}.corrupt-${now().replace(/[:.]/g, "-")}`;
  let renamed_to = base;
  for (let n = 1; existsSync(renamed_to); n++) renamed_to = `${base}-${n}`;
  try {
    renameSync(file, renamed_to);
  } catch (err: any) {
    throw new Error(`state file ${file} is corrupt (${reason}) and could not be moved aside: ${err?.message ?? err}`);
  }
  log({ event: "state.corrupt", file, renamed_to, reason }, logTo);
  return emptyState();
}

export function save(state: State, file = stateFile): void {
  ensureDir(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;

async function acquire(dir = lockDir): Promise<void> {
  ensureDir(stateDir);
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      return;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(dir);
          continue;
        }
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error("pack-leader state is locked by another command; try again");
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
}

function release(dir = lockDir): void {
  try {
    rmdirSync(dir);
  } catch {}
}

/** Read-modify-write under the lock. `fn` returns the value for the caller. */
export async function update<T>(fn: (state: State) => T | Promise<T>, file = stateFile): Promise<T> {
  await acquire();
  try {
    const state = load(file);
    const out = await fn(state);
    save(state, file);
    return out;
  } finally {
    release();
  }
}

export function nextId(state: State, prefix: string): string {
  state.seq += 1;
  return `${prefix}${state.seq.toString(36)}`;
}

/** An append-only trail of what happened, for the sidebar's log and for debugging. */
export function log(entry: Record<string, unknown>, file = logFile): void {
  try {
    ensureDir(dirname(file));
    if (existsSync(file) && statSync(file).size > 2_000_000) writeFileSync(file, "");
    appendFileSync(file, JSON.stringify({ t: now(), ...entry }) + "\n", { mode: 0o600 });
  } catch {}
}

// ---- queries -----------------------------------------------------------------

export const activeRuns = (state: State): Run[] => Object.values(state.runs).filter((r) => r.status === "active");
export const runTasks = (state: State, runId: string): Task[] => Object.values(state.tasks).filter((t) => t.run_id === runId);
export const runWorkers = (state: State, runId: string): Worker[] => Object.values(state.workers).filter((w) => w.run_id === runId);
export const runMessages = (state: State, runId: string): Message[] => state.messages.filter((m) => m.run_id === runId);
/** Dispatches of a run, oldest first (ids are minted from one counter). */
export const runDispatches = (state: State, runId: string): Dispatch[] =>
  Object.values(state.dispatches ?? {}).filter((d) => d.run_id === runId).sort((a, b) => idSeq(a.id) - idSeq(b.id));
/** The counter value an id was minted from. */
export const idSeq = (id: string): number => parseInt(id.slice(1), 36) || 0;

/**
 * Which run a command means. In order: --run, PACK_RUN_ID, the run this pane
 * orchestrates, the run this pane works for, the only active run in this
 * workspace, the only active run at all. Only an explicit id can name a closed
 * run, and only for read-only commands, which pass `allowClosed`.
 */
export function resolveRun(
  state: State,
  opts: { runId?: string; paneId?: string | null; workspaceId?: string | null; allowClosed?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Run {
  const id = opts.runId || env.PACK_RUN_ID;
  if (id) {
    const r = state.runs[id];
    if (!r) throw new Error(`no run ${id}`);
    if (r.status === "closed" && !opts.allowClosed) throw new Error(`run ${id} is closed`);
    return r;
  }
  const active = activeRuns(state);
  if (opts.paneId) {
    const mine = active.find((r) => r.orchestrator.pane_id === opts.paneId);
    if (mine) return mine;
    const w = Object.values(state.workers).find((w) => w.pane_id === opts.paneId && state.runs[w.run_id]?.status === "active");
    if (w) return state.runs[w.run_id]!;
  }
  const inWs = opts.workspaceId ? active.filter((r) => r.orchestrator.workspace_id === opts.workspaceId) : [];
  if (inWs.length === 1) return inWs[0]!;
  if (active.length === 1) return active[0]!;
  if (!active.length) throw new Error("no active run: create one with `pack-leader run create --objective \"...\"`");
  throw new Error(`several active runs (${active.map((r) => r.id).join(", ")}); pass --run <id>`);
}

/** A task is ready when every dependency succeeded. */
export function ready(state: State, task: Task): boolean {
  return task.status === "pending" && task.depends_on.every((d) => state.tasks[d]?.status === "succeeded");
}

export function unacked(state: State, runId: string): Message[] {
  return state.messages.filter((m) => m.run_id === runId && m.to === "orchestrator" && !m.acked);
}

export const WORKER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
