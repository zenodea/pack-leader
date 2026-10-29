# Commands

Every command is `lodestar` followed by a group and a verb, like `lodestar worker start`. Most of them print JSON, so the leader can read IDs and results straight from the output. The exceptions are `help`, `skill`, `status` on a terminal, `dispatch show --preamble` and `worker read` of a live worker, which print plain text. `lodestar help` prints the same list with a one-line note on each command.

Some commands are for the leader, some for workers, and a few for either. You rarely type them yourself: the skill teaches your agent to. They're documented here so you can follow what it's doing, step in, or script around it.

## How flags work

- Flags are checked before anything changes. An unknown flag fails with a spelling suggestion, and a flag that needs a value fails if the value is missing.
- A value that starts with `--` has to be written as `--flag=value`, for example `--spec=--x`.
- `--body`, `--summary` and `--setup-command` are free text and take the next word whatever it is: `reply m5 --body "--no"` works.
- List flags (`--depends-on`, `--options`, `--ack`, `--files-modified`, `--types`) take a comma-separated list or can be repeated.
- `--` ends Lodestar's flags. Anything after it goes to the agent unchanged: `worker start api --spec "..." -- --model x`.
- Any leader command takes `--run ID` to act on that run instead of the one bound to your pane. `LODESTAR_RUN_ID` does the same.

## Runs

A run is one piece of work with one leader. It's bound to the pane you create it from, and it holds the tasks, workers, messages and dispatch history.

### run create

Starts a run and binds it to your pane. On herdr it also opens the Workers sidebar and the Advisor, a second agent under the leader that you can ask about the run.

```sh
lodestar run create --objective "..." [--no-sidebar] [--no-observer] [--left] [--another] [--cwd D]
```

| Flag | What it does |
| --- | --- |
| `--objective "..."` | What the run is for. Shown at the top of the sidebar and in each worker's bar. |
| `--no-sidebar` | Don't open the sidebar. |
| `--no-observer` | Don't open the Advisor. |
| `--left` | Open the sidebar on the left instead of the right. |
| `--another` | Bind a second run to a pane that already has one. |
| `--cwd D` | Default working directory for the run's workers. Must exist; stored as an absolute path. |

```sh
lodestar run create --objective "Implement CSV import"
```

The sidebar and Advisor are herdr features. A run started from a worker's pane is a sub-run: it opens neither, and its depth is limited by `LODESTAR_MAX_RUN_DEPTH` (see [Environment variables](?p=environment)).

### run show

Prints the current run: objective, status, tasks, workers.

```sh
lodestar run show [--run ID]
```

### run list

Lists runs.

```sh
lodestar run list
```

### run use

Leads an existing run from this pane. Use it when the old leader's pane crashed or someone hands a run over to you. Workers, tasks and messages stay as they are, and nudges start coming to the new pane.

```sh
lodestar run use ID [--takeover] [--another]
```

| Flag | What it does |
| --- | --- |
| `--takeover` | Take the run even though its old leader's pane is still open. Only when that leader is gone or hands over. |
| `--another` | Bind it as a second run on a pane that already leads one. |

### run close

Ends the run for good. It fails dispatched tasks, settles their dispatches, closes the sidebar and forgets the run's workers. It refuses while a worker still owes a report, unless you pass one of the flags.

```sh
lodestar run close [--release] [--force]
```

| Flag | What it does |
| --- | --- |
| `--release` | Release every worker first: archive its screen, close its pane, mark its open task failed ("run closed"). Clean checkouts are removed; branches stay. |
| `--force` | Close anyway, including a run that's already closed. |

Without `--release`, worker panes stay open and are listed under `forgotten`. A closed run is read-only. `run close` ends with the same cleanup as `run prune`.

### run prune

Deletes old closed runs with all their records and screen archives, and removes released checkouts Lodestar created. Branches are never deleted, and dirty or still-used checkouts are left alone.

```sh
lodestar run prune [--keep N] [--older-than 2d] [--all] [--dry-run]
```

| Flag | What it does |
| --- | --- |
| `--keep N` | How many recently closed runs to keep. Default 5. |
| `--older-than 2d` | Only delete runs closed longer ago than this. Units: `s m h d w`. |
| `--all` | Delete every closed run. |
| `--dry-run` | Print what would go and change nothing. |

Active runs are never pruned.

### status

Shows active runs and a count of closed ones, with each worker's liveness, what needs attention and what to run next. Human-readable on a terminal, JSON otherwise.

```sh
lodestar status [--json] [--all]
```

| Flag | What it does |
| --- | --- |
| `--json` | Print JSON even on a terminal. |
| `--all` | List closed runs too. |

## Tasks

A task is a piece of work with a spec. `worker start --spec` creates one for you; create them yourself when you want dependencies or a tree.

### task create

```sh
lodestar task create --spec "..." [--title T] [--depends-on a,b] [--parent ID]
```

| Flag | What it does |
| --- | --- |
| `--spec "..."` | The full, self-contained instructions for the worker. |
| `--title T` | A short name for the task. |
| `--depends-on a,b` | Tasks that must succeed before this one is ready. A dependency that already failed is accepted with a warning; the task waits until it succeeds. |
| `--parent ID` | Put the task under another one in the tree. This is for organisation only: it doesn't block anything. |

```sh
lodestar task create --spec "Parse the CSV input" --title "CSV parser" --parent t7
```

### task list

```sh
lodestar task list [--ready] [--status S] [--brief]
```

| Flag | What it does |
| --- | --- |
| `--ready` | Only tasks that can be dispatched now. |
| `--status S` | Only tasks with this status. |
| `--brief` | Short rows, with the spec cut to 160 characters. |

### task show

Prints one task, including its parent, its direct children and its `dispatch_ids`.

```sh
lodestar task show ID
```

### task tree

Prints a task and everything under it, with status counts. Without an ID, the whole run.

```sh
lodestar task tree [ID]
```

### task update

Changes a task's status, parent or summary. Leader only.

```sh
lodestar task update ID [--status S] [--parent ID|none] [--summary S] [--force]
```

| Flag | What it does |
| --- | --- |
| `--status S` | New status. Setting it back to `pending` clears its worker, dispatch and outcome, and resets the failed-attempt count. |
| `--parent ID\|none` | Move the task in the tree; `none` makes it a root. Refused while the task is dispatched. |
| `--summary S` | Record an outcome summary. |
| `--force` | Allow changing a task that already succeeded. |

A dispatched task can only be settled by its worker's `done` or a forced release, and `task update` never gets past an approval gate.

## Approval gates

A gate holds a task until someone approves it. Use one when a task shouldn't start (or retry) until you've looked at something. Only the leader creates and resolves gates, and a decision can't be changed once it's made.

### gate create

```sh
lodestar gate create --task ID --reason TEXT [--options a,b,c]
```

| Flag | What it does |
| --- | --- |
| `--task ID` | The task to hold. It must not be dispatched. |
| `--reason TEXT` | Why it's held, shown wherever the task is. |
| `--options a,b,c` | Make it a decision gate with fixed answers. Approving it means choosing one. |

```sh
lodestar gate create --task t4 --reason "Review the migration plan first"
lodestar gate create --task t4 --reason "Which storage?" --options "postgres,sqlite"
```

A decision gate records the choice, but the worker doesn't see it: put what was chosen into the task's spec yourself.

### gate list

```sh
lodestar gate list [--task ID]
```

### gate show

```sh
lodestar gate show ID
```

### gate resolve

```sh
lodestar gate resolve ID --decision approve|reject [--reason TEXT]
lodestar gate resolve ID --choice OPTION [--reason TEXT]
```

| Flag | What it does |
| --- | --- |
| `--decision approve\|reject` | Approve releases this gate. Reject keeps blocking the task. |
| `--choice OPTION` | For a decision gate: approve it with this option. A unique prefix works. |
| `--reason TEXT` | Why. Stored with the decision. |

Every gate on a task has to be approved before it can be dispatched. Repeating the same decision is harmless; trying to change it fails.

## Workers

### worker start

Starts a new agent, hands it a task and supervises it. With `--spec`, a task is created for it; with `--task`, it takes an existing ready task.

```sh
lodestar worker start NAME --spec "..." | --task ID [--retry]
    [--kind K] [--model M] [--thinking L] [--router off|openai|jev]
    [--cwd D] [--host NAME] [--placement tab|split] [--direction right|down]
    [--target-pane P] [--ratio R] [--title T]
    [--worktree new|PATH [--base REF] [--branch B]]
    [--setup-command STRING [--setup-timeout MS]]
    [--no-default-args] [--timeout MS] [--dry-run] [-- agent args]
```

| Flag | What it does |
| --- | --- |
| `--spec "..."` | Create a task from this spec and give it to the worker. |
| `--task ID` | Give it an existing task. Dependencies must be met and gates approved. |
| `--retry` | Retry a failed task. Three failed attempts in a row stop retries (`LODESTAR_MAX_FAILED_ATTEMPTS`). |
| `--kind K` | Which agent to start: `claude`, `codex` or `pi`. Defaults to your settings. |
| `--model M` | Model for this worker. |
| `--thinking L` | Effort level for this worker. |
| `--router off\|openai\|jev` | Override [model routing](?p=model-routing) for this worker only. An explicit model skips routing. |
| `--cwd D` | Working directory. |
| `--host NAME` | Start on a remote host (herdr only). Needs `--cwd` with a directory that already exists there; tab placement only. |
| `--placement tab\|split` | `tab` (default) puts the worker in a hidden tab of its own. `split` puts it beside the leader. |
| `--direction right\|down` | With `split`: which way to split. An error with `tab`. |
| `--target-pane P` | With `split`: split this pane instead of the worker area. |
| `--ratio R` | With `split`: size of the new pane. |
| `--title T` | Title for the task `--spec` creates. |
| `--worktree new` | Give the worker its own Git checkout at `<repo>-wt/NAME` on branch `lodestar/RUN/NAME`. |
| `--worktree PATH` | Use an existing checkout. |
| `--base REF` | With `--worktree new`: the commit the branch starts from. |
| `--branch B` | With `--worktree new`: the branch name. |
| `--setup-command STRING` | A shell command to run in the checkout once, before the agent starts (for example `npm ci`). Only with `--worktree`. If it fails, the worker doesn't start. |
| `--setup-timeout MS` | Time limit for the setup command. Default 120000, maximum 300000. |
| `--no-default-args` | Don't pass Lodestar's default agent arguments (such as Claude Code's `--allowedTools`). |
| `--timeout MS` | How long to wait for the agent to start. Default 45000. |
| `--dry-run` | Print the task, directory, planned worktree and exact preamble, and change nothing. |
| `-- agent args` | Passed to the agent command unchanged. |

```sh
lodestar worker start parser --worktree new \
  --spec "Implement CSV parsing and its tests; commit and report."
```

If the result has a `warning` that the worker is stuck on a dialog, it never got its task. Look at its screen, answer the dialog if it's safe, then run `worker resend`.

On tmux, workers split beside the leader, there's no sidebar or Advisor, worktrees are plain `git worktree` checkouts, and `--host` isn't available. See [Running under tmux](?p=tmux).

### worker adopt

Puts an agent that's already running under supervision, without restarting it. It must be idle or done. Release never closes an adopted session.

```sh
lodestar worker adopt NAME --task ID | --spec TEXT [--title TEXT] [--target-pane P]
```

| Flag | What it does |
| --- | --- |
| `--task ID` / `--spec TEXT` | The work to give it. |
| `--title TEXT` | Title for the task `--spec` creates. |
| `--target-pane P` | Which pane, when more than one agent has that name. |

An adopted session doesn't have Lodestar's environment variables, so its preamble includes an `env LODESTAR_ROLE=worker ...` prefix to put before each worker command.

### worker prompt

Gives a worker that finished its task a new one, in the same session. It waits up to 30 seconds for the worker to be idle.

```sh
lodestar worker prompt NAME --spec "..." [--title T] | --task ID [--dry-run]
```

If the prompt doesn't go in, nothing is recorded and the command fails; run it again. If it exits with a `warning`, the dispatch is recorded but the worker may not have it: read its screen, then `worker resend`.

### worker resend

Sends the worker's current task text again, for example after it was stuck on a startup dialog.

```sh
lodestar worker resend NAME
```

### worker list

Lists the run's workers. Each row has `liveness` (`live`, `unverifiable` or `exited`), `attention` (unread questions, alerts or notes) and `next_action`, the exact command to run next.

```sh
lodestar worker list
```

### worker show

The same for one worker.

```sh
lodestar worker show NAME
```

### worker read

Prints a worker's screen. After release, it prints the screen that was archived.

```sh
lodestar worker read NAME [--lines N] [--dispatch ID]
lodestar worker read NAME --source transcript [--turns N]
```

| Flag | What it does |
| --- | --- |
| `--lines N` | How many lines. Default 80. |
| `--dispatch ID` | The archived screen from an earlier attempt. |
| `--source transcript` | Read the agent's own session file instead of its screen (live local workers). |
| `--turns N` | With `--source transcript`: how many turns. Default 20. |

### worker focus

Switches to the worker's tab.

```sh
lodestar worker focus NAME
```

### worker stop

Interrupts the worker mid-turn. This is not a report: the task stays open. Read its screen and decide what to do next.

```sh
lodestar worker stop NAME
```

### worker retain

Marks a finished worker as kept, so its pane stays when the run is cleaned up.

```sh
lodestar worker retain NAME
```

### worker release

Cleans up after a worker whose task has settled. It archives the screen, closes the pane or tab Lodestar created, and removes the worker's clean checkout. The branch stays.

```sh
lodestar worker release NAME [--force] [--keep-pane] [--keep-worktree] [--remove-worktree]
```

| Flag | What it does |
| --- | --- |
| `--force` | Release a worker that still owes a report. Its task is marked failed. |
| `--keep-pane` | Leave the pane open. |
| `--keep-worktree` | Keep the checkout. Not needed to keep the work: the branch already does. |
| `--remove-worktree` | Old name for the default behaviour. |

A checkout with uncommitted changes is always kept. Followups the worker never received are dropped.

### worker abandon

Stops supervising a worker whose state you can't prove (its host is unreachable, or someone took it over). The task fails as abandoned; the pane, the agent and the checkout are left exactly as they are.

```sh
lodestar worker abandon NAME
```

## Handoff (spawn)

### spawn

Starts an agent in its own tab and types your prompt into it, word for word. There's no run, task, report or supervision: the work is given away. It's much cheaper than a supervised worker, so use it when nobody needs to track the result.

```sh
lodestar spawn NAME --prompt "..." [--kind K] [--model M] [--thinking L] [--cwd D]
    [--worktree new|PATH [--base REF] [--branch B]] [--no-default-args] [--timeout MS] [-- agent args]
```

| Flag | What it does |
| --- | --- |
| `--prompt "..."` | Everything the agent gets. Write it like a task spec. |
| `--kind`, `--model`, `--thinking` | As for `worker start`. |
| `--cwd D` | Working directory. |
| `--worktree new` | A checkout on branch `lodestar/spawn/NAME`. |
| `--worktree PATH`, `--base`, `--branch` | As for `worker start`. |
| `--no-default-args`, `--timeout MS` | As for `worker start`. |

```sh
lodestar spawn fix-login --worktree new --prompt "Fix the login redirect loop. Add a test."
```

The handoff worked when the result says `prompted: true`. Lodestar never closes a spawned tab or removes its worktree.

## Dispatches and requests

A dispatch is one attempt at a task by one worker. Every one is recorded with the exact text the worker was given.

### dispatch list

```sh
lodestar dispatch list [--task ID] [--worker NAME]
```

### dispatch show

```sh
lodestar dispatch show ID [--preamble]
```

| Flag | What it does |
| --- | --- |
| `--preamble` | Print exactly what the worker was told, as text. |

Both work on a closed run until it's pruned.

### request show

Tells you whether a command run with `--retry-request ID` finished (with its result), is still running, or never arrived.

```sh
lodestar request show ID
```

### --retry-request

Not a command but a flag for most commands that change things. If you never saw a command's result (the shell timed out, the session dropped), run the exact same command again with the same ID. If it already finished, you get the recorded result back instead of it happening twice.

```sh
lodestar worker start api --spec "..." --retry-request start-api-1
```

Accepted by `run create|close`, `task create|update`, `gate create|resolve`, `worker start|adopt|prompt|resend|stop|retain|release|abandon`, `reply`, `send`, `say`, `done`, `note` and `spawn`. Records are kept for a week.

## Messaging (leader side)

### check

Hands the leader every unread message, oldest first, up to 50. With `--wait` it blocks until one arrives, which is how the leader waits for its workers without polling.

```sh
lodestar check [--wait] [--timeout MS] [--ack ID[,ID]] [--types T,...]
lodestar check --all [--limit N]
```

| Flag | What it does |
| --- | --- |
| `--wait` | Block until a message arrives. |
| `--timeout MS` | How long to wait. Anything under 5 minutes is raised to 5 minutes (`LODESTAR_MIN_WAIT_MS`). |
| `--ack ID,...` | Mark these messages handled. Nothing is marked handled without it. |
| `--types T,...` | Only these types: `done`, `ask`, `attention`, `note`, `escalation`, `user`. |
| `--all` | List the last messages to you, read or not. Read-only. |
| `--limit N` | With `--all`: how many. Default 50. |

```sh
lodestar check --ack m7,m8 --wait --timeout 540000
```

While waiting, it writes a JSON progress line to stderr every 15 seconds (`LODESTAR_WAIT_HEARTBEAT_MS`). A `timeout` result is a checkpoint, not a failure. With handoff on and the leader's context past its limit, it returns `handoff` instead of waiting.

| Message type | What it means |
| --- | --- |
| `done` | A worker finished its task, `succeeded` or `failed`. |
| `ask` | A worker is stuck on a question and waiting. Carries its options, if any. |
| `attention` | A worker went idle without reporting, got blocked, vanished, or went quiet too long (`stalled`). |
| `note` | Something a worker wants the leader to know. It keeps working. |
| `escalation` | The leader needs to act (wrong spec, a clash between workers). The worker keeps working. |
| `user` | A message from you, sent with `say` or passed on by the Advisor. |

### reply

Answers a worker's question. If the question came with options, name one (a unique prefix is enough) or pass `--free`.

```sh
lodestar reply ASK_ID --body "..." [--free]
```

```sh
lodestar reply m9 --body "sq"            # picks "sqlite"
lodestar reply m9 --free --body "Neither: keep the JSON file."
```

### send

Sends a follow-up to one or more workers. It goes straight into the worker's prompt when it's ready for input, otherwise it waits for the worker's next `inbox`.

```sh
lodestar send NAME|@all|@idle|@KIND "text" | --body "..." [--now]
```

| Address | Who gets it |
| --- | --- |
| `NAME` | That worker. |
| `@all` | Every worker that still owes a report. |
| `@idle` | Every worker that's idle or done right now. |
| `@KIND` | Every worker of that kind, for example `@claude`. |

| Flag | What it does |
| --- | --- |
| `--now` | Deliver at once instead of waiting for the worker to be ready. |

### say

Sends a message from you to the leader. It shows up in the leader's next `check` as a `user` message. The Advisor uses this when you ask it to pass something on.

```sh
lodestar say "text" | --body "..."
```

### handoff

Used by the leader when `check` says its context is full. It saves a note for the next session; Lodestar then clears the session once it's idle (`/clear` in Claude Code, `/new` in pi) and the fresh session carries on from the note.

```sh
lodestar handoff --body "<note>"
```

## Worker commands

These run from a worker's pane. The worker's run, task and dispatch IDs come from its environment, so it never has to pass them. Each accepts `--worker`, `--run`, `--task` and `--dispatch` to override them, and the text commands also take `--body "..."`.

### done

Reports the task finished. This is the only way a task gets settled by its worker, and it should happen exactly once.

```sh
lodestar done --outcome succeeded|failed --summary "..." [--files-modified a,b] [--report-path P]
```

| Flag | What it does |
| --- | --- |
| `--outcome succeeded\|failed` | Whether the task's acceptance check passed. |
| `--summary "..."` | What changed, how it was checked, what's left. |
| `--files-modified a,b` | The files it changed. |
| `--report-path P` | A longer report file. Relative paths are stored as absolute. |

### ask

Asks the leader a question and waits for the answer. For questions the worker can't continue without.

```sh
lodestar ask "question" [--options a,b,c] [--timeout MS]
lodestar ask --id ID
```

| Flag | What it does |
| --- | --- |
| `--options a,b,c` | Offer fixed answers. The result says which was picked. |
| `--timeout MS` | How long to wait. Default 600000 (10 minutes). |
| `--id ID` | Keep waiting on an earlier question after a timeout. |

### note

A line for the leader that doesn't stop the worker: a workaround, a finding, a delay.

```sh
lodestar note "text"
```

### escalate

Something the leader has to act on, like a wrong spec or a clash with another worker. The worker keeps working on what it can.

```sh
lodestar escalate "text"
```

### heartbeat

A sign of life during long work, with what the worker is on.

```sh
lodestar heartbeat "note" [--phase investigating|implementing|reviewing|waiting]
```

### inbox

Reads follow-ups that are waiting. Workers check it at natural points and right before reporting.

```sh
lodestar inbox
```

### send (from a worker)

Sends a follow-up to another worker in the same run. Not to itself, another run, or a group.

```sh
lodestar send WORKER "text" [--now]
```

## Remote hosts

Remote hosts run workers on another machine over SSH, while the run's state stays with the leader. herdr only. Both machines need Lodestar and herdr, a remote herdr workspace that's already open, and non-interactive SSH in both directions with trusted host keys. See [Remote workers](?p=remote).

### host add

Saves a host profile. It doesn't contact the host, and no password or key is stored: SSH handles that.

```sh
lodestar host add NAME --ssh-target ALIAS_OR_USER@HOST --workspace-id ID --leader-ssh-target TARGET
    [--herdr-socket PATH] [--lodestar BIN] [--leader-lodestar BIN]
```

| Flag | What it does |
| --- | --- |
| `--ssh-target` | How the leader reaches the host: an SSH config alias or `user@host`. |
| `--workspace-id ID` | The remote herdr workspace workers start in. |
| `--leader-ssh-target TARGET` | How the remote workers reach back to the leader. |
| `--herdr-socket PATH` | The remote herdr socket, if not the default. |
| `--lodestar BIN` | Path to `lodestar` on the host. |
| `--leader-lodestar BIN` | Path to `lodestar` on the leader's machine, as seen from the host. |

```sh
lodestar host add buildbox --ssh-target buildbox --workspace-id w1 --leader-ssh-target laptop
lodestar worker start api --host buildbox --cwd /srv/app --spec "..."
```

### host list

```sh
lodestar host list
```

### host show

```sh
lodestar host show NAME
```

### host remove

Affects future starts only; workers already running keep the profile they started with.

```sh
lodestar host remove NAME
```

## Settings and tools

### settings

Opens the settings page in your terminal: agent, model, effort, placement, worktrees, Advisor, stall alert and handoff. `config pick` is the old name for the same page.

```sh
lodestar settings
```

### config

Prints the settings as JSON, or changes them from a script. Flags on a command (like `worker start --kind`) still win over these.

```sh
lodestar config [show]
lodestar config set [--kind K] [--model M] [--thinking L] [--clear-model] [--clear-thinking] [--default]
    [--placement tab|split] [--worktree-mode on|off|leader] [--observer on|off]
    [--stall-minutes N] [--handoff on|off] [--handoff-at TOKENS]
    [--routing-config FILE] [--router off|openai|jev]
```

| Flag | What it does |
| --- | --- |
| `--kind K` | Default agent for new workers. |
| `--model M`, `--thinking L` | Default model and effort for that agent. |
| `--clear-model`, `--clear-thinking` | Remove them. |
| `--default` | Make the selected agent the default. |
| `--placement tab\|split` | Where new workers go. |
| `--worktree-mode on\|off\|leader` | Always give workers a worktree, never, or let the leader decide. |
| `--observer on\|off` | Whether `run create` opens the Advisor. |
| `--stall-minutes N` | Alert when a worker owes a report and shows no sign of life for this long. `0` is off. `LODESTAR_STALL_MS` wins over it. |
| `--handoff on\|off` | Let a Claude Code or pi leader hand off to a fresh session when its context fills up. |
| `--handoff-at TOKENS` | When that happens, for example `200000`, `200k` or `1m`. |
| `--routing-config FILE` | Import approved model profiles for [model routing](?p=model-routing). |
| `--router off\|openai\|jev` | Turn routing off or pick its provider. Off by default. |

### skill

Prints the guide the agents follow. With `--install`, installs the skill into Claude Code, Codex and pi.

```sh
lodestar skill [--install]
```

### observe

What the Advisor reads: the run, its workers, unread messages and the leader's last turns.

```sh
lodestar observe [--turns N]
```

| Flag | What it does |
| --- | --- |
| `--turns N` | How many of the leader's recent turns. Default 8. |

### observer

Opens the Advisor under the leader again, or closes it. herdr only.

```sh
lodestar observer [--close]
```

### leader

Switches focus to the leader of the run this pane belongs to. Works from a worker's pane or the sidebar.

```sh
lodestar leader [--run ID]
```

### sidebar

Draws the Workers sidebar. herdr runs this in a pane for you; you won't normally call it.

```sh
lodestar sidebar
```

### help

Prints every command with a note on each.

```sh
lodestar help
```
