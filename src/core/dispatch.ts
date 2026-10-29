import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readScreen, type ScreenSource } from "../mux/index.ts";
import { ensureDir, stateDir } from "./paths.ts";
import { idSeq, now, type Dispatch, type State, type Task } from "./state.ts";
import { assertTaskGatesApproved } from "./gates.ts";
import type { HostProfile } from "../herdr/hosts.ts";
import { CodedError } from "./errors.ts";

export const archiveDir = (runId: string) => join(stateDir, "archive", runId);

export const MAX_FAILED_ATTEMPTS = 3;

export class RetryLimitError extends CodedError {
  constructor(message: string) {
    super("retry_limit", message);
  }
}

export function failedStreak(state: State, task: Task): string[] {
  const since = task.retry_reset_at ? Date.parse(task.retry_reset_at) : -Infinity;
  return Object.values(state.dispatches ?? {})
    .filter((d) => d.task_id === task.id && d.settled_at && d.outcome === "failed" && Date.parse(d.started_at) >= since)
    .map((d) => d.id);
}

export function assertRetryBudget(state: State, task: Task): void {
  const raw = process.env.PACK_MAX_FAILED_ATTEMPTS;
  const limit = raw !== undefined && Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : MAX_FAILED_ATTEMPTS;
  if (limit === 0) return;
  const failed = failedStreak(state, task);
  if (failed.length >= limit) {
    throw new RetryLimitError(`task ${task.id} failed ${failed.length} attempts in a row (${failed.join(", ")}); no further dispatch. Rewrite the work as a new task, or reset the count deliberately with \`pack-leader task update ${task.id} --status pending\``);
  }
}

export function createDispatch(state: State, d: { id: string; task: Task; worker: string; preamble: string; cwd: string; worktreePath?: string; paneId?: string; executionHost?: HostProfile }): Dispatch {
  assertTaskGatesApproved(state, d.task.id);
  assertRetryBudget(state, d.task);
  const prev = d.task.status === "failed" && d.task.dispatch_id && d.task.dispatch_id !== d.id ? d.task.dispatch_id : undefined;
  const rec: Dispatch = {
    id: d.id,
    run_id: d.task.run_id,
    task_id: d.task.id,
    worker: d.worker,
    attempt: d.task.attempts + 1,
    preamble: d.preamble,
    cwd: d.cwd,
    ...(d.worktreePath ? { worktree_path: d.worktreePath } : {}),
    ...(d.paneId ? { pane_id: d.paneId } : {}),
    ...(d.executionHost ? { execution_host: { ...d.executionHost } } : {}),
    ...(state.workers[d.worker]?.run_id === d.task.run_id ? {
      runtime: { kind: state.workers[d.worker]!.kind, model: state.workers[d.worker]!.model ?? null, thinking: state.workers[d.worker]!.thinking ?? null },
      routing: { provider: "off" as const, status: "bypass" as const, reason: "session_reused" as const, elapsed_ms: 0 },
    } : {}),
    started_at: now(),
    ...(prev ? { retry_of: prev } : {}),
  };
  (state.dispatches ??= {})[d.id] = rec;
  return rec;
}

export { startClaimIsFresh } from "./claims.ts";

export function settleDispatch(state: State, id: string | null | undefined, outcome: "succeeded" | "failed"): void {
  const d = id ? state.dispatches?.[id] : undefined;
  if (!d || d.settled_at) return;
  d.settled_at = now();
  d.outcome = outcome;
  delete d.claim_until;
}

export function dispatchView(d: Dispatch) {
  const { preamble, ...rest } = d;
  return { ...rest, preamble_length: preamble.length };
}

export const taskDispatchIds = (state: State, taskId: string): string[] =>
  Object.values(state.dispatches ?? {}).filter((d) => d.task_id === taskId).sort((a, b) => idSeq(a.id) - idSeq(b.id)).map((d) => d.id);

const ARCHIVE_LINES = 10_000;

export async function readFullScreen(target: string): Promise<{ text: string; source: string }> {
  const tries: { source: ScreenSource; lines?: number; label: string }[] = [
    { source: "recent_unwrapped", lines: ARCHIVE_LINES, label: `recent_unwrapped:${ARCHIVE_LINES}` },
    { source: "recent_unwrapped", label: "recent_unwrapped" },
    { source: "visible", label: "visible" },
  ];
  const errors: string[] = [];
  for (const t of tries) {
    try {
      const text = await readScreen(target, { source: t.source, lines: t.lines, timeoutMs: 60_000 });
      if (text !== null) return { text, source: t.label };
      errors.push(`${t.label}: no text`);
    } catch (err) {
      errors.push(`${t.label}: ${(err as Error).message}`);
    }
  }
  throw new Error(errors.join("; "));
}

export async function archiveScreen(p: { run_id: string; worker: string; dispatch_id: string | null; target: string }): Promise<{ path: string; source: string }> {
  const { text, source } = await readFullScreen(p.target);
  const dir = ensureDir(archiveDir(p.run_id));
  chmodSync(dir, 0o700);
  const path = join(dir, `${p.worker}-${p.dispatch_id ?? "none"}.txt`);
  writeFileSync(path, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, source };
}

export function findArchive(state: State, o: { runId: string | null; worker?: string; dispatchId?: string }): Dispatch | null {
  if (o.dispatchId) {
    const d = state.dispatches?.[o.dispatchId];
    if (!d) throw new Error(`no dispatch ${o.dispatchId}`);
    if (!d.archive_path) throw new Error(`dispatch ${d.id} has no archive${d.archive_error ? ` (${d.archive_error})` : d.settled_at ? "" : "; its worker has not been released"}`);
    return d;
  }
  const mine = Object.values(state.dispatches ?? {}).filter((d) => d.worker === o.worker && d.archive_path && (!o.runId || d.run_id === o.runId));
  mine.sort((a, b) => idSeq(b.id) - idSeq(a.id));
  return mine[0] ?? null;
}

export function readArchive(d: Dispatch, lines: number) {
  const all = readFileSync(d.archive_path!, "utf8").replace(/\n$/, "").split("\n");
  const text = lines > 0 ? all.slice(-lines).join("\n") : all.join("\n");
  return { source: "archive" as const, worker: d.worker, dispatch_id: d.id, task_id: d.task_id, archive_path: d.archive_path!, total_lines: all.length, text };
}
