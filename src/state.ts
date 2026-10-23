// The state that outlives any agent's context: runs, tasks, workers and
// messages, in one JSON file written atomically under a directory lock. Every
// pack-leader command is a short-lived process, so the file is the only shared memory.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensureDir, lockDir, logFile, stateDirDivergence, stateFile } from "./paths.ts";
import type { AgentStatus } from "./herdr.ts";
import type { WorktreeInfo, WorktreeRecord } from "./worktree.ts";
import type { SetupMetadata } from "./setup.ts";
import type { Runtime, RoutingProvenance } from "./routing.ts";
import type { HostProfile } from "./hosts.ts";
import type { RequestRecord } from "./requests.ts";

export const TASK_STATUSES = ["pending", "dispatched", "succeeded", "failed", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type MessageType = "done" | "ask" | "reply" | "heartbeat" | "note" | "escalation" | "followup" | "attention" | "user";

export type Run = {
  id: string;
  objective: string;
  status: "active" | "closed";
  created_at: string;
  closed_at?: string;
  /** The agent you talk to. */
  orchestrator: { pane_id: string | null; workspace_id: string | null; tab_id: string | null; tab_label?: string | null; cwd: string };
  /** The sidebar pane pack-leader opened for this run, if any. */
  sidebar_pane_id?: string | null;
  /** The observer agent under the orchestrator, if one is open (`run create`, `pack-leader observer`). */
  observer?: { pane_id: string; agent: string } | null;
  /** Set while sync() cannot reach herdr: worker liveness verdicts are stale until it clears. */
  herdr_unreachable_since?: string | null;
  handoff?: RunHandoff | null;
  /** A sub-run: the worker (and its dispatch) that coordinates it from its own pane. Top-level runs have none. */
  parent?: { run_id: string; worker: string; task_id: string | null; dispatch_id: string | null } | null;
  /** 0 for a top-level run, one more for each sub-run level. */
  depth?: number;
};

/** How deep sub-runs may nest (`PACK_MAX_RUN_DEPTH`, default 1: a worker may coordinate one sub-run level; 0 forbids). */
export function maxRunDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PACK_MAX_RUN_DEPTH;
  return raw !== undefined && Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 1;
}

/** Active sub-runs coordinated by `worker` of run `runId`. */
export function childRuns(state: State, runId: string, worker: string): Run[] {
  return activeRuns(state).filter((r) => r.parent?.run_id === runId && r.parent.worker === worker);
}

export type RunHandoff = {
  status: "requested" | "pending" | "resumed" | "failed";
  requested_at: string;
  tokens: number;
  asked: number;
  note?: string;
  saved_at?: string;
  resumed_at?: string;
  error?: string;
};

export type GateStatus = "pending" | "approved" | "rejected";
export type GateDecision = "approve" | "reject";

/** A coordinator-owned approval gate; decisions are durable and immutable. */
export type TaskGate = {
  id: string;
  run_id: string;
  task_id: string;
  reason: string;
  created_by: "coordinator";
  created_at: string;
  status: GateStatus;
  decision?: GateDecision;
  resolved_at?: string;
  resolution_reason?: string;
  /** A decision gate: the choices it asks between. Approving it records one of them as `choice`. */
  options?: string[];
  choice?: string;
};

export type Task = {
  id: string;
  run_id: string;
  title: string;
  spec: string;
  status: TaskStatus;
  depends_on: string[];
  /** Optional containment/provenance link; unrelated to execution dependencies. */
  parent_id?: string | null;
  /** The worker owning the current attempt. */
  worker: string | null;
  dispatch_id: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  outcome: { summary: string; files_modified: string[]; report_path: string | null } | null;
  /** Set when the coordinator returns the task to pending: failed attempts before it no longer count toward the retry limit. */
  retry_reset_at?: string;
};

export type Worker = {
  /** The phase from the worker's last heartbeat, if it gave one. */
  phase?: string;
  name: string;
  run_id: string;
  kind: string;
  model?: string | null;
  thinking?: string | null;
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
  /** This existing herdr session was adopted; supervision does not imply pane/tab ownership. */
  adopted?: boolean;
  /** Worker command context is supplied explicitly in preambles for adopted sessions. */
  context_mode?: "environment" | "explicit";
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
  /** When a `stalled` attention was raised; cleared by any sign of life (heartbeat, ask, note, send, done, herdr state change). */
  stalled_since?: string | null;
  /** Immutable SSH profile used for every operation on a remote worker. Absent on local workers and old v1 records. */
  execution_host?: HostProfile | null;
  /** First failed remote poll; remote unavailability is not evidence the pane exited. */
  host_unreachable_since?: string | null;
  /** The git worktree the worker runs in (`worker start --worktree`). */
  worktree?: WorktreeInfo | null;
  /** The initial dispatch that acquired the worktree lease; redispatches keep this lease. */
  worktree_dispatch_id?: string | null;
  /** Its current dispatch has not been prompted yet (start or redispatch in progress, or the prompt failed): followups queue until it has. */
  awaiting_prompt?: boolean;
  /** The "back to leader" bar pane above its pane, when one was opened; released with the worker. */
  bar_pane_id?: string | null;
};

/** What an attention message is about: herdr's agent state, or Pack Leader's own liveness findings. */
export type AttentionStatus = AgentStatus | "exited" | "unverifiable" | "stalled";

export type Liveness = "live" | "unverifiable" | "exited" | "unreachable";

export type DeliveryClaim = {
  /** Unique attempt token: late completion/failure may only settle its own claim. */
  token: string;
  pid: number;
  host: string;
  claimed_at: string;
  lease_until: string;
  /** Remote receipt snapshot written before prompting, so an expired claim can reconcile before retry. */
  target?: string;
  worker_started_at?: string;
  execution_host?: HostProfile | null;
  seq_before?: number;
};

/** Durable evidence that a remote followup may have landed but could not be reconciled. */
export type DeliveryUnknown = {
  target: string;
  worker_started_at: string;
  execution_host: HostProfile;
  seq_before?: number;
  observed_at: string;
  reason: string;
};

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
  /** For a heartbeat: the worker's phase (investigating, implementing, reviewing, waiting, ...). */
  phase?: string;
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
  /** Durable in-progress prompt attempt; unlike delivered/acked, this is recoverable. */
  delivery_claim?: DeliveryClaim;
  /** A remote prompt may have landed; reconcile this evidence before any later automatic retry. */
  delivery_unknown?: DeliveryUnknown;
  /** When sync re-nudged the orchestrator about it (once). */
  nudged_at?: string;
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
  /** Resolved runtime and safe routing decision for this attempt; absent in legacy files. */
  runtime?: Runtime;
  routing?: RoutingProvenance;
  /** Canonical --worktree checkout reserved during initial start admission; absent on older records and ordinary --cwd starts. */
  worktree_path?: string;
  /** Renewable lease for a worker start that has not registered its pane yet; started_at remains immutable history. */
  claim_until?: string;
  /** Explicit --setup-command execution metadata; absent on old starts and starts without a hook. */
  setup?: SetupMetadata;
  /** Existing pane reserved by an adoption admission; absent on older/ordinary records. */
  pane_id?: string;
  /** Immutable SSH profile used by this dispatch; absent for local and old v1 records. */
  execution_host?: HostProfile;
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
  /** Optional, like `dispatches`. Every worktree a worker was started in, by path; outlives the worker so release can say where the work is. */
  worktrees?: Record<string, WorktreeRecord>;
  /** Optional in v1 state files written before durable approval gates existed. */
  gates?: Record<string, TaskGate>;
  /** `--retry-request` identities and their recorded results; optional, dropped after a week. */
  requests?: Record<string, RequestRecord>;
};

export const emptyState = (): State => ({ version: 1, runs: {}, tasks: {}, workers: {}, messages: [], dispatches: {}, worktrees: {}, gates: {}, seq: 0 });

export const now = () => new Date().toISOString();

/**
 * Read and parse the current state without changing the file. Corrupt content
 * is reported to a writer so it can quarantine that exact current file while
 * holding the state lock; ordinary readers must never rename a pathname based
 * on bytes they read before a writer replaced it.
 */
type StateRead = { state: State; corruption?: string };

function readState(file: string): StateRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { state: emptyState() };
    throw err;
  }
  try {
    const s = JSON.parse(raw) as State;
    if (s && typeof s === "object" && s.version === 1) return { state: { ...emptyState(), ...s } };
    return { state: emptyState(), corruption: `unsupported state version ${JSON.stringify(s?.version)}` };
  } catch (err: any) {
    return { state: emptyState(), corruption: `parse error: ${err?.message ?? String(err)}` };
  }
}

/** Read without mutation; missing files are empty, while corruption is visible to callers with path diagnostics. */
export function load(file = stateFile, _logTo = logFile): State {
  const result = readState(file);
  if (result.corruption) throw new Error(`state file ${file} is corrupt: ${result.corruption}`);
  return result.state;
}

/** Quarantine corruption only after the caller has reread it while holding the writer lock. */
function quarantine(file: string, reason: string, logTo: string): void {
  const base = `${file}.corrupt-${now().replace(/[:.]/g, "-")}`;
  let renamed_to = base;
  for (let n = 1; existsSync(renamed_to); n++) renamed_to = `${base}-${n}`;
  try {
    renameSync(file, renamed_to);
  } catch (err: any) {
    throw new Error(`state file ${file} is corrupt (${reason}) and could not be moved aside: ${err?.message ?? err}`);
  }
  log({ event: "state.corrupt", file, renamed_to, reason }, logTo);
}

/** Must be called only with `lockFor(file)` held; this is the recovery read used by writers. */
function loadForUpdate(file: string, logTo: string): State {
  const result = readState(file);
  if (!result.corruption) return result.state;
  quarantine(file, result.corruption, logTo);
  return emptyState();
}

/** A tmp file older than this belongs to a writer that died between write and rename. */
const TMP_ORPHAN_MS = 60_000;

/**
 * Write `<file>.<pid>.tmp`, fsync it, rename it over `file`, fsync the directory:
 * a crash leaves either the old file or the new one, never an empty one. Tmp files
 * a dead writer left behind (older than a minute) are swept on the way.
 */
export function save(state: State, file = stateFile): void {
  const dir = ensureDir(dirname(file));
  sweepTmp(file);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(state, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {} // some filesystems refuse fsync on a directory; the rename itself is done
}

function sweepTmp(file: string): void {
  const prefix = `${basename(file)}.`;
  try {
    for (const name of readdirSync(dirname(file))) {
      if (!name.startsWith(prefix) || !/^\d+\.tmp$/.test(name.slice(prefix.length))) continue;
      const p = join(dirname(file), name);
      try {
        if (Date.now() - statSync(p).mtimeMs > TMP_ORPHAN_MS) rmSync(p, { force: true });
      } catch {}
    }
  } catch {}
}

const LOCK_TIMEOUT_MS = 5000;
/** A lock without a readable owner (an older build, or a holder that died before writing it) is stale after this. */
const LOCK_STALE_MS = 30_000;
/** A lock whose owner pid is still alive is only taken over after this, in case the pid was reused. */
const LOCK_ABANDONED_MS = 10 * 60_000;

/** The lock dir that guards `file`: `state.lock` next to `state.json`. */
export const lockFor = (file: string): string => `${file.replace(/\.json$/, "")}.lock`;

type LockOwner = { pid: number; host: string };

function lockOwner(dir: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(dir, "owner"), "utf8"));
    return typeof o?.pid === "number" && typeof o?.host === "string" ? o : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Whether a held lock can be taken over: its owner (pid on this host) is dead, or it
 * has no owner and is older than LOCK_STALE_MS, or it is older than LOCK_ABANDONED_MS
 * whatever its owner says. A live holder on this host is never swept before that,
 * however long it holds the lock.
 */
export function lockIsStale(dir: string, at = Date.now()): boolean {
  let age: number;
  try {
    age = at - statSync(dir).mtimeMs;
  } catch {
    return false; // gone: the next mkdir will tell
  }
  if (age > LOCK_ABANDONED_MS) return true;
  const owner = lockOwner(dir);
  if (owner && owner.host === hostname()) return !alive(owner.pid);
  return age > LOCK_STALE_MS;
}

/**
 * Take the lock: mkdir is the atomic step, then the owner (pid, host) is written
 * inside so others can tell a dead holder from a slow one. A stale lock is renamed
 * aside before it is removed, so two sweepers cannot both remove one dir and then
 * delete a lock a third process just took.
 */
export async function acquire(dir = lockDir, timeoutMs = LOCK_TIMEOUT_MS): Promise<void> {
  ensureDir(dirname(dir));
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      try {
        writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid, host: hostname() } satisfies LockOwner), { mode: 0o600 });
      } catch {}
      return;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      if (lockIsStale(dir)) {
        const aside = `${dir}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
        try {
          renameSync(dir, aside);
          // Another sweeper may have beaten us and a new holder taken the lock in between: give a live lock back.
          if (!lockIsStale(aside)) renameSync(aside, dir);
          else {
            rmSync(aside, { recursive: true, force: true });
            log({ event: "state.lock_swept", lock: dir }, join(dirname(dir), "events.jsonl"));
          }
        } catch {}
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error("pack-leader state is locked by another command; try again");
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
}

/** Drop the lock, but only one this process holds (a sweeper may have taken it over). */
export function release(dir = lockDir): void {
  const owner = lockOwner(dir);
  if (owner && (owner.pid !== process.pid || owner.host !== hostname())) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

let divergenceLogged = false;

/**
 * Read-modify-write under the lock. `fn` returns the value for the caller and must
 * be synchronous: the lock is held only for load, `fn` and save, so nothing slow
 * (a herdr call, a wait) ever runs under it. Do async work before or after, and
 * call update() again if it has to write. A callback that returns a promise
 * throws, and nothing is saved.
 */
export async function update<T>(fn: (state: State) => Sync<T>, file = stateFile): Promise<T> {
  if (file === stateFile && !divergenceLogged) {
    divergenceLogged = true;
    const d = stateDirDivergence();
    if (d) log({ event: "state.dir_divergent", ...d, using: d.env_dir });
  }
  const lock = lockFor(file);
  await acquire(lock);
  try {
    const state = loadForUpdate(file, join(dirname(file), "events.jsonl"));
    const out = fn(state) as T;
    if (out && typeof (out as any).then === "function") throw new Error("update() callback must be synchronous");
    save(state, file);
    return out;
  } finally {
    release(lock);
  }
}

/** Refuses a promise-returning callback at compile time. */
type Sync<T> = T extends PromiseLike<unknown> ? never : T;

export function nextId(state: State, prefix: string): string {
  state.seq += 1;
  return `${prefix}${state.seq.toString(36)}`;
}

/** An append-only trail of what happened, for the sidebar's log and for debugging. */
/** Past this size events.jsonl is rotated to events.jsonl.1 (replacing the previous one). */
export const LOG_MAX_BYTES = 2_000_000;

export function log(entry: Record<string, unknown>, file = logFile, maxBytes = LOG_MAX_BYTES): void {
  try {
    ensureDir(dirname(file));
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
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
 * orchestrates, the run this pane works for, the run whose sidebar this pane is,
 * the only active run in this workspace, the only active run at all. Only an explicit id can name a closed
 * run, and only for read-only commands, which pass `allowClosed`.
 */
export function resolveRun(
  state: State,
  opts: { runId?: string; paneId?: string | null; workspaceId?: string | null; allowClosed?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Run {
  // A worker coordinating a sub-run from its pane means that run, not the one in its environment
  // (which still names the parent run, for its own done/ask/note).
  if (!opts.runId && opts.paneId && (env.PACK_ROLE === "worker" || env.PACK_WORKER)) {
    const child = activeRuns(state).find((r) => r.parent && r.orchestrator.pane_id === opts.paneId);
    if (child) return child;
  }
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
    const w = Object.values(state.workers).find((w) => !w.execution_host && w.pane_id === opts.paneId && state.runs[w.run_id]?.status === "active");
    if (w) return state.runs[w.run_id]!;
    const shown = active.find((r) => r.sidebar_pane_id === opts.paneId || r.observer?.pane_id === opts.paneId);
    if (shown) return shown;
  }
  const inWs = opts.workspaceId ? active.filter((r) => r.orchestrator.workspace_id === opts.workspaceId) : [];
  if (inWs.length === 1) return inWs[0]!;
  if (active.length === 1) return active[0]!;
  if (!active.length) throw new Error("no active run: create one with `pack-leader run create --objective \"...\"`");
  throw new Error(`several active runs (${active.map((r) => r.id).join(", ")}); pass --run <id>`);
}

/** Gates that still block a task's admission. */
export function taskGateBlockers(state: State, taskId: string): TaskGate[] {
  return Object.values(state.gates ?? {}).filter((gate) => gate.task_id === taskId && gate.status !== "approved");
}

/** A task is ready when dependencies succeeded and every approval gate was approved. */
export function ready(state: State, task: Task): boolean {
  return task.status === "pending" && task.depends_on.every((d) => state.tasks[d]?.status === "succeeded") && taskGateBlockers(state, task.id).length === 0;
}

/** Start claims are admitted before workers are registered; after this lease they are stale. */
export const START_CLAIM_MS = 5 * 60_000;

export function unacked(state: State, runId: string): Message[] {
  return state.messages.filter((m) => m.run_id === runId && m.to === "orchestrator" && !m.acked);
}

export const WORKER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
