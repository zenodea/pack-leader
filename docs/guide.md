# Pack Leader orchestration

Pack Leader is the coordination layer for a pack of coding agents inside herdr. It
records who owns which task, which attempt is authoritative, and what each
worker reported, in a state file outside every agent's context. The
orchestrator is the agent the user talks to; workers are agents Pack Leader starts in
sibling panes. The only channel between them is the `pack-leader` CLI.

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
  A pane title, a worker's screen, or an idle badge proves nothing by itself.
- Workers get their IDs from the pane environment; the orchestrator never
  needs to copy them. A redispatch in an existing session carries new IDs in
  its preamble, and the worker passes them as `--task` and `--dispatch`.
- All commands print JSON. Read IDs from the output; do not predict them.
- herdr commands remain available (`herdr agent read`, `herdr pane ...`); use
  them to inspect, not to bypass Pack Leader's lifecycle.
- Never close panes you did not create. `pack-leader worker release` closes only the
  pane Pack Leader split for that worker.

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

`run create` opens the Pack Leader sidebar next to you. Each worker starts in a
hidden tab of its own; the sidebar shows it as a box (agent, runtime,
objective, last message) and Enter there opens its tab. Pass
`--placement split` only when the user wants to watch a worker next to you.
Never open, focus, or close worker tabs yourself; `pack-leader worker focus <name>`
shows one when the user asks.

`pack-leader check --wait` blocks until the oldest unread message arrives, so give
the shell tool a timeout at least as long (10 minutes is the usual ceiling).
A `timeout` result is a checkpoint: look at `pack-leader status`, then wait again.
While it waits, `check --wait` writes one JSON line to stderr every 15 s,
`{"waiting":true,"elapsed_ms":n,"pending":n,"workers":{"api":"live"}}`
(`pending` counts dispatched tasks still owing a report); stdout stays the single
final result. `PACK_WAIT_HEARTBEAT_MS` sets the interval, `0` turns it off.

Process every message, then acknowledge it and wait for the next:

| `type`      | Meaning                                                   | Your move                                                                                |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `done`      | The worker settled its task (`outcome` succeeded/failed)  | Verify if needed, then reuse (`pack-leader worker prompt`), `retain`, or `release` the worker  |
| `ask`       | The worker is blocked on a question                       | `pack-leader reply <id> --body "<answer>"`; with `options`, paste `reply_hint` or name one option (a unique prefix works), or add `--free` to answer outside them |
| `attention` | The worker settled, vanished, or went quiet without reporting; `status` says which: `idle`/`done`, `blocked`, `exited` (pane gone), `unverifiable` (agent gone, pane alive), `stalled` (no sign of life for `PACK_STALL_MS`, default 20 min) | `pack-leader worker read <name>`; re-prompt it to run `pack-leader done`, or release with `--force`    |
| `note`      | A non-blocking line from a worker that keeps working      | Read it, act if needed (a `send`, a new task), then ack it                               |

```bash
pack-leader reply m7 --body "Use the existing helper in src/net.ts; do not add a dependency."
pack-leader check --ack m7 --wait --timeout 540000
```

`pack-leader worker list` (and `worker show`, `status`) tells you what each
worker needs. Every row has `liveness` (`live`: agent seen in its pane;
`unverifiable`: pane alive but no agent for 30 s; `exited`: pane missing from
two syncs in a row), `attention: {categories, requires_action}` from its
unacked asks and alerts, and `next_action`: the literal argv to run next, or
`null` when nothing is required. Run it as given, filling in `<answer>`:

```json
["pack-leader", "reply", "m7", "--body", "<answer>"]     open question
["pack-leader", "worker", "read", "api"]                 idle without a report, blocked, stalled, unverifiable
["pack-leader", "worker", "release", "api", "--force"]   pane gone with its task open
```

A `warning` on `check`, `status` or `worker list` means herdr could not be
reached: liveness is as last seen, so do not release anything on it alone.
Heartbeats, asks, reports and any herdr state change refresh a worker's
`last_seen`; a heartbeat after a `stalled` alert re-arms it.

An `ask` whose worker offered choices carries `options`, and `check` adds a
`reply_hint` to paste. The body must match one option exactly or by a unique
case-insensitive prefix; anything else is an error that lists the options.
Pass `--free` only when none of them fits:

```bash
pack-leader reply m9 --body "sqlite"
pack-leader reply m9 --free --body "Neither: keep the JSON file."
```

Use `pack-leader task create` with `--depends-on` for planned fan-out with ordering,
then `pack-leader worker start <name> --task <id>` when `pack-leader task list` shows the
task ready. Prefer parallel waves over chains deeper than three steps.

Follow-ups to a busy worker go through `pack-leader send <name> "text"`: delivered
straight into its prompt when it is ready for input, otherwise queued for its
next `pack-leader inbox` checkpoint.

### Messaging

`pack-leader send ADDRESS "text" [--now]` takes a worker name or a group address.
The address is expanded when you send, and each recipient gets its own
follow-up with the usual delivery (prompted at once when idle or with `--now`,
otherwise queued for its next `pack-leader inbox`). The result lists every
recipient with its `delivered` flag.

| Address    | Recipients (in this run)                                  |
| ---------- | --------------------------------------------------------- |
| `api`      | that worker                                               |
| `@all`     | every worker that still owes a report (task dispatched)   |
| `@idle`    | every worker herdr shows idle or done right now           |
| `@<kind>`  | every worker of that kind, e.g. `@claude`                 |

An address that matches nobody is an error that says why; nothing is sent.
Group addresses apply to `send` only, never to done, ask, or heartbeat.

Workers have two non-blocking channels besides `ask`:

- `pack-leader note "text"` stores a `note` for the orchestrator: it arrives in
  `pack-leader check` like a report (ack it with `--ack`), nudges an idle
  orchestrator once, and shows on the worker's sidebar box. The worker keeps
  working.
- `pack-leader send <worker> "text"` from a worker pane reaches another worker
  of the same run, prefixed `[pack-leader follow-up from worker <sender>]`. A
  worker cannot send to itself, to another run, or to a group address.

`pack-leader check --types` filters by `done`, `ask`, `attention`, `note` (the
default is all four); any other value is an error.

Keep waiting until every dispatched task has settled. Do not stop, release, or
start a duplicate worker without a `done` report or positive proof the agent
stopped (an `attention` message with status `exited`, or a screen that shows
the agent's final turn with no report).

## Task-spec contract

Every spec must be self-contained. Name:

- **Target:** the files, component, or environment in scope.
- **Change:** the concrete result to produce.
- **Constraints:** invariants, compatibility rules, do-not-touch boundaries.
- **Ownership:** what this worker may edit; what belongs to another worker.
- **Observable acceptance:** the test, output, or evidence that proves completion.

Two workers must never own the same files. Give each worker its own cwd (or
git worktree, via `herdr worktree create`) when their edits could collide.

## Completion accounting

After an accepted `done` report, do exactly one:

1. Reuse the worker for the next task: `pack-leader worker prompt <name> --spec "..."`.
2. Record user-requested retention: `pack-leader worker retain <name>`.
3. Clean up: `pack-leader worker release <name>`.

Release is post-settlement cleanup, not cancellation. To interrupt a worker
mid-turn use `pack-leader worker stop <name>`, inspect it, and decide. When the run
is finished, `pack-leader run close --release` releases what is left.

## Dispatch records

Every dispatch (`worker start`, `worker prompt`) is recorded with the exact
preamble the worker received, its attempt number, `retry_of` when it retries a
failed task, and its outcome once `done`, a forced release, or a worker exiting
settles it. `pack-leader dispatch list [--task ID] [--worker NAME]` lists the
run's dispatches; `pack-leader dispatch show ID --preamble` prints exactly what a
worker was told. Release saves the worker's screen before closing its tab, so
`pack-leader worker read <name>` still works afterwards: it answers with
`source: "archive"` (`--dispatch ID` picks a specific one).

## Closing and pruning runs

`pack-leader run close` ends the run for good:

- It refuses while a worker still has a dispatched task. Wait for the reports,
  or pass `--release` to release every worker (their tasks are marked failed
  with "run closed"), or `--force` to close anyway.
- It closes the run's sidebar pane, unless another active run still shows it,
  and forgets the run's workers. Without `--release` their panes stay open and
  are listed under `forgotten`.
- A closed run cannot be closed again without `--force`, and cannot be written
  to: `--run <id>` or `PACK_RUN_ID` naming it is an error, except for
  `run show`, `run list`, `task show`, `task list` and `status`.

Closed runs stay in the state until pruned. `pack-leader run prune` keeps the 5
most recently closed runs and deletes the rest with their tasks, workers and
messages; `--keep N` changes the 5, `--older-than 2d` (units `s m h d w`)
deletes only runs closed longer ago than that (all of them unless `--keep` is
also given), `--all` deletes every closed run, and `--dry-run` prints what
would go. Active runs are never pruned. `pack-leader status` counts closed runs;
`status --all` lists them.

Commands that name a task or worker (`task show`, `task update`, `worker show`,
`read`, `focus`, `stop`, `retain`) only find it in the current run.

## Worker obligations

Your `[pack-leader dispatch]` preamble is authoritative. You must:

1. Do only the current task, in the given directory. Do not start or steer
   other agents.
2. Ask the orchestrator blocking questions with `pack-leader ask "<question>"`. It
   waits for the answer; after a timeout, `pack-leader ask --id <id>` keeps waiting.
   Never stop on a question the orchestrator cannot see. When the answer is
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
   cannot continue without the answer.
5. Report exactly once, with an explicit outcome:
   `pack-leader done --outcome succeeded|failed --summary "<three sentences: what changed, how it was verified, what is left>" [--files-modified a,b] [--report-path <file>]`.
   Say `failed` when the acceptance check did not pass; never encode failure
   only in prose.
6. After `pack-leader done`, end your turn and wait. A new `[pack-leader dispatch]` prompt
   or a follow-up from the orchestrator starts new work; a direct instruction
   from the user takes precedence over waiting.

## Commands

```text
pack-leader run create --objective "..." | show | list | close [--release] [--force]
pack-leader run prune [--keep N] [--older-than 2d] [--all] [--dry-run]
pack-leader task create --spec "..." [--title T] [--depends-on a,b] | list | show ID | update ID --status S
pack-leader worker start NAME --spec "..." | --task ID [--retry] [--kind claude] [--cwd D] [--direction right|down] [-- agent args]
pack-leader worker list | show NAME | read NAME [--lines N] [--dispatch ID] | focus NAME
pack-leader worker stop NAME | release NAME [--force] [--keep-pane] | retain NAME
pack-leader worker prompt NAME --spec "..." | --task ID | resend NAME
pack-leader check [--wait] [--timeout MS] [--ack ID[,ID]] [--types done,ask,attention,note]
pack-leader reply ASK_ID --body "..." [--free]
pack-leader send NAME|@all|@idle|@KIND "text" [--now]
pack-leader status [--json] [--all]
pack-leader dispatch list [--task ID] [--worker NAME] | show ID [--preamble]
pack-leader done | ask [--options a,b,c] | heartbeat | note | inbox   (worker side)
pack-leader send WORKER "text" [--now]              (worker side: same run, by name)
```

`pack-leader help` prints the same list. Unknown flags are errors; do not guess.
