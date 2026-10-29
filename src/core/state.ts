import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensureDir, lockDir, logFile, stateDir, stateDirDivergence, stateFile } from "./paths.ts";
import type { AgentStatus } from "../mux/index.ts";
import type { WorktreeInfo, WorktreeRecord } from "../agents/worktree.ts";
import type { SetupMetadata } from "../agents/setup.ts";
import type { Runtime, RoutingProvenance } from "./routing.ts";
import type { HostProfile } from "../herdr/hosts.ts";
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
  orchestrator: { pane_id: string | null; workspace_id: string | null; tab_id: string | null; tab_label?: string | null; cwd: string };
  sidebar_pane_id?: string | null;
  observer?: { pane_id: string; agent: string } | null;
  herdr_unreachable_since?: string | null;
  handoff?: RunHandoff | null;
  parent?: { run_id: string; worker: string; task_id: string | null; dispatch_id: string | null } | null;
  depth?: number;
};

export function maxRunDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PACK_MAX_RUN_DEPTH;
  return raw !== undefined && Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : 1;
}

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
  parent_id?: string | null;
  worker: string | null;
  dispatch_id: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  outcome: { summary: string; files_modified: string[]; report_path: string | null } | null;
  retry_reset_at?: string;
};

export type Worker = {
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
  last_status: AgentStatus | "exited";
  last_seq: number;
  last_seen: string;
  owns_pane: boolean;
  adopted?: boolean;
  context_mode?: "environment" | "explicit";
  tab_id?: string | null;
  owns_tab?: boolean;
  worked?: boolean;
  seq_at_dispatch?: number;
  retained: boolean;
  liveness?: Liveness;
  liveness_reason?: string;
  missing_since?: string | null;
  agent_missing_since?: string | null;
  unverifiable_dispatch?: string | null;
  stalled_since?: string | null;
  execution_host?: HostProfile | null;
  host_unreachable_since?: string | null;
  worktree?: WorktreeInfo | null;
  worktree_dispatch_id?: string | null;
  awaiting_prompt?: boolean;
  bar_pane_id?: string | null;
};

export type AttentionStatus = AgentStatus | "exited" | "unverifiable" | "stalled";

export type Liveness = "live" | "unverifiable" | "exited" | "unreachable";

export type DeliveryClaim = {
  token: string;
  pid: number;
  host: string;
  claimed_at: string;
  lease_until: string;
  target?: string;
  worker_started_at?: string;
  execution_host?: HostProfile | null;
  seq_before?: number;
};

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
  to: string;
  task_id: string | null;
  dispatch_id: string | null;
  body: string;
  outcome?: "succeeded" | "failed";
  files_modified?: string[];
  report_path?: string | null;
  status?: AttentionStatus;
  reply_to?: string;
  phase?: string;
  options?: string[];
  answer?: string;
  option_index?: number | null;
  acked: boolean;
  delivered?: boolean;
  delivery_claim?: DeliveryClaim;
  delivery_unknown?: DeliveryUnknown;
  nudged_at?: string;
};

export type Dispatch = {
  id: string;
  run_id: string;
  task_id: string;
  worker: string;
  attempt: number;
  preamble: string;
  cwd: string;
  runtime?: Runtime;
  routing?: RoutingProvenance;
  worktree_path?: string;
  claim_until?: string;
  setup?: SetupMetadata;
  pane_id?: string;
  execution_host?: HostProfile;
  started_at: string;
  settled_at?: string;
  outcome?: "succeeded" | "failed";
  retry_of?: string;
  archive_path?: string;
  archive_error?: string;
};

export type State = {
  version: 1;
  runs: Record<string, Run>;
  tasks: Record<string, Task>;
  workers: Record<string, Worker>;
  messages: Message[];
  dispatches?: Record<string, Dispatch>;
  seq: number;
  worktrees?: Record<string, WorktreeRecord>;
  gates?: Record<string, TaskGate>;
  requests?: Record<string, RequestRecord>;
};

export const emptyState = (): State => ({ version: 1, runs: {}, tasks: {}, workers: {}, messages: [], dispatches: {}, worktrees: {}, gates: {}, seq: 0 });

export const now = () => new Date().toISOString();

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

export function load(file = stateFile, _logTo = logFile): State {
  const result = readState(file);
  if (result.corruption) throw new Error(`state file ${file} is corrupt: ${result.corruption}`);
  return result.state;
}

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

function loadForUpdate(file: string, logTo: string): State {
  const result = readState(file);
  if (!result.corruption) return result.state;
  quarantine(file, result.corruption, logTo);
  return emptyState();
}

const TMP_ORPHAN_MS = 60_000;

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
  } catch {}
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
const LOCK_STALE_MS = 30_000;
const LOCK_ABANDONED_MS = 10 * 60_000;

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

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export function lockIsStale(dir: string, at = Date.now()): boolean {
  let age: number;
  try {
    age = at - statSync(dir).mtimeMs;
  } catch {
    return false;
  }
  if (age > LOCK_ABANDONED_MS) return true;
  const owner = lockOwner(dir);
  if (owner && owner.host === hostname()) return !processAlive(owner.pid);
  return age > LOCK_STALE_MS;
}

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

export function release(dir = lockDir): void {
  const owner = lockOwner(dir);
  if (owner && (owner.pid !== process.pid || owner.host !== hostname())) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

let divergenceLogged = false;

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

type Sync<T> = T extends PromiseLike<unknown> ? never : T;

export function nextId(state: State, prefix: string): string {
  state.seq += 1;
  return `${prefix}${state.seq.toString(36)}`;
}

export const LOG_MAX_BYTES = 2_000_000;

export function log(entry: Record<string, unknown>, file = logFile, maxBytes = LOG_MAX_BYTES): void {
  try {
    ensureDir(dirname(file));
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, JSON.stringify({ t: now(), ...entry }) + "\n", { mode: 0o600 });
  } catch {}
}

export const activeRuns = (state: State): Run[] => Object.values(state.runs).filter((r) => r.status === "active");
export const runTasks = (state: State, runId: string): Task[] => Object.values(state.tasks).filter((t) => t.run_id === runId);
export const runWorkers = (state: State, runId: string): Worker[] => Object.values(state.workers).filter((w) => w.run_id === runId);
export const runMessages = (state: State, runId: string): Message[] => state.messages.filter((m) => m.run_id === runId);
export const runDispatches = (state: State, runId: string): Dispatch[] =>
  Object.values(state.dispatches ?? {}).filter((d) => d.run_id === runId).sort((a, b) => idSeq(a.id) - idSeq(b.id));
export const idSeq = (id: string): number => parseInt(id.slice(1), 36) || 0;

export function resolveRun(
  state: State,
  opts: { runId?: string; paneId?: string | null; workspaceId?: string | null; allowClosed?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Run {
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

export function taskGateBlockers(state: State, taskId: string): TaskGate[] {
  return Object.values(state.gates ?? {}).filter((gate) => gate.task_id === taskId && gate.status !== "approved");
}

export function ready(state: State, task: Task): boolean {
  return task.status === "pending" && task.depends_on.every((d) => state.tasks[d]?.status === "succeeded") && taskGateBlockers(state, task.id).length === 0;
}

export const START_CLAIM_MS = 5 * 60_000;

export function unacked(state: State, runId: string): Message[] {
  return state.messages.filter((m) => m.run_id === runId && m.to === "orchestrator" && !m.acked);
}

export const WORKER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

const RUN_START_FENCE_TIMEOUT_MS = 120_000;
const runStartFencePath = (runId: string) => join(stateDir, "run-start-fences", `${encodeURIComponent(runId)}.lock`);

export async function withRunStartFence<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const path = runStartFencePath(runId);
  await acquire(path, RUN_START_FENCE_TIMEOUT_MS);
  try {
    return await fn();
  } finally {
    release(path);
  }
}

export function firstLine(s: string): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > 60 ? line.slice(0, 57) + "..." : line;
}

export function newTask(id: string, runId: string, spec: string, title?: string, dependsOn: string[] = []): Task {
  return { id, run_id: runId, title: title ?? firstLine(spec), spec, status: "pending", depends_on: dependsOn, worker: null, dispatch_id: null, attempts: 0, created_at: now(), updated_at: now(), outcome: null };
}

export function addTask(state: State, runId: string, spec: string, title?: string): Task {
  const task = newTask(nextId(state, "t"), runId, spec, title);
  state.tasks[task.id] = task;
  return task;
}
