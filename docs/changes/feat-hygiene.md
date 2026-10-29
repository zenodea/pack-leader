# feat/hygiene: state hygiene and run lifecycle

## What changed

- `lodestar run prune [--keep N] [--older-than D] [--all] [--dry-run]`
  (`pruneRuns` in `src/runs.ts`) deletes closed runs and every record that
  carries their `run_id`. The sweep is generic: any top-level array, or map of
  records, on the state whose entries have `run_id` is pruned, so records other
  branches add (leases, dispatches, ...) go with their run without changes here.
  Active runs are never touched.
- `lodestar run close` (`closeRun` in `src/runs.ts`): refuses an already
  closed run unless `--force`; refuses while a worker has a dispatched task
  unless `--release` or `--force`; marks dispatched tasks failed ("run closed");
  releases workers with `--release`, then deletes every remaining worker record
  of the run; closes the `sidebar_pane_id` pane if alive (`pane.get`, then
  `pane.close`, errors swallowed) and clears the field. Output is now
  `{ closed, released: [{worker, closed_pane, closed_tab}], forgotten, failed_tasks, closed_sidebar }`.
- `resolveRun` takes `allowClosed`. An explicit `--run`/`LODESTAR_RUN_ID` naming a
  closed run is an error ("run X is closed") unless the caller is read-only
  (`run show`, `run list`, `task show`, `task list`, `status`, `worker show`,
  `worker read`). Worker-pane matching ignores closed runs.
- `task show`, `task update`, `worker show/read/focus/stop/retain` check that the
  task or worker belongs to the resolved run.
- `releaseWorker` returns `{ closed_pane, closed_tab }`. When a hidden worker's
  tab is closed, both are set (the pane goes with its tab); for a split worker
  only `closed_pane`.
- `status` shows active runs and `closed_runs` (a count); `--all` lists closed
  runs too. Sidebar: closed runs were already hidden; the empty state is one line.

## Decisions

- Prune with only `--older-than` keeps nothing by default (deletes every closed
  run older than D); with `--keep N` too, the newest N closed runs are spared
  even if old. Plain `prune` keeps 5. Order is by `closed_at` (else `created_at`).
- `run close` without `--release` still deletes worker records (their panes
  stay open); they are listed under `forgotten` so nothing is lost silently.
- The sidebar pane is not closed when another active run records the same
  `sidebar_pane_id` (`openSidebar` reuses one sidebar per workspace).
- Dispatched tasks are failed with "run closed" before releasing, so that
  summary wins over the release one.
- `dispatch *` from the spec: no `dispatch` command exists on this branch; the
  branch adding it should call `currentRun(args, state, true)`.
- `run close` output changed shape (`released` is now objects, not names).
