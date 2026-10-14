# fix/runtime: closing the runtime review items

Closes R1, R2, R6, R7, R10, R11, R12, R15, R16, R19, R21, R22, R23, R26, E10 and V5 of
`docs/review/findings-status.md`, the orchestrator's late addition R27, and the deferred
D1 and D3 of `docs/review/final-code-review.md`. Each one has a test in `test/review.test.ts`
(section "Runtime close-out"). 151 tests pass.

## What changed

- **Start (R1, R2, E10)**: the worker name stays reserved by the unsettled dispatch record from
  the first `update()` on (the F5 claim). The `agent.list` check before it is now advisory: if
  herdr fails there, the failure is logged and the start continues, but a live agent with the
  name is still refused. If the worktree, tab or split fails, the dispatch is settled as failed,
  and a `--spec` task made only for this start is deleted (the error ends "task tX was not kept").
  The worker pane env now carries `HERDR_PLUGIN_STATE_DIR`.
- **Redispatch, i.e. `worker prompt` (R6, R16, R19)**:
  - It waits up to 30 s for the agent to be idle or done. If the agent is still busy, it refuses
    and nothing is dispatched.
  - `--task` checks dependencies, as `start` does. A failed task counts as a retry.
  - The prompt goes through `promptWithRetry`. If the prompt fails for good, the change is rolled
    back: the dispatch is settled as failed, a `--spec` task is deleted, a `--task` task gets back
    its status, worker, dispatch and attempts, the worker gets back its IDs, and the command fails
    with an error that says to run `worker prompt` again. The old F3 "warning + resend" result no
    longer happens; `redispatch()` keeps `warning?` in its return type so cli.ts still compiles.
- **A prompt that timed out (D1)**: `promptWithRetry` and the followup `deliver()` read the agent's
  `state_change_seq` before prompting. After a timeout, a counter that moved (or an agent now
  working) means the prompt landed. It counts as delivered and is not sent again. If nothing
  moved, the old retry/revert still applies. This is a heuristic, not a delivery receipt.
- **ask (R7, V5, D3)**: the wait uses `fs.watch` on the state directory (save renames a temp file
  over state.json), with a 2 s fallback tick. `ask --id` fails at once unless the id is an ask
  from this worker in this run. If the worker already collected the reply, it fails and shows the
  reply text. A reply that was not collected yet is still returned. If the worker is released
  while waiting, or the run closes, the ask stops with an error instead of waiting out the
  10 minutes.
- **Orphaned followups (R10)**: `releaseWorker` acks the worker's undelivered followups and
  uncollected replies (`dropUndelivered`), and `closeRun` acks all of them in the run.
  `deliver()` claims a message only for a worker that is still recorded and is the same
  incarnation.
- **sync**:
  - R11: it nudges an idle or done orchestrator once more about unacked done, ask and note
    messages older than 60 s (`PACK_RENUDGE_MS`, 0 disables) and records `nudged_at` on each
    message.
  - R15: `blocked` raises an attention even after the report. There is one open alert per
    worker, dispatch and status, and a new episode after an ack raises again.
  - R27: while `awaiting_prompt` is set, `working` does not count as worked, and idle or done
    raises nothing. An agent booting before its preamble no longer gives a false "idle without
    having reported".
- **check --wait (R12, R23)**: it also subscribes to `tab.closed`, a name confirmed in
  `herdr api schema --json`. It tracks the event stream, and while the stream is down it skips
  sync's herdr calls and only sets the unreachable warning (`markHerdrUnreachable`).
  `herdr-plugin.toml` gets a `[[events]] on = "tab.closed"` hook. The subscribe backoff now
  doubles from 0.5 s up to a 10 s cap, and resets after a good reply.
- **herdr.ts (R21, R22)**: `herdr()` rejects a reply that has no `result` with
  `HerdrError("bad_reply")`. `getAgent`, `getPane` and `paneSplit` answer `bad_result` instead of
  `undefined`. `logHerdrError()` writes a `herdr.error` event in each swallowed catch: labelPane,
  notify, nudges, release close, the F14 tab close, `agent.list` at start, and the sidebar close
  in closeRun.
- New env knob for tests: `PACK_PROMPT_RETRY_MS` (base delay between prompt retries, default 1000).

## Decisions

- **The F3 test is replaced**: the task asked for a rollback on a failed redispatch prompt. The
  ambiguous case F3 guarded (a timeout whose prompt landed anyway) is handled by the landed check,
  so the dispatch stays only when there is evidence that the worker got it.
- **The dispatch record of a rolled-back start or redispatch is kept, settled as failed**: it is
  the trail of the attempt. Its `task_id` may name a deleted `--spec` task.
- **The initial nudges in done, ask and note set no `nudged_at`**: the re-nudge is the "once more".
- **D2, D4, D5 and D6 are left deferred**: none of them got easier with these changes.
- **I did not use cli.ts's `workspaceOf()`**: workers.ts importing cli.ts would be a circular
  import, and cli.ts lives on another branch. The integrator can swap the `.split(":")[0]` at the
  tab placement for it.

## Requests for other owners

- **src/state.ts (state worker)**: add to `Message`:
  `/** When sync re-nudged the orchestrator about it (once, R11). */ nudged_at?: string;`.
  Until then, inbox.ts uses a local `Nudged = Message & { nudged_at?: string }`.
- **src/cli.ts (cli worker)**:
  - Already done on fix/cli: the `event` case syncs on `data.tab_id` as well as `data.pane_id`.
  - `worker prompt` can now fail with a plain error after a rollback. The `r.warning` branch
    stays harmless.
- **docs/guide.md and README (cli worker)**, suggested wording:
  - `worker prompt`: "Waits up to 30 s for the worker to be idle; if it stays busy, nothing is
    dispatched. `--task` must have its dependencies met. If the prompt does not go in, the
    dispatch is rolled back (the task and the worker are as before) and the command fails: run
    it again."
  - Worker `ask --id`: "Only your own ask; an id that is not yours fails at once. If you already
    collected its answer, the error repeats it. If you are released while waiting, `ask` stops."
  - `check` / attention: "`blocked` is raised even after a worker reported (for example a
    permission prompt while handling a follow-up). An orchestrator that sits idle with unread
    reports, questions or notes older than a minute is nudged once more (`PACK_RENUDGE_MS`)."
  - Release and run close: "Followups and replies the worker never received are dropped with it."
  - Environment: "A worker's pane gets `HERDR_PLUGIN_STATE_DIR`, so it uses the orchestrator's
    state file."
