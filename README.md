# Pack Leader

Pack Leader is a [herdr](https://github.com/zenodea/herdr) plugin: the agent you talk to
becomes an orchestrator, starts worker agents in sibling panes, hands each one
a task, answers their questions and waits for their reports. A sidebar pane
shows the pack. The run state (tasks, dispatches, messages) lives outside every
agent's context, so a compaction in the orchestrator loses nothing.

```
┌─────────────────────────────────────────┬────────────────┐
│                                         │ r1 ship it     │
│   orchestrator (the one you talk to)    │ ┌────────────┐ │
│                                         │ │◐ api claude│ │
│   $ pack-leader check --wait            │ │runtime 3m  │ │
│                                         │ │Fix the API │ │
│                                         │ └────────────┘ │
│      workers run in hidden tabs:        │ ┌────────────┐ │
│      api   docs                         │ │● docs      │ │
│      Enter in the sidebar opens one,    │ │runtime 2m  │ │
│      prefix+; or `o` brings you back    │ └────────────┘ │
└─────────────────────────────────────────┴────────────────┘
```

## Install

```bash
herdr plugin install zenodea/pack-leader   # or: herdr plugin link ~/pack-leader
pack-leader skill --install                     # or the "pack-leader: install the skill" action
```

`pack-leader skill --install` writes the skill stub to `~/.claude/skills/pack-leader/SKILL.md`
and links `pack-leader` into `~/.local/bin`. Workers start with `--allowedTools
"Bash(pack-leader:*)"` so their reports do not stall on a permission prompt; add the
same to your Claude Code settings if you also want the orchestrator to run pack-leader
without prompts.

Bind the sidebar to a key in herdr's `config.toml`, and let herdr's own
agent-walking actions move between workers (hidden tabs included):

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "pack-leader.sidebar"
description = "Pack Leader: the pack"

next_agent = "prefix+shift+j"
previous_agent = "prefix+shift+k"
focus_agent = "prefix+alt+1..9"
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
`--placement split` on `worker start` puts a worker next to you instead.

Workers get a `[pack-leader dispatch]` preamble as their first prompt and report with
`pack-leader done`, ask with `pack-leader ask` (which blocks until you answer), and read
follow-ups with `pack-leader inbox`. Their IDs come from the pane environment.

Each dispatch is recorded with the exact preamble sent (`pack-leader dispatch list`,
`pack-leader dispatch show ID --preamble`), and releasing a worker saves its screen
to `archive/<run>/<worker>-<dispatch>.txt` in the state dir first, so
`pack-leader worker read <name>` keeps working after the tab is gone.

`pack-leader status` prints the run in the terminal; `pack-leader skill` prints the full guide
the agents follow. The sidebar (`pack-leader: show the pack`) lists one box per worker
with its herdr state, task and last message; `j`/`k` move, Enter focuses the
worker's pane, `r` previews its last lines.

## How it works

- `herdr pane split` with `PACK_*` variables in the environment, `herdr agent
  start`, and `herdr agent prompt` start a worker; nothing is forked inside the
  orchestrator.
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
```

Node 22.18+ runs the TypeScript directly; there is no build step.
