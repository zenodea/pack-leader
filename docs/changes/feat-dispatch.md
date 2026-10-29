# feat/dispatch: dispatch records and release archives

A dispatch used to be only an id on Task/Worker/Message. Now it is a record.

## What changed

- `State.dispatches?: Record<id, Dispatch>` (optional, so old state files load;
  `emptyState()` and `load()` give `{}`). A `Dispatch` holds `run_id`, `task_id`,
  `worker`, `attempt`, the exact `preamble` sent, `cwd`, `started_at`, and once
  settled `settled_at` + `outcome`; plus `retry_of`, `archive_path`, `archive_error`.
- New `src/dispatch.ts` holds the helpers (create, settle, view, archive, find),
  so the edits to `workers.ts`, `inbox.ts` and `cli.ts` stay small for merging.
- Created where the id is minted: `startWorker` and `redispatch`. The preamble
  is built inside the same lock and the stored text is the text sent
  (`redispatch` includes its "new dispatch in your existing session" line).
  `worker resend` re-sends the stored text and creates nothing.
- `retry_of` is set whenever a dispatch is made for a task whose status is
  `failed` (so `worker start --task ID --retry` and `worker prompt --task ID`
  on a failed task); it names the task's previous `dispatch_id`.
- Settled by `done` (its outcome), and as `failed` by `worker release --force`,
  sync's exited-while-owing path, a worker whose agent did not come up, and a
  `worker start` whose tab/pane could not be created. Settling is first-wins.
- `releaseWorker` archives the screen after the state update and before closing
  the pane/tab: `<stateDir>/archive/<run>/<worker>-<dispatch>.txt`, dir 0700,
  file 0600. It archives even with `--keep-pane`/retained (cheap, consistent).
  A failure is recorded as `archive_error` on the dispatch and in the release
  output; the release still completes.
- `agent.read` source order for the archive: `recent_unwrapped` with 10000
  lines, then `recent_unwrapped` at herdr's default size, then `visible`.
  herdr refuses long reads of a busy alternate-screen agent (`agent_not_idle`),
  which a `--force` release of a working worker hits; the fallback covers it.
- `worker read NAME`: when NAME is not a worker of the current run any more, it
  prints the newest archive for that name as JSON with `source: "archive"`
  (last `--lines`, default 80; `total_lines` and `archive_path` for the rest).
  `--dispatch ID` reads that dispatch's archive. A live worker is read as before
  (raw text); a name with no archive falls through to the live read.
- `lodestar dispatch list [--task] [--worker]` (run-scoped, oldest first) and
  `lodestar dispatch show ID [--preamble]` (record with `preamble_length`;
  `--preamble` prints the raw text exactly).
- `task show` adds `dispatch_ids`; `status --json` / `run show` add
  `dispatches` per task; `status` text shows "(N dispatches)" when N > 1.

## Not verified

The 10000-line archive read was tested against a fake herdr only. On a live
herdr I confirmed the `agent_not_idle` refusal for a working agent and that the
default-size read works; a long read of an idle agent (which herdr captures by
scrolling) was not timed. It has a 60 s timeout before falling back.
