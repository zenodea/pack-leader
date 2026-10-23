import { resolveRun, type Run, type State } from "./state.ts";

export function resolveLeaderRun(
  state: State,
  opts: { runId?: string; paneId?: string | null; workspaceId?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Run {
  if (!opts.runId && !env.PACK_RUN_ID && opts.paneId) {
    const active = Object.values(state.runs).filter((run) => run.status === "active");
    const workers = Object.values(state.workers).filter((worker) => !worker.execution_host && state.runs[worker.run_id]?.status === "active");
    const direct = active.some((run) => run.orchestrator.pane_id === opts.paneId || run.sidebar_pane_id === opts.paneId || run.observer?.pane_id === opts.paneId)
      || workers.some((worker) => worker.pane_id === opts.paneId);
    if (!direct) {
      const runs = [...new Set(workers.filter((worker) => worker.bar_pane_id === opts.paneId).map((worker) => worker.run_id))];
      if (runs.length > 1) throw new Error(`several runs own bar ${opts.paneId}; pass --run <id>`);
      if (runs.length === 1) return resolveRun(state, { ...opts, runId: runs[0] }, env);
    }
  }
  return resolveRun(state, opts, env);
}
