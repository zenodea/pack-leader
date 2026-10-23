import { existsSync, rmSync } from "node:fs";
import { getPane, renamePane, logHerdrError, paneClose, tabRename } from "../herdr/herdr.ts";
import { closeObserver } from "../agents/observer.ts";
import { activeRuns, load, log, now, runWorkers, START_CLAIM_MS, type Run, type State, update, withRunStartFence } from "./state.ts";
import { archiveDir, settleDispatch, startClaimIsFresh } from "./dispatch.ts";
import { type ReleaseResult, releaseWorker } from "../agents/workers.ts";
import { CodedError } from "./errors.ts";

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}": use a number and a unit, like 30m, 12h, 2d, 1w`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

const closedAt = (r: Run): number => {
  const t = Date.parse(r.closed_at ?? r.created_at);
  return Number.isNaN(t) ? 0 : t;
};

export const CLOSE_GRACE_MS = 3_600_000;

export type PruneOptions = {
  keep?: number;
  olderThanMs?: number;
  all?: boolean;
  now?: number;
};

export type PruneResult = { runs: { id: string; objective: string; closed_at: string | null }[]; removed: Record<string, number>; skipped?: { id: string; reason: string }[] };

export function pruneRuns(state: State, o: PruneOptions = {}): PruneResult {
  const at = o.now ?? Date.now();
  const closed = Object.values(state.runs)
    .filter((r) => r.status === "closed")
    .sort((a, b) => closedAt(b) - closedAt(a));
  const keep = o.all ? 0 : (o.keep ?? (o.olderThanMs !== undefined ? 0 : 5));
  const old = closed.slice(Math.max(0, keep)).filter((r) => o.olderThanMs === undefined || at - closedAt(r) > o.olderThanMs);
  const skipped: { id: string; reason: string }[] = [];
  const doomed = old.filter((r) => {
    const names = Object.values(state.workers).filter((w) => w.run_id === r.id).map((w) => w.name);
    if (!names.length || at - closedAt(r) > CLOSE_GRACE_MS) return true;
    skipped.push({ id: r.id, reason: `workers still recorded (${names.join(", ")}): a run close may still be releasing them. If none is, run \`pack-leader run close --run ${r.id} --force\` to forget them, then prune again` });
    return false;
  });
  const ids = new Set(doomed.map((r) => r.id));
  const removed: Record<string, number> = {};
  const extra = skipped.length ? { skipped } : {};
  if (!ids.size) return { runs: [], removed, ...extra };
  const owned = (v: unknown): boolean => typeof v === "object" && v !== null && ids.has((v as { run_id?: unknown }).run_id as string);
  const bag = state as unknown as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    const v = bag[key];
    let n = 0;
    if (key === "runs") {
      for (const id of ids) delete state.runs[id];
      n = ids.size;
    } else if (Array.isArray(v)) {
      const kept = v.filter((e) => !owned(e));
      n = v.length - kept.length;
      bag[key] = kept;
    } else if (typeof v === "object" && v !== null) {
      const map = v as Record<string, unknown>;
      for (const [k, e] of Object.entries(map)) {
        if (!owned(e)) continue;
        if (key === "worktrees" && typeof e === "object" && e !== null && "cleanup_protection" in e) continue;
        delete map[k];
        n++;
      }
    }
    if (n) removed[key] = n;
  }
  return { runs: doomed.map((r) => ({ id: r.id, objective: r.objective, closed_at: r.closed_at ?? null })), removed, ...extra };
}

export function removeArchives(runIds: string[]): string[] {
  const gone: string[] = [];
  for (const id of runIds) {
    const dir = archiveDir(id);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    gone.push(dir);
  }
  return gone;
}

export class SubRunError extends CodedError {}

export type CloseResult = {
  closed: string;
  released: ({ worker: string } & ReleaseResult)[];
  forgotten: { worker: string; pane_id: string; tab_id: string | null }[];
  failed_tasks: string[];
  closed_sidebar: string | null;
  closed_observer: string | null;
  sub_runs?: CloseResult[];
};

export async function closeRun(runId: string, o: { release?: boolean; force?: boolean } = {}): Promise<CloseResult> {
  const subRuns: CloseResult[] = [];
  if (o.release || o.force) {
    for (const child of activeRuns(load()).filter((r) => r.parent?.run_id === runId)) subRuns.push(await closeRun(child.id, { release: true, force: true }));
  } else {
    const open = activeRuns(load()).filter((r) => r.parent?.run_id === runId);
    if (open.length) throw new SubRunError("sub_run_open", `workers of run ${runId} still coordinate sub-runs: ${open.map((r) => `${r.id} (${r.parent!.worker})`).join(", ")}; pass --release to close them too, or --force`);
  }
  const { run, workers, failed } = await withRunStartFence(runId, () => update((state) => {
    const run = state.runs[runId];
    if (!run) throw new Error(`no run ${runId}`);
    if (run.status === "closed" && !o.force) throw new Error(`run ${runId} is already closed; pass --force to close it again`);
    const workers = runWorkers(state, runId);
    const busy = workers.filter((w) => w.task_id && state.tasks[w.task_id]?.status === "dispatched");
    const registered = new Set(workers.map((w) => w.dispatch_id).filter((id): id is string => Boolean(id)));
    const starting = Object.values(state.dispatches ?? {}).filter((d) => d.run_id === runId && !d.settled_at && !registered.has(d.id));
    const activeStarts = starting.filter((d) => startClaimIsFresh(d, START_CLAIM_MS));
    if (!o.release && !o.force) {
      if (busy.length) throw new Error(`workers still dispatched in run ${runId}: ${busy.map((w) => w.name).join(", ")}; pass --release to release them, or --force to close anyway`);
      if (activeStarts.length) throw new Error(`workers still starting in run ${runId}: ${activeStarts.map((d) => d.worker).join(", ")}; pass --release to release them, or --force to close anyway`);
    }
    const failed: string[] = [];
    for (const t of Object.values(state.tasks)) {
      if (t.run_id !== runId || t.status !== "dispatched") continue;
      t.status = "failed";
      t.updated_at = now();
      t.outcome = { summary: "run closed", files_modified: [], report_path: null };
      settleDispatch(state, t.dispatch_id, "failed");
      failed.push(t.id);
    }
    for (const d of starting) {
      const t = state.tasks[d.task_id];
      if (!t || t.run_id !== runId || (t.status !== "pending" && t.status !== "failed")) continue;
      t.status = "failed";
      t.worker = d.worker;
      t.dispatch_id = d.id;
      t.attempts += 1;
      t.updated_at = now();
      t.outcome = { summary: "run closed", files_modified: [], report_path: null };
      if (!failed.includes(t.id)) failed.push(t.id);
    }
    for (const d of Object.values(state.dispatches ?? {})) if (d.run_id === runId) settleDispatch(state, d.id, "failed");
    for (const m of state.messages) if (m.run_id === runId && !m.acked && (m.type === "followup" || m.type === "reply")) m.acked = true;
    run.status = "closed";
    run.closed_at = now();
    delete run.herdr_unreachable_since;
    return { run: { ...run }, workers, failed };
  }));

  const released: CloseResult["released"] = [];
  if (o.release) {
    for (const w of workers) {
      try {
        released.push({ worker: w.name, ...(await releaseWorker(run, w.name, { force: true })) });
      } catch (err) {
        log({ event: "worker.release_failed", run: runId, worker: w.name, error: (err as Error).message });
      }
    }
  }

  const sidebar = run.sidebar_pane_id ?? null;
  const { forgotten, shared } = await update((state) => {
    const forgotten: CloseResult["forgotten"] = [];
    for (const w of runWorkers(state, runId)) {
      forgotten.push({ worker: w.name, pane_id: w.pane_id, tab_id: w.tab_id ?? null });
      const wt = w.worktree ? state.worktrees?.[w.worktree.path] : undefined;
      if (wt && wt.worker === w.name && wt.run_id === w.run_id && wt.dispatch_id === w.worktree_dispatch_id) {
        delete wt.released_at;
        wt.cleanup_protection = "forgotten";
      }
      delete state.workers[w.name];
    }
    const r = state.runs[runId];
    if (r) r.sidebar_pane_id = null;
    return { forgotten, shared: Boolean(sidebar) && activeRuns(state).some((x) => x.sidebar_pane_id === sidebar) };
  });

  let closed_sidebar: string | null = null;
  if (sidebar && !shared) {
    try {
      await getPane(sidebar);
      await paneClose(sidebar);
      closed_sidebar = sidebar;
    } catch (err) {
      logHerdrError("sidebar.close", err, { run: runId, pane: sidebar });
    }
  }
  const closed_observer = await closeObserver(run);
  if (run.orchestrator.pane_id) await renamePane(run.orchestrator.pane_id, null);
  if (run.orchestrator.tab_id && run.orchestrator.tab_label) await tabRename(run.orchestrator.tab_id, run.orchestrator.tab_label).catch(() => {});
  log({ event: "run.closed", run: runId, released: released.map((r) => r.worker), forgotten: forgotten.map((f) => f.worker), failed_tasks: failed, closed_sidebar, closed_observer });
  return { closed: runId, released, forgotten, failed_tasks: failed, closed_sidebar, closed_observer, ...(subRuns.length ? { sub_runs: subRuns } : {}) };
}
