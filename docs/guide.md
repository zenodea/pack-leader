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

Process every message, then acknowledge it and wait for the next:

| `type`      | Meaning                                                   | Your move                                                                                |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `done`      | The worker settled its task (`outcome` succeeded/failed)  | Verify if needed, then reuse (`pack-leader worker prompt`), `retain`, or `release` the worker  |
| `ask`       | The worker is blocked on a question                       | `pack-leader reply <id> --body "<answer>"`                                                      |
| `attention` | The worker settled or vanished without reporting          | `pack-leader worker read <name>`; re-prompt it to run `pack-leader done`, or release with `--force`    |

```bash
pack-leader reply m7 --body "Use the existing helper in src/net.ts; do not add a dependency."
pack-leader check --ack m7 --wait --timeout 540000
```

Use `pack-leader task create` with `--depends-on` for planned fan-out with ordering,
then `pack-leader worker start <name> --task <id>` when `pack-leader task list` shows the
task ready. Prefer parallel waves over chains deeper than three steps.

Follow-ups to a busy worker go through `pack-leader send <name> "text"`: delivered
straight into its prompt when it is ready for input, otherwise queued for its
next `pack-leader inbox` checkpoint.

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

## Worker obligations

Your `[pack-leader dispatch]` preamble is authoritative. You must:

1. Do only the current task, in the given directory. Do not start or steer
   other agents.
2. Ask the orchestrator blocking questions with `pack-leader ask "<question>"`. It
   waits for the answer; after a timeout, `pack-leader ask --id <id>` keeps waiting.
   Never stop on a question the orchestrator cannot see.
3. Read follow-ups at natural checkpoints (before starting a new file, after a
   test run) and once more right before reporting: `pack-leader inbox`.
4. During long work, about every ten minutes: `pack-leader heartbeat "<one line>"`.
5. Report exactly once, with an explicit outcome:
   `pack-leader done --outcome succeeded|failed --summary "<three sentences: what changed, how it was verified, what is left>" [--files-modified a,b] [--report-path <file>]`.
   Say `failed` when the acceptance check did not pass; never encode failure
   only in prose.
6. After `pack-leader done`, end your turn and wait. A new `[pack-leader dispatch]` prompt
   or a follow-up from the orchestrator starts new work; a direct instruction
   from the user takes precedence over waiting.

## Commands

```text
pack-leader run create --objective "..." | show | list | close [--release]
pack-leader task create --spec "..." [--title T] [--depends-on a,b] | list | show ID | update ID --status S
pack-leader worker start NAME --spec "..." | --task ID [--retry] [--kind claude] [--cwd D] [--direction right|down] [-- agent args]
pack-leader worker list | show NAME | read NAME [--lines N] | focus NAME
pack-leader worker stop NAME | release NAME [--force] [--keep-pane] | retain NAME
pack-leader worker prompt NAME --spec "..." | --task ID | resend NAME
pack-leader check [--wait] [--timeout MS] [--ack ID[,ID]] [--types done,ask,attention]
pack-leader reply ASK_ID --body "..."
pack-leader send NAME "text" [--now]
pack-leader status [--json]
pack-leader done | ask | heartbeat | inbox          (worker side)
```

`pack-leader help` prints the same list. Unknown flags are errors; do not guess.
