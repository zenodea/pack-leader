# Final code review: the feature wave (812d9a0..ccd156f)

An adversarial review of the current code after the six feature branches were merged
(dispatch records + archive, liveness/stall/next_action/wait heartbeat, run prune + stricter
close, ask --options / reply --free, group sends + notes + worker sends, --worktree per
worker). Every suspected bug was first pinned by a failing test in `test/review.test.ts`
(test names start with the finding id), then fixed. Line numbers are for the fixed code.

Verdicts: **fixed** (test fails before the fix, passes after), **not a bug** (checked, with
the reason), **deferred** (real, with the reason it was left).

## Fixed

### F1. Followups and replies reached the wrong worker (cross-run, and a later worker of the same name)
- Where: `src/inbox.ts:548` (sync delivery), `src/inbox.ts:232` (inbox), new `meantFor()` at `src/inbox.ts:74`.
- What: sync() delivered every undelivered followup whose `to` matched the worker's name, with no
  run filter. Worker names are reused across runs (and within a run after a release), so a followup
  queued for `api` in a closed run, or for a released `api`, was prompted into the new `api`.
  `inbox` filtered by run but not by incarnation, so a reply to the old worker's ask, sent after the
  name was reused, went to the new worker.
- Fix: a followup or reply is for a worker only when it is from the worker's run and was sent (for a
  reply: its ask was asked) at or after the worker's `started_at`.
- Tests: `F1: sync delivers only this run's followups sent to this incarnation of the worker`,
  `F1: inbox skips followups and replies meant for an earlier worker of the same name`.

### F2. A quick idle-without-report after a prompt went unnoticed for 20 minutes
- Where: `src/workers.ts:529` (`baseline`, was `markDispatched`), used by start, redispatch and resend.
- What: herdr's `state_change_seq` baseline was read *after* the prompt. herdr flips the agent to
  working the moment the prompt lands, so the baseline already included the working transition and
  `worked` was reset to false after it. An agent that finished without `done` before any sync saw it
  working (the orchestrator is busy starting other workers, so `check --wait` is not running) was
  idle at baseline+1, not +2: no `idle` attention, only the stall alert 20 minutes later.
- Fix: take the baseline (and reset `worked`) before the prompt; `markPrompted()` after it only
  touches the worker and clears `awaiting_prompt`.
- Test: `F2: a redispatched worker that finishes quickly without reporting raises an idle attention`.

### F3. A redispatch whose prompt failed left the task dispatched with only a raw herdr error
- Where: `src/workers.ts:288-297`, `src/cli.ts:307`.
- What: `worker prompt` records the dispatch and marks the task dispatched, then prompts. When the
  prompt threw, the command printed a herdr error; the task stayed dispatched, `worker prompt` again
  was refused ("still on task"), and nothing said `worker resend` would recover it.
- Fix: the failure is caught; `worker prompt` prints the dispatch plus a `warning` naming
  `lodestar worker resend NAME` and exits 1, as `worker start` already does. The worker keeps
  `awaiting_prompt`, so followups do not overtake the dispatch (F4).
- Test: `F3: a redispatch whose prompt fails returns a warning naming resend, and the dispatch stays resendable`.

### F4. A followup could overtake a starting worker's preamble (group send vs claim-before-prompt)
- Where: `src/inbox.ts:269-275` (send), `src/inbox.ts:547` (sync), `src/state.ts:80` (`awaiting_prompt`).
- What: a worker is recorded with its task dispatched before its agent is started and prompted, so
  `send @all` (or a plain send, or sync) during a start saw an idle agent at its shell or Claude
  prompt and delivered the followup first: the worker received "[follow-up] ..." with no context,
  then its dispatch. The claim in `deliver()` only stops double delivery, not this ordering.
- Fix: a worker carries `awaiting_prompt` from being recorded (start) or redispatched until its
  dispatch prompt went in; while set, followups queue (even with `--now`) for the next idle sync or
  `lodestar inbox`. Older state files have no field and behave as before.
- Test: `F4: a followup sent while a worker is starting waits for its preamble`.

### F5. Two concurrent starts could claim the same task or the same worker name
- Where: `src/workers.ts:97` and `refuseStartInFlight()` at `src/workers.ts:467`.
- What: `worker start` checks the name and the task in one update, but records the worker and
  marks the task dispatched only in a second update, after the tab (and maybe a worktree) exists.
  Two starts in parallel (parallel tool calls) both passed the checks: two agents on one task, the
  loser's dispatch record unsettled forever, `attempts` counted twice.
- Fix: a dispatch that is recorded but whose worker is not yet is a start in flight; another start
  of the same name or task is refused until it lands. One killed in between (Ctrl-C) stops counting
  after `START_CLAIM_MS` (5 min) and its dispatch is settled as failed.
- Tests: `F5: concurrent starts of the same task: one wins, ...`, `F5: concurrent starts of the same
  worker name: one wins`, `F5: an abandoned start ... stops blocking after the claim window`.

### F6. A fresh worktree leaked when the worker's tab or pane could not be made
- Where: `src/workers.ts:138-171`, `undoWorktree()` at `src/workers.ts:438`.
- What: with `--worktree new`, the checkout (and branch, and maybe a herdr workspace) was created
  before the tab; if `tab.create`/`pane.split` then failed, the dispatch was settled but the empty
  checkout stayed on disk, unreported, and blocked the next `--worktree new` for that name
  ("already exists").
- Fix: a checkout Lodestar created for that start is removed again (never forced; the branch is
  kept), its record is marked, and the error says what happened to it.
- Test: `F6: a worktree created for a start that then fails is removed again`.

### F7. A release that could not close the tab or pane said nothing
- Where: `src/workers.ts:369-379`.
- What: the worker record is deleted first; then `getPane`/`tab.close`/`pane.close` errors were all
  swallowed. With herdr timing out, the tab stayed open, `closed_tab` was null, and no record pointed
  at it any more: a silent leak.
- Fix: `pane_not_found`/`tab_not_found` are still fine; any other error adds `close_error` to the
  result (and the log) naming the tab or pane that may still be open.
- Test: `F7: release reports close_error when herdr fails to close the tab, and nothing when the pane is already gone`.

### F8. A herdr answer without the list read as "no panes": every worker exited, every task failed
- Where: `src/herdr.ts:96-105`.
- What: `listPanes()`/`listAgents()` returned `?? []` when the result had no `panes`/`agents`.
  sync() then saw every worker's pane missing; after two syncs all of them were `exited` and their
  dispatched tasks failed with "worker exited before reporting".
- Fix: an answer without the array is a `HerdrError("bad_result")`; sync() treats it as herdr
  unreachable (verdicts kept, run warning set). The sidebar and `@idle` already handle a throw.
- Test: `F8: pane.list answering without panes does not mark workers exited`.

### F9. A sync snapshot older than a worker counted as a miss (two stale snapshots failed a fresh task)
- Where: `src/inbox.ts:448`, `src/inbox.ts:468`.
- What: sync() reads herdr, then updates the state. A worker recorded by a concurrent `worker start`
  between the two is absent from the snapshot, which counted as a pane miss. The sidebar, `check
  --wait`, `worker list` and `status` all sync, so two such stale snapshots in a row could mark a
  just-started worker exited and fail its task.
- Fix: a worker started after the snapshot was taken is skipped by that sync.
- Test: `F9: a worker recorded after sync took its herdr snapshot is not counted missing`.

### F10. Prune could delete a run whose close was still releasing its workers
- Where: `src/runs.ts:49-60`.
- What: `run close --release` marks the run closed first, then releases workers one by one
  (archiving each screen), then forgets them. A `run prune --all` (or `--keep 0`) in between deleted
  the worker records and the archive dir: the remaining releases failed with "no worker" (swallowed
  by closeRun), their tabs stayed open unreported (not even under `forgotten`), and later archives
  recreated the deleted dir.
- Fix: a closed run that still has worker records and was closed less than `CLOSE_GRACE_MS` (1 h)
  ago is skipped and listed under `skipped` with the reason and the recovery command
  (`run close --run ID --force`). Past the hour such a close is taken to have died and the run is
  pruned as before (so the existing prune tests, with workers in long-closed runs, are unchanged).
- Test: `F10: prune skips a run closed moments ago that still has worker records, and says why`.

### F11. `check --ack` with nothing to ack printed two JSON documents
- Where: `src/cli.ts:340-348`.
- What: `{acked: 0, warning}` was written, then the check result: stdout was not one parseable JSON
  value. (Older than this wave, but in the current code.)
- Fix: one object: `{acked: 0, ack_warning: "nothing to ack with those ids", ...result}`. The key is
  `ack_warning`, not `warning`, because the guide says a `warning` on `check` means herdr is
  unreachable.
- Test: `F11: check --ack with unknown ids prints a single JSON object`.

### F12. A group send stopped at the first recipient released after expansion
- Where: `src/inbox.ts:330-346`.
- What: `@all`/`@idle`/`@kind` are expanded from a snapshot, then sent one by one. A recipient
  released in between made `send()` throw: the remaining recipients got nothing and the result of
  those already sent was lost.
- Fix: for a group address, such a recipient is listed with `message_id: null`, `delivered: false`
  and `error`; the rest are still sent. A plain name still throws.
- Test: `F12: @all keeps sending when a recipient is released between expansion and its send`.

### F13. The redispatch preamble contradicted itself
- Where: `src/workers.ts:18-27`, `src/workers.ts:278`.
- What: a `worker prompt` preamble said the CLI "already knows your IDs from the environment" (false
  for a second dispatch: the pane env names the first), and the instruction to pass
  `--task/--dispatch` was appended after the task spec, where a long spec buries it.
- Fix: for a redispatch the second line itself says the environment names the previous dispatch
  and gives the exact `--task ID --dispatch ID` to pass. A first dispatch reads as before.
- Test: `F13: a redispatch preamble puts the --task/--dispatch rule up front and drops the environment claim`.

### F14. A herdr answer without the new pane crashed `worker start` after the dispatch was recorded
- Where: `src/workers.ts:152-164`.
- What: `tab.create` without `root_pane` (or `pane.split` without `pane`) threw a TypeError outside
  the try that settles the dispatch: the dispatch stayed open forever and the tab leaked.
- Fix: checked inside the try; the tab is closed and a `bad_result` error settles the dispatch.
- Test: `F14: tab.create without a root pane fails the start cleanly and closes the tab`.

### F15. A herdr error while clearing the folder-trust dialog aborted a recorded start
- Where: `src/workers.ts:498`.
- What: `clearStartupDialog()` caught every herdr call but `agentWait`. When it threw (herdr
  unreachable), `worker start` failed with a raw error after the task was already dispatched and the
  worker recorded, and without the "blocked on a dialog ... resend" warning that says how to recover.
- Fix: the wait failing is treated like a wait timeout; the dialog state is re-read and the usual
  warning returned.
- Test: `F15: agent.wait failing during the folder-trust dialog returns the blocked warning instead of throwing`.

Also, at the orchestrator's request: the unused `paneClose` import in `src/cli.ts` is gone;
`npx tsc -p . --noUnusedLocals --noUnusedParameters false` is clean for every file this review owns
(`src/sidebar.ts` still has `inverse` and `stateFile` unused; that file belongs to the other worker).

## Checked, not a bug

- **pane.list scope** (`src/inbox.ts:450`): with no `workspace_id`, herdr lists panes of every
  workspace (checked live: 13 panes across 5 workspaces), so workers in a worktree's own workspace
  are seen. Not a bug.
- **closeRun vs dispatch settlement vs archive vs worktree records** (`src/runs.ts:119-180`): phase 1
  fails dispatched tasks and settles every open dispatch of the run under the lock; releases then
  archive and set `archive_path` on the (already settled) dispatch; phase 3 forgets workers and sets
  `released_at` on their worktree records. `settleDispatch` never overwrites, so a late `done` cannot
  flip a closed run's dispatch. Only the prune race (F10) was wrong.
- **sync() doing liveness + stall + delivery + exit settlement in one pass** (`src/inbox.ts:446-556`):
  all state changes happen in one `update`; prompts are sent after the lock is released, each claimed
  first by `deliver()`. Exit settlement only fails a task that is still dispatched to *that* worker's
  current dispatch. Wrong only in the cases fixed as F1, F4, F8 and F9.
- **resolveRun allowClosed**: passed by exactly the read-only commands the guide lists (`run show`,
  `task list`, `task show`, `status`, `worker show`, `worker read`, `dispatch list|show`) and by
  `run close` (so closeRun can give its own "already closed" error). `run list` lists every run
  without resolving one. Every writing command, `check`, `send` and `worker list` refuse a closed run;
  worker commands check registration (closeRun forgets the run's workers) and `workerSend` checks the
  run itself.
- **Worker-to-worker followup to a released worker**: `send()` refuses an unregistered recipient
  under the lock; the remaining case (a followup queued before the release, delivered to a later
  worker of the same name) was F1.
- **done after a forced release or a run close**: refused ("not registered" or "already failed");
  `settleDispatch` keeps the first outcome. Not a bug.
- **Message pruning** (`src/inbox.ts:33`): never drops an unacked message, so an undelivered followup
  or unanswered ask survives the cap. Not a bug.
- **State-file races (b)**, the rest of them: every write goes through `update()`. The reads outside
  the lock are `ask --id` loading the stored options (read-only), `workerSend` validating the sender
  (re-validated where it matters, the recipient, under the lock), `resendPreamble` (no write before
  the prompt), `sendTo` expansion (F12) and `startWorker`'s two-phase claim (F5). `deliver()` claims
  before prompting and reverts on failure. `run prune` deletes archives after its update; with F10 no
  live close still writes there.

## Deferred

- **D1. A followup can be delivered twice** (`src/inbox.ts:384-406`): when `agent.prompt` times out
  after herdr actually delivered it, the claim is reverted and a later sync prompts it again.
  At-least-once is the safer failure than losing a followup; making it exactly-once needs a herdr
  delivery receipt. Deferred.
- **D2. A start that times out inside `worktree.create`** (`src/workers.ts:142`, 60 s timeout) may
  leave a checkout herdr finished creating after the timeout: F6 only undoes a checkout whose creation
  returned. Removing one herdr may still be writing is riskier than leaving it; the error names the
  failure and `--worktree PATH` can adopt it. Deferred.
- **D3. `ask` keeps polling after its worker was released** (`src/inbox.ts:208-221`): up to the
  10-minute timeout, then the worker is told to `ask --id` again. Harmless (the pane is normally
  closed with it), so left alone.
- **D4. A slow sync can apply an older herdr snapshot over a newer one** (`last_status`/`last_seq` go
  backwards for one pass): at worst a duplicate idle attention once the first was acked. Guarding on a
  lower `state_change_seq` assumes herdr's counter never resets when an agent restarts in a pane,
  which is not documented. Deferred.
- **D5. `--cwd` into another worker's worktree is not refused** (`src/workers.ts:98-101`): only
  `--worktree` starts are checked against each other. The guide's promise is about `--worktree`; a
  plain `--cwd` is the orchestrator's explicit choice. Deferred.
- **D6. `worker read` prints plain text for a live worker and JSON for an archived one** (`src/cli.ts:252-274`):
  changing either breaks a documented or existing shape; documenting it is the fix (see Guide changes).

## The preamble, read as a worker (e)

Read top to bottom as a fresh worker would (`src/workers.ts:18-42`). It is coherent: identity and
IDs, the one channel, then one rule per command in the order a worker needs them, then the spec.
Points checked against `docs/guide.md` "Worker obligations":
- The ask rule (10 min wait, `ask --id`, `--options`) matches the code (`600_000`) and the guide.
- "Do not start or steer other agents" sits next to "`lodestar send <worker>`": consistent, since
  a send informs, it does not steer; the guide words it the same way.
- The worktree line (branch or detached HEAD, install dependencies yourself) matches the worktree
  section of the guide.
- The redispatch contradiction was F13. The preamble does not explain the `ask` result fields
  (`answer`, `option_index`); the guide does, and a worker that offers `--options` sees them in the
  output. Not changed.

## Output shapes vs the guide (f)

Checked: `check` (`options`, `reply_hint` on an ask; `warning` only for herdr), the `check --wait`
stderr heartbeat line, `send` (`recipients` with `delivered`; a plain name keeps `message` and
`delivered`), `worker release` (`closed_pane`, `closed_tab`, `archive_path`/`archive_error`,
`worktree {path, branch, kept, removed}`), `worker list/show` rows (`liveness`, `attention`,
`next_action`, `worktree`), `dispatch list/show`, `task show` (`dispatch_ids`), `run prune`
(`pruned`, `removed`, `archives_removed`; `dry_run`). They match, apart from F11 and the additions
below.

## Guide changes needed

For the owner of `docs/guide.md` (and README where it repeats these). Exact wording:

1. In "Completion accounting", after the sentence listing what release prints, add:
   "If herdr fails to close the tab or pane, the release still completes and adds `close_error`
   naming what may still be open."
2. In "Completion accounting", after item 1 (reuse), add:
   "If `worker prompt` prints a `warning` (it exits 1), the dispatch is recorded but the worker may
   not have received it: read its screen, then `lodestar worker resend <name>`."
3. In "Messaging", after "the result lists every recipient with its `delivered` flag.", add:
   "A recipient released while a group send was going out is listed with an `error` and nothing is
   sent to it; the others still get theirs. A worker that has not yet received its dispatch prompt
   (still starting, or its prompt failed) gets followups only afterwards, even with `--now`."
4. In "Messaging", after the `--ack ID[,ID]` sentence, add:
   "An `--ack` that matches nothing adds `acked: 0` and `ack_warning` to the same result."
5. In "Closing and pruning runs", after "Active runs are never pruned,", add:
   "nor is a run closed less than an hour ago whose workers a `run close` is still releasing; it is
   listed under `skipped` with the command to finish it (`lodestar run close --run <id> --force`),"
6. In "Authority and safety floor", replace "All commands print JSON. Read IDs from the output; do not
   predict them." with:
   "Commands print JSON (except `skill`, `help`, `dispatch show --preamble`, `status` on a terminal,
   and `worker read` of a live worker, which prints its screen as text). Read IDs from the output; do
   not predict them."
7. In "Authority and safety floor", replace "A redispatch in an existing session carries new IDs in
   its preamble, and the worker passes them as `--task` and `--dispatch`." with:
   "A redispatch in an existing session says in its preamble's second line that the pane environment
   names the previous dispatch, and gives the `--task` and `--dispatch` flags to pass instead."
