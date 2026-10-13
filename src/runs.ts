// A run's end of life: closing it (workers, tasks, sidebar) and, later,
// pruning closed runs and everything that belongs to them out of the state.
import { existsSync, rmSync } from "node:fs";
import { getPane, paneClose } from "./herdr.ts";
import { activeRuns, log, now, runWorkers, type Run, type State, update } from "./state.ts";
import { archiveDir, settleDispatch } from "./dispatch.ts";
import { type ReleaseResult, releaseWorker } from "./workers.ts";

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "90s", "15m", "12h", "2d", "1w" in milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}": use a number and a unit, like 30m, 12h, 2d, 1w`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

const closedAt = (r: Run): number => {
  const t = Date.parse(r.closed_at ?? r.created_at);
  return Number.isNaN(t) ? 0 : t;
};

export type PruneOptions = {
  /** Keep this many of the most recently closed runs (default 5, or 0 with `olderThanMs`). */
  keep?: number;
  /** Only runs closed longer ago than this. */
  olderThanMs?: number;
  /** Every closed run, whatever `keep` says. */
  all?: boolean;
  now?: number;
};

export type PruneResult = { runs: { id: string; objective: string; closed_at: string | null }[]; removed: Record<string, number> };

/**
 * Delete closed runs and every record that carries their run_id, in place.
 * Generic over the state's shape: any top-level array, or map of records,
 * whose entries have a `run_id` is swept, so records other features add are
 * pruned with their run. Active runs are never touched.
 */
export function pruneRuns(state: State, o: PruneOptions = {}): PruneResult {
  const at = o.now ?? Date.now();
  const closed = Object.values(state.runs)
    .filter((r) => r.status === "closed")
    .sort((a, b) => closedAt(b) - closedAt(a));
  const keep = o.all ? 0 : (o.keep ?? (o.olderThanMs !== undefined ? 0 : 5));
  const doomed = closed.slice(Math.max(0, keep)).filter((r) => o.olderThanMs === undefined || at - closedAt(r) > o.olderThanMs);
  const ids = new Set(doomed.map((r) => r.id));
  const removed: Record<string, number> = {};
  if (!ids.size) return { runs: [], removed };
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
        delete map[k];
        n++;
      }
    }
    if (n) removed[key] = n;
  }
  return { runs: doomed.map((r) => ({ id: r.id, objective: r.objective, closed_at: r.closed_at ?? null })), removed };
}

/** Delete the screen archives of pruned runs (their dispatch records, which point at them, are gone). */
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

export type CloseResult = {
  closed: string;
  /** Released workers; each one's screen is archived first, as `worker release` does. */
  released: ({ worker: string } & ReleaseResult)[];
  /** Worker records dropped without releasing: their panes, if any, are still open. */
  forgotten: { worker: string; pane_id: string; tab_id: string | null }[];
  failed_tasks: string[];
  closed_sidebar: string | null;
};

/**
 * Close a run: refuse when it is already closed or still has dispatched
 * workers (unless `release` or `force`), fail its dispatched tasks and settle
 * their dispatch records, release
 * (with `release`) and then forget its workers, and close its sidebar pane
 * unless another active run shows the same one.
 */
export async function closeRun(runId: string, o: { release?: boolean; force?: boolean } = {}): Promise<CloseResult> {
  const { run, workers, failed } = await update((state) => {
    const run = state.runs[runId];
    if (!run) throw new Error(`no run ${runId}`);
    if (run.status === "closed" && !o.force) throw new Error(`run ${runId} is already closed; pass --force to close it again`);
    const workers = runWorkers(state, runId);
    const busy = workers.filter((w) => w.task_id && state.tasks[w.task_id]?.status === "dispatched");
    if (busy.length && !o.release && !o.force) {
      throw new Error(`workers still dispatched in run ${runId}: ${busy.map((w) => w.name).join(", ")}; pass --release to release them, or --force to close anyway`);
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
    // Nothing of a closed run is still in flight: any dispatch left open is failed with it.
    for (const d of Object.values(state.dispatches ?? {})) if (d.run_id === runId) settleDispatch(state, d.id, "failed");
    run.status = "closed";
    run.closed_at = now();
    // sync() only clears this on active runs; a closed run keeps no stale herdr warning.
    delete run.herdr_unreachable_since;
    return { run: { ...run }, workers, failed };
  });

  const released: CloseResult["released"] = [];
  if (o.release) {
    for (const w of workers) {
      try {
        released.push({ worker: w.name, ...(await releaseWorker(run, w.name, { force: true })) });
      } catch {}
    }
  }

  const sidebar = run.sidebar_pane_id ?? null;
  const { forgotten, shared } = await update((state) => {
    const forgotten: CloseResult["forgotten"] = [];
    for (const w of runWorkers(state, runId)) {
      forgotten.push({ worker: w.name, pane_id: w.pane_id, tab_id: w.tab_id ?? null });
      const wt = w.worktree ? state.worktrees?.[w.worktree.path] : undefined;
      if (wt) wt.released_at ??= now();
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
    } catch {}
  }
  log({ event: "run.closed", run: runId, released: released.map((r) => r.worker), forgotten: forgotten.map((f) => f.worker), failed_tasks: failed, closed_sidebar });
  return { closed: runId, released, forgotten, failed_tasks: failed, closed_sidebar };
}
