# Pack Leader orchestration

Pack Leader is the coordination layer for a pack of coding agents inside herdr. It
records who owns which task, which attempt is authoritative, and what each
worker reported, in a state file outside every agent's context. The
orchestrator is the agent the user talks to; workers are agents Pack Leader starts in
their own hidden herdr tabs (or a split beside the orchestrator). The only channel between them is the `pack-leader` CLI.

## Outcome

**Result:** every task in the run has one explicit outcome, and every worker
that settled was reused, retained, or released. **Done:** the turn ends only
with a report to the user that names, per task, its outcome, the evidence
behind it, and any unresolved blocker.

**Safe failure:** when a worker's state is unclear, read its screen and report
the state as unknown. Only a `done` report, or positive proof that the agent
stopped, settles a task. Timeouts and empty waits are checkpoints, not
failures.

## Classify your role

| Your situation                                                       | Role         | What to do                                                       |
| -------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------- |
| The user asks to delegate, fan out, supervise, or coordinate workers | Orchestrator | Run the supervised loop below                                    |
| Your prompt starts with `[pack-leader dispatch]`                            | Worker       | Follow the preamble and the worker obligations below             |
| Neither                                                              | Plain agent  | Do not run pack-leader lifecycle commands                               |

Never substitute a built-in subagent tool for Pack Leader when the user asked for
Pack Leader, a pack, or supervised workers: those run inside your context and leave
no state the user can see in the sidebar.

## Authority and safety floor

- A run is a namespace bound to the orchestrator's pane. A task is work. A
  dispatch is one authoritative attempt at a task by one worker.
- Task state changes only through `pack-leader done` (from the worker), or through
  `pack-leader task update` and `pack-leader worker release --force` (from the orchestrator).
  `task update` refuses a dispatched task, and a succeeded one unless `--force`;
  setting a task back to `pending` clears its worker, dispatch and outcome.
  A pane title, a worker's screen, or an idle badge proves nothing by itself.
- Workers get their IDs from the pane environment; the orchestrator never
  needs to copy them. A redispatch in an existing session says in its preamble's second line that the pane environment
  names the previous dispatch, and gives the `--task` and `--dispatch` flags to pass instead.
- Commands print JSON (except `skill`, `help`, `dispatch show --preamble`, `status` on a terminal,
  and `worker read` of a live worker, which prints its screen as text). Read IDs from the output; do
  not predict them.
- herdr commands remain available (`herdr agent read`, `herdr pane ...`); use
  them to inspect, not to bypass Pack Leader's lifecycle.
- Never close panes you did not create. `pack-leader worker release` closes only the
  tab (or split pane) Pack Leader created for that worker.

## Orchestrator: the supervised loop

Bind one run, start the whole independent wave, then wait:

```bash
pack-leader run create --objective "<what the user wants done>"
pack-leader worker start api  --spec "<self-contained task spec>"
pack-leader worker start docs --spec "<self-contained task spec>"
pack-leader check --wait --timeout 540000
```

If `worker start` returns a `warning` that the worker is blocked on a dialog,
it never received its task: read its screen, answer the dialog only when it is
plainly safe (Pack Leader already accepts Claude Code's folder-trust check on
its own), then `pack-leader worker resend <name>`.

`run create` opens the Pack Leader sidebar next to you and an observer agent
under you (`--no-observer` skips it): a second agent the user talks to about
the run, which reads `pack-leader observe` (state plus your last turns) and
never acts on the run. What the user tells it to pass on reaches you as a
`user` message in `check`. Leave the observer alone: it is not a worker and
`worker list` does not show it. Each worker starts in a
hidden tab of its own; the sidebar shows it as a box (agent, runtime and
state, objective, last message: a heartbeat, a `note`, a report, an open
question with its options, or your answer) under the run's goal; a click
selects a box, Enter or a second click opens its tab, and `o` (or the "Pack
Leader: back to the leader" action) comes back. With placement "beside the
leader" in the settings (or `--placement split`), there is no sidebar: you keep
the top left, the observer the bottom left, and workers fill the right half of
your tab, each new one splitting the biggest worker the other way; a released
worker's neighbour takes its space. Pass `--placement split` yourself only when
the user wants to watch a worker next to you.
Never open, focus, or close worker tabs yourself; `pack-leader worker focus <name>`
shows one when the user asks.

`pack-leader check --wait` blocks until the oldest unread message arrives, so give
the shell tool a timeout at least as long (10 minutes is the usual ceiling).
A `timeout` result is a checkpoint: look at `pack-leader status`, then wait again.

Never poll. Every `check` that comes back costs you a full model call on your
whole context, and a bare `check` or a short `--timeout` comes back with nothing
new almost every time. `check --wait` returns the moment a message arrives, so a
long timeout costs nothing: always `--wait --timeout 540000`. A `--wait` with a
timeout under 5 minutes is raised to 5 minutes (`PACK_MIN_WAIT_MS`), and the
result says so. The only reason to run `check` without `--wait` is to read a
message you were just told about.
While it waits, `check --wait` writes one JSON line to stderr every 15 s,
`{"waiting":true,"elapsed_ms":n,"pending":n,"workers":{"api":"live"}}`
(`pending` counts dispatched tasks still owing a report); stdout stays the single
final result. `PACK_WAIT_HEARTBEAT_MS` sets the interval, `0` turns it off.

Process every message as the Messaging section below says, acknowledge it, and
wait for the next:

```bash
pack-leader reply m7 --body "Use the existing helper in src/net.ts; do not add a dependency."
pack-leader check --ack m7 --wait --timeout 540000
```

Use `pack-leader task create` with `--depends-on` for planned fan-out with ordering,
then `pack-leader worker start <name> --task <id>` when `pack-leader task list` shows the
task ready. A dependency that is already `failed` or `blocked` is accepted with a
`warning`: the new task waits until it succeeds. Prefer parallel waves over chains deeper than three steps.

Task parent links are provenance and tree organization only: they do not block readiness,
complete a parent automatically, or authorize a worker to spawn children. For example,
decompose a larger task into records, inspect the tree, then dispatch each ready task
independently:

```bash
pack-leader task create --spec "Implement account import" --title "Account import"
# Suppose the command prints t7.
pack-leader task create --spec "Parse the CSV input" --title "CSV parser" --parent t7
pack-leader task create --spec "Validate imported rows" --title "Row validation" --parent t7
pack-leader task tree t7
pack-leader worker start parser --task t8
pack-leader worker start validator --task t9
```

`task update t8 --parent t7` reparents a task; `--parent none` makes it a root.
Parent changes are coordinator-only, can be combined with `--status`, and are refused
while a task is dispatched or has an unsettled dispatch claim. Workers may still read
trees. `task show` includes its parent and direct child ids. Tree output reports subtree
status counts and diagnoses malformed legacy links; very deep output is bounded safely.

Keep waiting until every dispatched task has settled. Do not stop, release, or
start a duplicate worker without a `done` report or positive proof the agent
stopped (an `attention` message with status `exited`, or a screen that shows
the agent's final turn with no report).

### What each worker needs

`pack-leader worker list` (and `worker show`, `status`) tells you what each
worker needs. Every row has `liveness` (`live`: agent seen in its pane;
`unverifiable`: pane alive but no agent for 30 s; `exited`: pane missing from
two syncs in a row), `attention: {categories, requires_action}` from its
unacked messages (`ask`, an attention status, or `note`; a note alone requires
no action), and `next_action`: the literal argv to run next, or `null` when
nothing is required. Run it as given, filling in the `<...>` placeholder:

```json
["pack-leader", "reply", "m7", "--body", "<answer>"]                     open question
["pack-leader", "reply", "m9", "--body", "<one of: postgres | sqlite>"]  open question with options
["pack-leader", "worker", "read", "api"]                                 idle without a report, blocked, stalled, unverifiable
["pack-leader", "worker", "release", "api", "--force"]                   pane gone with its task open
```

A `warning` on `check`, `status` or `worker list` means herdr could not be
reached: liveness is as last seen, so do not release anything on it alone.
Heartbeats, asks, notes, worker sends, reports and any herdr state change
refresh a worker's `last_seen`; one of them after a `stalled` alert re-arms it.
Each row also shows the worker's `worktree`, when it has one.

### Handoff

With handoff on in the settings, `check --wait` first measures your own context.
Once it passes the limit, `check` returns `"result": "handoff"` with
`instructions` instead of waiting:

1. Write a note for the session that replaces you: the user's goal, every
   instruction, decision and constraint they gave you, anything you promised
   them, and what you were about to do next. Leave out tasks, workers, reports
   and messages: Pack Leader's state holds them.
2. Save it: `pack-leader handoff --body "<note>"`.
3. End your turn with one line saying you are handing off. Do not run `check`
   again; while the handoff is pending it only repeats `"status": "pending"`.

Pack Leader waits until you are idle, clears the session (`/clear` in Claude
Code, `/new` in pi; other harnesses are never asked to hand off), and prompts the fresh one with
`[pack-leader handoff]`, the run, and your note. Messages that arrive meanwhile
wait in the inbox, and an `--ack` on the `check` that returned the handoff is
already applied. A session that starts with `[pack-leader handoff]` is the
orchestrator: load this guide, run `pack-leader status`, then carry on the loop.
If you do not hand off after two requests, `check` waits normally again; a
failed handoff is reported to the user and not retried for that run.

## Messaging

`pack-leader check` returns the oldest unacked message for you; `--ack ID[,ID]`
acknowledges, and `--types` filters by `done`, `ask`, `attention`, `note` (the
default is all four; any other value is an error, raised before anything is
acked). An `--ack` that matches nothing adds `acked: 0` and `ack_warning` to the same result.
A bare `--ack` with no ids is an error; ids that are no message of the run are
listed in `ack_unknown`.

| `type`      | Meaning                                                   | Your move                                                                                |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `done`      | The worker settled its task (`outcome` succeeded/failed)  | Verify if needed, then reuse (`pack-leader worker prompt`), `retain`, or `release` the worker |
| `ask`       | The worker is blocked on a question. With `options`, `check` adds them and a `reply_hint` to paste | `pack-leader reply <id> --body "<answer>"`; with `options`, name one (exactly or by a unique case-insensitive prefix) or add `--free` to answer outside them |
| `attention` | The worker settled, vanished, or went quiet without reporting; `status` says which: `idle`/`done`, `blocked`, `exited` (pane gone), `unverifiable` (agent gone, pane alive), `stalled` (owes a report, no sign of life for `PACK_STALL_MS`, default 20 min, `0` off; never while its question is open) | `pack-leader worker read <name>`; re-prompt it to run `pack-leader done`, or release with `--force` |
| `note`      | A non-blocking line from a worker that keeps working      | Read it, act if needed (a `send`, a new task), then ack it                               |
| `user`      | A line from the human (`pack-leader say`, often relayed by the observer) | It is an instruction, not a report: act on it, then ack it                   |

A reply to an ask with options must name one of them; anything else is an
error that lists the options and leaves the ask open. Pass `--free` only when
none of them fits:

```bash
pack-leader reply m9 --body "sq"                                   # sqlite, by prefix
pack-leader reply m9 --free --body "Neither: keep the JSON file."
```

`pack-leader send ADDRESS "text" [--now]` gives a worker a follow-up: delivered
straight into its prompt when it is ready for input (or at once with `--now`),
otherwise queued for its next `pack-leader inbox` checkpoint. The address is a
worker name or a group, expanded when you send; each recipient gets its own
follow-up, and the result lists every recipient with its `delivered` flag.
A recipient released while a group send was going out is listed with an `error` and nothing is
sent to it; the others still get theirs. A worker that has not yet received its dispatch prompt
(still starting, or its prompt failed) gets followups only afterwards, even with `--now`.

| Address    | Recipients (in this run)                                  |
| ---------- | --------------------------------------------------------- |
| `api`      | that worker                                               |
| `@all`     | every worker that still owes a report (task dispatched)   |
| `@idle`    | every worker herdr shows idle or done right now           |
| `@<kind>`  | every worker of that kind, e.g. `@claude`                 |

An address that matches nobody is an error that says why; nothing is sent.
Group addresses apply to `send` only, never to done, ask, or heartbeat.

Workers have two non-blocking channels besides `ask`:

- `pack-leader note "text"` stores a `note` for you: it arrives in `check`
  like a report (ack it with `--ack`), nudges an idle orchestrator once, and
  shows on the worker's sidebar box. The worker keeps working.
- `pack-leader send <worker> "text"` from a worker pane reaches another worker
  of the same run, prefixed `[pack-leader follow-up from worker <sender>]`. A
  worker cannot send to itself, to another run, or to a group address.

`blocked` is raised even after a worker reported (for example a permission
prompt while it handles a follow-up). An orchestrator that sits idle with unread
reports, questions or notes older than a minute is nudged once more
(`PACK_RENUDGE_MS`).

## Durable task approval gates

Gates are coordinator-owned records, separate from task status and worker `ask`/`reply` messages. Each stores its run/task, reason, coordinator creator, creation time, status, and (after resolution) the explicit decision, time, and optional reason. Create one for any non-dispatched task, including a task between settled stages:

```text
pack-leader gate create --task t4 --reason "Review the migration plan before retrying"
pack-leader gate list [--task t4]
pack-leader gate show g5
pack-leader gate resolve g5 --decision approve|reject [--reason "..."]
```

A pending or rejected gate blocks every new dispatch, including a failed-task retry and a redispatch; all gates on the task must be approved. Task readiness, task summaries, worker views, and run status show gate blockers. Approval releases only that gate. Rejection remains a blocker and does not change the task's status. `task update` cannot bypass a gate: returning a task to pending leaves the gate in place. A task already dispatched, or accepted for start but not yet registered, cannot receive a new gate; gate creation and start admission serialize under the state lock.

Gate creation and resolution require the active run's coordinator. Decisions are explicit and immutable; repeating the same decision is an idempotent retry, while trying to change an approved/rejected decision fails. Gate list/show are read-only and work for closed runs until pruning removes the run. Existing v1 state files load with no gates, and pruning removes gates with their run.

## Task-spec contract

Every spec must be self-contained. Name:

- **Target:** the files, component, or environment in scope.
- **Change:** the concrete result to produce.
- **Constraints:** invariants, compatibility rules, do-not-touch boundaries.
- **Ownership:** what this worker may edit; what belongs to another worker.
- **Observable acceptance:** the test, output, or evidence that proves completion.

Two workers must never own the same files. When their edits could collide,
give each its own git worktree with `--worktree`: `pack-leader worker start <name> --worktree new`
creates one next to the repo (`<repo parent>/<repo>-wt/<name>`, or
`$PACK_WORKTREE_DIR/<name>`) on branch `pack/<run>/<name>` from the current
HEAD (`--base <ref>` and `--branch <name>` override), opens it as a herdr
workspace, and starts the worker there. `--worktree <path>` reuses an existing
checkout instead. The run's cwd (or `--cwd`) must be inside a git repo. Nothing
is installed or copied into a new worktree; the preamble tells the worker its
path and branch, to commit on that branch, and to install dependencies itself.
Pack Leader refuses to start two workers in the same worktree.

An optional `--setup-command "..."` is an explicit authorization to execute that
shell command in the materialized worktree before the worker agent starts. It is
disabled by default, requires `--worktree new|PATH`, and is never discovered from
repository scripts. For `--worktree PATH`, it runs in that existing checkout too;
Pack Leader does not clean up or delete an adopted or dirty checkout if setup fails.
`--setup-timeout MS` applies only with a setup command (default 120000, maximum
300000). The bounded stdout/stderr log is private under Pack Leader's state
folder; its path and truncation status are saved on the dispatch. A nonzero exit,
timeout, or spawn/log failure prevents both agent launch and task prompt. The hook
runs once for that `worker start`, not on later `worker prompt` redispatches.
Setup is not sandboxed: a descendant that deliberately escapes its process group
may outlive the timeout, but Pack Leader bounds its wait, closes local output
pipes, and records incomplete cleanup in the dispatch metadata.

`pack-leader worker release` removes a clean worktree Pack Leader created,
together with its workspace, by default, and prints its path and branch; the
branch is never deleted, so the work stays reachable and you merge it from the
main checkout. The accepted `--remove-worktree` flag is a legacy alias for this
default behavior. Do not pass `--keep-worktree` to "keep the work": the branch
already does that. Pass it only when the user asked to keep the checkout. A
worktree is also kept when it has uncommitted changes (never forced), when the
pane stays open (`--keep-pane` or a retained worker), or when it was an existing
checkout (`--worktree <path>`).

Automatic cleanup is fail-closed: a checkout is eligible only after its owned
pane is confirmed closed or herdr confirms it is already missing. A forgotten
worker (`run close` without `--release`), a retained/kept pane, an uncertain
close failure, or an interrupted release remains protected across repeated
sweeps and run pruning. Inspect the pane and checkout before manual recovery; if
no process still uses it, remove a clean checkout yourself with `git worktree
remove <path>` (do not use `--force` for dirty work). A protected worktree record
is retained through run pruning so Pack Leader cannot later mistake it for a
released checkout.
`worker list`, `worker show` and `status` show each worker's worktree.

## Completion accounting

After an accepted `done` report, do exactly one:

1. Reuse the worker for the next task: `pack-leader worker prompt <name> --spec "..."`.
   It waits up to 30 s for the worker to be idle; if it stays busy, nothing is
   dispatched. `--task` must have its dependencies met. If the prompt does not go
   in, the dispatch is rolled back (the task and the worker are as before) and the
   command fails: run it again. If it prints a `warning` instead (it exits 1), the
   dispatch is recorded but the worker may not have received it: read its screen,
   then `pack-leader worker resend <name>`.
2. Record user-requested retention: `pack-leader worker retain <name>`.
3. Clean up: `pack-leader worker release <name>`.

Release is post-settlement cleanup, not cancellation. It saves the worker's
screen to the state dir first, then closes the tab or pane Pack Leader created,
and prints `closed_pane`, `closed_tab` (a hidden worker's whole tab goes),
`archive_path` (or `archive_error`; the release completes either way) and, for a
worker in a worktree, `worktree: {path, branch, kept, removed}`.
If herdr fails to close the tab or pane, the release still completes and adds `close_error`
naming what may still be open. Followups and replies the worker never received
are dropped with it (the same on `run close`). To interrupt a
worker mid-turn use `pack-leader worker stop <name>`, inspect it, and decide.
When the run is finished, `pack-leader run close --release` releases what is left.

## Dispatch records

Every dispatch (`worker start`, `worker prompt`) is recorded with the exact
preamble the worker received, its attempt number, `retry_of` when it retries a
failed task, and its outcome once `done`, a forced release, or a worker exiting
settles it (closing the run settles any still open, as failed).
`pack-leader dispatch list [--task ID] [--worker NAME]` lists the run's
dispatches; `pack-leader dispatch show ID --preamble` prints exactly what a
worker was told. Both work on a closed run until it is pruned. Release saves
the worker's screen before closing its tab, so `pack-leader worker read <name>`
still works afterwards: it answers with `source: "archive"` (`--dispatch ID`
picks a specific one). `task show` lists a task's `dispatch_ids`.

## Closing and pruning runs

`pack-leader run close` ends the run for good:

- It refuses while a worker still has a dispatched task. Wait for the reports,
  or pass `--release` to release every worker (their tasks are marked failed
  with "run closed", their dispatches settled, and each screen archived as on
  a normal release; their clean checkouts are removed), or `--force` to close anyway.
- It closes the run's sidebar pane, unless another active run still shows it,
  and forgets the run's workers. Without `--release` their panes stay open and
  are listed under `forgotten`.
- A closed run cannot be closed again without `--force`, and cannot be written
  to: `--run <id>` or `PACK_RUN_ID` naming it is an error, except for the
  read-only `run show`, `run list`, `task show`, `task list`, `status`,
  `worker show`, `worker read`, `dispatch list|show` and `gate list|show`.

`run close` ends with garbage collection: closed runs past the 5 most recent
go with their records and archives, and every released checkout Pack Leader
created is removed with its workspace, unless it was kept on request, a worker
still uses it, or it has uncommitted changes (never forced). `pack-leader run
prune` does the same on demand and reports it under `worktrees`. It keeps the 5
most recently closed runs and deletes the rest with every record that
carries their run id (tasks, workers, messages, dispatches, gates, worktree records)
and their screen archives; `--keep N` changes the 5, `--older-than 2d` (units `s m h d w`)
deletes only runs closed longer ago than that (all of them unless `--keep` is
also given), `--all` deletes every closed run, and `--dry-run` prints what
would go (it touches neither the state nor the archives). Active runs are
never pruned, nor is a run closed less than an hour ago whose workers a `run close` is still releasing; it is
listed under `skipped` with the command to finish it (`pack-leader run close --run <id> --force`). `run prune` also removes eligible released, clean checkouts Pack Leader created; live, forgotten, protected, existing, or dirty checkouts are left in place. Its dry run classifies dirty checkouts as kept without writing state or lock files. `pack-leader status` counts closed runs;
`status --all` lists them.

Commands that name a task or worker (`task show`, `task tree`, `task update`,
`worker show`, `read`, `focus`, `stop`, `retain`) only find it in the current run.

## Worker obligations

Your `[pack-leader dispatch]` preamble is authoritative. You must:

1. Do only the current task, in the given directory. Do not start or steer
   other agents.
2. Ask the orchestrator blocking questions with `pack-leader ask "<question>"`. It
   waits for the answer; after a timeout, `pack-leader ask --id <id>` keeps waiting
   (only your own ask; an id that is not yours fails at once, and if you already
   collected its answer the error repeats it; if you are released while waiting,
   `ask` stops). Never stop on a question the orchestrator cannot see. When the answer is
   one of a few choices, offer them: `pack-leader ask "<question>" --options "a,b,c"`.
   The result's `answer` is the chosen option and `option_index` its position
   (null when the orchestrator answered outside them with `--free`; then read
   `reply`), so branch on those.
3. Read follow-ups at natural checkpoints (before starting a new file, after a
   test run) and once more right before reporting: `pack-leader inbox`.
4. During long work, about every ten minutes: `pack-leader heartbeat "<one line>"`.
   For a blocker you can work around, a finding the orchestrator should know,
   or "I am taking longer because ...", use `pack-leader note "<text>"`: it reaches
   the orchestrator's inbox without stopping you. Use `ask` only when you
   cannot continue without the answer. When another worker of the run needs
   to know something, `pack-leader send <worker> "<text>"` reaches it as a
   follow-up. In a worktree of your own, commit on the branch the preamble names.
5. Report exactly once, with an explicit outcome:
   `pack-leader done --outcome succeeded|failed --summary "<three sentences: what changed, how it was verified, what is left>" [--files-modified a,b] [--report-path <file>]`.
   Say `failed` when the acceptance check did not pass; never encode failure
   only in prose. A relative `--report-path` is stored as an absolute path,
   resolved against the directory you run `done` in.
6. After `pack-leader done`, end your turn and wait. A new `[pack-leader dispatch]` prompt
   or a follow-up from the orchestrator starts new work; a direct instruction
   from the user takes precedence over waiting.

## Commands

```text
# runs
pack-leader run create --objective "..." [--no-sidebar] [--no-observer] [--left] [--another] [--cwd D] | show | list
pack-leader run close [--release] [--force]
pack-leader run prune [--keep N] [--older-than 2d] [--all] [--dry-run]
pack-leader status [--json] [--all]
pack-leader COMMAND ... [--run ID]
# tasks
pack-leader task create --spec "..." [--title T] [--depends-on a,b] [--parent ID]
pack-leader task list | show ID | tree [ID] | update ID [--status S] [--parent ID|none] [--summary S] [--force]
# approval gates (coordinator only)
pack-leader gate create --task ID --reason TEXT
pack-leader gate list [--task ID] | show ID
pack-leader gate resolve ID --decision approve|reject [--reason TEXT]
# workers
pack-leader worker start NAME --spec "..." | --task ID [--retry] [--kind claude] [--model M] [--thinking L] [--cwd D] [--placement tab|split] [--host NAME]
                         [--direction right|down] [--worktree new|PATH [--base REF] [--branch B]] [--setup-command STRING [--setup-timeout MS]] [--title T] [--target-pane P]
                         [--ratio R] [--no-default-args] [--timeout MS] [-- agent args]
pack-leader worker adopt NAME --task ID | --spec TEXT [--title TEXT] [--target-pane P]
pack-leader worker prompt NAME --spec "..." [--title T] | --task ID | resend NAME
pack-leader worker list | show NAME | read NAME [--lines N] [--dispatch ID] | focus NAME | stop NAME | retain NAME
pack-leader worker release NAME [--force] [--keep-pane] [--remove-worktree] [--keep-worktree]
pack-leader host add NAME --ssh-target ALIAS_OR_USER@HOST --workspace-id ID --leader-ssh-target TARGET [--herdr-socket PATH] [--pack-leader BIN] [--leader-pack-leader BIN]
pack-leader host list | show NAME | remove NAME
pack-leader dispatch list [--task ID] [--worker NAME] | show ID [--preamble]
# messaging
pack-leader check [--wait] [--timeout MS] [--ack ID[,ID]] [--types done,ask,attention,note]
pack-leader reply ASK_ID --body "..." [--free]
pack-leader say "text" | --body "..."
pack-leader send NAME|@all|@idle|@KIND "text" | --body "..." [--now]
pack-leader handoff --body "<note>"
# worker side (adopted sessions use the explicit context prefix in their preamble)
pack-leader done --outcome succeeded|failed --summary "..." [--files-modified a,b] [--report-path P]
pack-leader ask "question" | --body "..." [--options a,b,c] [--timeout MS] | ask --id ID
pack-leader note "text" | --body "..." | send WORKER "text" | --body "..." [--now] | heartbeat "note" | --body "..." | inbox
pack-leader WORKER-COMMAND ... [--worker NAME] [--run ID] [--task ID] [--dispatch ID]
# either
pack-leader config [show] | pick | set [--kind K] [--model M] [--thinking L] [--clear-model] [--clear-thinking] [--default]
                   [--placement tab|split] [--worktree-mode on|off|leader] [--observer on|off] [--stall-minutes N] [--handoff on|off] [--handoff-at TOKENS]
pack-leader settings | skill [--install] | sidebar | leader [--run ID] | observe [--turns N] | observer [--close] | help
```

`pack-leader help` prints the same commands and flags, with a note on each. Flags are validated for the selected command before it can touch state, archives, herdr, or configuration: unknown options fail with a spelling suggestion when one is likely, and options that take a value (including `--keep` and `--timeout`) fail if the value is missing. Boolean switches reject `=value` forms rather than silently treating them as enabled. List-valued options may be repeated or comma-separated.

A flag value that itself starts with `--` must be written `--flag=value` (`--spec=--x`), or it is read as the next flag. `--body`, `--summary`, and `--setup-command` are free text and take the next word whatever it is (`reply m5 --body "--no"`). The `--` separator ends Pack Leader flag parsing; for example, `worker start ... -- --model x` passes those native agent arguments through unchanged.

What the less obvious flags do:

- `COMMAND ... --run ID`: any orchestrator command acts on that run instead of
  the pane's own (`PACK_RUN_ID` does the same).
- `run create`: `--another` binds a second run to a pane that already has one;
  `--left` opens the sidebar on the left; `--cwd D` must be an existing
  directory and is stored as an absolute path.
- `task update`: `--summary S` records an outcome summary; `--force` lets a
  succeeded task change status (otherwise refused); neither bypasses an unapproved gate.
  `--parent ID|none` changes provenance independently of status; dispatched or
  actively claimed tasks cannot be reparented.
- `config set`: `--default` records the selected kind as the default (without
  `--kind`, the current/default kind is selected). `--kind K` also selects that
  kind as the default. The other flags store what the settings page shows:
  `--placement` and `--worktree-mode` for new workers, `--observer` for
  `run create`, `--stall-minutes N` (0 is off; `PACK_STALL_MS` still wins), and
  `--handoff`/`--handoff-at` (a token count such as `200000`, `200k` or `1m`).
  Flags on the command itself still win over the stored values.
- `worker start`: `--title T` (task title for `--spec`), `--target-pane P` and
  `--ratio R` (with `--placement split`), `--no-default-args` (no
  `--allowedTools` for the agent), `--timeout MS` (agent start, default 45000), and
  `--setup-command STRING` (explicit shell authorization, only with `--worktree`,
  once before agent launch; `--setup-timeout MS` defaults to 120000, max 300000).
  Setup output is privately logged with a 256 KiB cap; failures block launch and
  preserve dirty or existing checkouts. Setup is not rerun on `worker prompt`.
  A split without `--target-pane`, `--direction` or `--ratio` joins the right
  half; with any of them it splits that one pane (right unless `--direction`).
  `--direction` with `--placement tab` is an error. `--host NAME --cwd /remote/path` starts in an existing remote
  workspace; it accepts tab placement only and rejects worktree/setup options before dispatch.
- `worker adopt NAME`: attach to one existing named herdr agent only when it is
  idle or done. `--target-pane P` selects the exact pane when names are duplicated;
  without it, the name must match one live agent. The session is never restarted,
  renamed, or moved, and release never closes its pane or tab. Adopted sessions do
  not inherit Pack Leader's `PACK_*` environment: every dispatch and redispatch
  includes a shell-quoted `env PACK_ROLE=worker ... pack-leader` prefix with the
  current run, worker, task, dispatch, and state-directory values; use it before
  each worker command.
- `WORKER-COMMAND` is `done`, `ask`, `heartbeat`, `note`, `send` or `inbox`:
  `--run`, `--worker`, `--task`, `--dispatch` override the IDs from the environment
  (orchestrator `send` accepts `--run` only); `ask`, `heartbeat`, `note` and
  `send` also take the text as `--body "..."`.
- `host add NAME`: stores a trusted SSH profile in `hosts.json` under Pack Leader
  configuration. `--ssh-target` is an SSH config alias or `user@host`, and
  `--leader-ssh-target` is the reciprocal target the remote worker uses to call
  back to this leader. No password or private key is stored. `--pack-leader` and
  `--leader-pack-leader` name the remote and leader executable paths; the optional
  `--herdr-socket` selects the remote Unix socket. Adding a profile does not
  contact the host; `host show/list/remove` manage profiles.
- Remote prerequisites: both machines need OpenSSH public-key/agent access in
  **both directions** (leader → execution host and execution host → leader),
  pre-approved host keys, `BatchMode`-compatible authentication, Node and Pack
  Leader/herdr installed on the execution host, and an already-open remote herdr
  workspace. The remote CLI helper only relays allowlisted herdr RPCs over SSH;
  worker callbacks are limited to done/ask/note/heartbeat/send/inbox and write
  the leader's authoritative local state. The relay pins the leader's resolved
  state directory/socket before startup; relative `--report-path` values resolve
  against the remote worker cwd. If `--herdr-socket` is omitted, the helper uses
  the remote host's normal `herdrSocketPath()` fallback. SSH is the authentication
  boundary; there is no TCP state/API listener.
- Host profiles are snapshotted into each remote worker and dispatch. Editing or
  removing a profile affects future starts, not in-flight worker operations.
  Remote pane/workspace IDs are scoped to their host. On disconnect, remote
  liveness becomes `unreachable`; tasks are preserved and never inferred exited.
  Remote release is fenced against remote redispatch/resend across SSH preflight,
  archive, close and state removal; state locks are not held over network I/O.
  SSH timeouts/output limits use bounded TERM/KILL and close local pipes, but this
  is not a process sandbox and the remote request may already have been accepted.
  Remote worktree creation/removal, local setup hooks, and adoption are not
  supported; use a directory that already exists on the remote host. Without a
  configured SSH host, real remote end-to-end operation cannot be verified.
- Run by herdr, not by agents: `sidebar-open [--left] [--no-focus]` and `leader`
  (plugin actions; `leader` focuses the orchestrator of the run the focused
  pane belongs to) and `event pane.closed|pane.exited|tab.closed` (plugin events).
