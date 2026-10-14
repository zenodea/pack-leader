# Pack Leader

Pack Leader is a [herdr](https://github.com/zenodea/herdr) plugin: the agent you talk to
becomes an orchestrator, starts worker agents in hidden tabs, hands each one
a task, answers their questions and waits for their reports. A sidebar pane
shows the pack. The run state (tasks, dispatches, messages) lives outside every
agent's context, so a compaction in the orchestrator loses nothing.

```
┌─────────────────────────────────────────┬────────────────────────┐
│                                         │ goal ship it           │
│   orchestrator (the one you talk to)    │ ┌────────────────────┐ │
│                                         │ │ ◐ api claude       │ │
│   $ pack-leader check --wait            │ │ runtime 3m · work… │ │
│                                         │ │ Fix the API        │ │
│                                         │ │ ↳ tests green      │ │
│      workers run in hidden tabs:        │ └────────────────────┘ │
│      api   docs                         │ ┌────────────────────┐ │
│      Enter in the sidebar opens one,    │ │ ● docs claude      │ │
│      prefix+; or `o` brings you back    │ │ runtime 2m · idle  │ │
│                                         │ └────────────────────┘ │
└─────────────────────────────────────────┴────────────────────────┘
```

## Install

```bash
herdr plugin install zenodea/pack-leader   # or: herdr plugin link ~/pack-leader
herdr plugin action invoke install-skill --plugin pack-leader
```

`pack-leader` is not on PATH until the skill is installed, so the second line
runs the plugin's "Pack Leader: install the skill" action through herdr (the
same action is in herdr's action menu). From a checkout, `bin/pack-leader skill
--install` does the same. It writes the skill stub into the skills directory of
Claude Code, Codex and pi (whichever are set up) and links `pack-leader` into
`~/.local/bin` (put that directory on PATH if it is not). Needs herdr 0.9+ and
Node 22.18+; `pack-leader` says so if `node` is older. Workers start with
`--allowedTools "Bash(pack-leader:*)"` so their reports do not stall on a
permission prompt; add the same to your Claude Code settings if you also want
the orchestrator to run pack-leader without prompts.

Workers start with `--allowedTools "Bash(pack-leader:*)"` so their reports do not
stall on a permission prompt. The orchestrator waits with `pack-leader check --wait
--timeout 540000` (nine minutes), so its Bash tool timeout must be at least that
long. For the orchestrator to run `pack-leader` without
prompts too, add the rule to Claude Code's settings, `~/.claude/settings.json`
(or a project's `.claude/settings.json`):

```json
{
  "permissions": {
    "allow": ["Bash(pack-leader:*)"]
  }
}
```

Bind the sidebar to a key in herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+alt+w"
type = "plugin_action"
command = "pack-leader.sidebar"
description = "Pack Leader: the pack"
```

herdr's own agent-walking keys move between workers, hidden tabs included.
They are fields of the `[keys]` table, not of a `[[keys.command]]` entry, so
they need the `[keys]` header (`herdr config check` warns about them otherwise):

```toml
[keys]
next_agent = "prefix+shift+j"
previous_agent = "prefix+shift+k"
```

## Use

Tell the orchestrator agent to delegate: "split this into workers", "fan out
over these three modules", "spawn a worker to fix the tests while you review".
The skill makes it run:

```bash
pack-leader run create --objective "..."
pack-leader worker start api --spec "Target: ... Change: ... Acceptance: ..."
pack-leader check --wait --timeout 540000     # the oldest unread report, question or alert
pack-leader reply m7 --body "..."             # answer a worker's question
pack-leader check --ack m7 --wait
pack-leader worker release api                # after its report
```

Workers live in hidden tabs of the same workspace (one per worker, labelled
`name`), so your view stays the orchestrator plus the sidebar. The sidebar
opens on your right with `pack-leader run create` (`--left` for the other side);
`--placement split` on `worker start` puts a worker next to you instead (on the
right unless `--direction down`). `pack-leader help` lists every command and flag.

Workers that could step on each other get a git worktree each:
`pack-leader worker start api --worktree new --spec "..."` checks out branch
`pack/<run>/api` from the current HEAD into `<repo parent>/<repo>-wt/api` (or
`$PACK_WORKTREE_DIR/api`), opens it as a herdr workspace, and starts the worker
there; `--base`, `--branch` and `--worktree <existing path>` adjust it.
`pack-leader worker release api` keeps the worktree and prints its path and branch;
`--remove-worktree` removes one Pack Leader created (never forced, branch kept).

### Messaging

Workers get a `[pack-leader dispatch]` preamble as their first prompt (it names
their run, task and dispatch IDs, and their worktree when they have one) and
report with `pack-leader done`. Their IDs come from the pane environment. They
ask with `pack-leader ask` (which blocks until you answer), leave a non-blocking
`pack-leader note "..."` (a blocker, a finding, "taking longer because ..."), tell
another worker of the same run something with `pack-leader send <worker> "..."`,
and read follow-ups with `pack-leader inbox`.

A question can offer choices: `pack-leader ask "Which db?" --options "postgres,sqlite"`.
`pack-leader check` then shows the `options` and a `reply_hint` to paste; `pack-leader
reply m7 --body "sq"` takes an option exactly or by unique case-insensitive prefix
(anything else is an error listing the options), and `--free` answers in free
text instead. The waiting `ask` prints `reply`, `answer` (the chosen option) and
`option_index` (null for a free answer), so the worker can branch on it.

`pack-leader send` takes a worker name or a group address decided at send time
(`@all` for every worker that still owes a report, `@idle` for those herdr shows
idle or done, `@claude` and other kinds), one follow-up per recipient.
A recipient released while a group send was going out is listed with an `error` and nothing is
sent to it; the others still get theirs. A worker that has not yet received its dispatch prompt
(still starting, or its prompt failed) gets followups only afterwards, even with `--now`.
`pack-leader check --types` filters by `done`, `ask`, `attention` and `note`.
An `--ack` that matches nothing adds `acked: 0` and `ack_warning` to the same result.

### Records and cleanup

Each dispatch is recorded with the exact preamble sent (`pack-leader dispatch list`,
`pack-leader dispatch show ID --preamble`). Releasing a worker saves its screen
to `archive/<run>/<worker>-<dispatch>.txt` in the state dir first, so
`pack-leader worker read <name>` keeps working after the tab is gone; the release
prints `closed_pane`, `closed_tab`, `archive_path` and the worker's `worktree`.
If herdr fails to close the tab or pane, the release still completes and adds `close_error`
naming what may still be open.

When the run is done, `pack-leader run close --release` releases (and archives)
the workers, fails any task still dispatched and settles its dispatch, and
closes the sidebar. Closed runs stay readable until `pack-leader run prune`
deletes them with their records and archives (it keeps the 5 most recent;
`--keep N`, `--older-than 2d`, `--all`, `--dry-run`). Active runs are never pruned,
nor is a run closed less than an hour ago whose workers a `run close` is still releasing; it is
listed under `skipped` with the command to finish it (`pack-leader run close --run <id> --force`).

`pack-leader status` prints the run in the terminal (closed runs are counted;
`--all` lists them); `pack-leader skill` prints the full guide the agents follow;
`pack-leader help` lists every command. The sidebar (`pack-leader: show the pack`)
lists one box per worker with its state (including `NO AGENT` and `STALLED`),
task and last message (a heartbeat, a note, a report, an open question with its
options, or the answer); `j`/`k` move (the list scrolls to keep the selected
box in view), Enter focuses the worker's pane, `o` goes back to the
orchestrator, `r` previews its last lines, `R` (shift-r) refreshes, `?` shows
the keys and `q` quits. Until herdr has answered once, and while it is
unreachable, a worker's state shows as `?` rather than `gone`.

## How it works

- herdr's `tab.create` (or `pane.split` with `--placement split`) with
  `PACK_*` variables in the environment, then `agent.start` and `agent.prompt`,
  start a worker; nothing is forked inside the orchestrator.
- State is one JSON file under `~/.local/state/herdr/plugins/pack-leader/`, written
  atomically under a lock; every `pack-leader` command is a short-lived process.
- `pack-leader check --wait` subscribes to herdr's events and reconciles each worker's
  live state: a worker that goes idle, blocked or away without `pack-leader done`
  becomes an `attention` message the orchestrator must acknowledge.
- Each sync also judges liveness (`live`, `unverifiable` when the agent quit but
  its pane stays open, `exited` when the pane is gone twice running) and raises
  `stalled` when a worker owing a report shows no sign of life for
  `PACK_STALL_MS` (default 20 min). `pack-leader worker list` and `status` give each
  worker a `next_action`: the exact command to run next. `check --wait` prints a
  JSON heartbeat line to stderr every `PACK_WAIT_HEARTBEAT_MS` (15 s; 0 off).
- The guide's shape (role table, task-spec contract, worker obligations,
  completion accounting) is adapted from [Orca](https://github.com/stablyai/orca)'s
  orchestration skill (MIT), rewritten for herdr's primitives.

## Develop

```bash
npm install
npm run typecheck
npm test
herdr plugin link ~/pack-leader
npm link                     # optional: pack-leader on PATH from this checkout
```

Node 22.18+ runs the TypeScript directly; there is no build step.
