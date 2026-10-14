# Pack Leader

A [herdr](https://github.com/zenodea/herdr) plugin that turns the coding agent
you are talking to into the orchestrator of a pack of worker agents.

You give the orchestrator a job. It splits the job into tasks, starts one worker
per task in a hidden tab, answers their questions, and waits for their reports.
You keep watching one pane: the orchestrator, with a sidebar that shows every
worker's state, task and last message. The run state (tasks, dispatches,
messages, screen archives) lives in a file outside every agent's context, so a
context compaction in the orchestrator loses nothing, and a worker that goes
quiet or dies is noticed and reported.

Everything happens through one CLI, `pack-leader`, that both sides run from
their shells. The orchestrator learns it from a skill the plugin installs. The
shape of that skill (orchestrator loop, task-spec contract, worker obligations,
completion accounting) is adapted from the orchestration skill of
[Orca](https://github.com/stablyai/orca) (MIT), rewritten for herdr's panes,
tabs and agents.

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
│      Enter (or a second click) in the   │ │ ● docs claude      │ │
│      sidebar opens one, `o` comes back  │ │ runtime 2m · idle  │ │
│                                         │ └────────────────────┘ │
└─────────────────────────────────────────┴────────────────────────┘
```

## Install

```bash
herdr plugin install zenodea/pack-leader   # or: herdr plugin link ~/pack-leader
herdr plugin action invoke install-skill --plugin pack-leader
```

The second line installs the skill into Claude Code, Codex and pi (whichever
are set up) and links `pack-leader` into `~/.local/bin`. Needs herdr 0.9+ and
Node 22.18+. To let the orchestrator run `pack-leader` without permission
prompts, allow it in Claude Code's settings (`~/.claude/settings.json`):

```json
{ "permissions": { "allow": ["Bash(pack-leader:*)"] } }
```

Workers get that rule automatically. Optionally bind the sidebar, and a key
that brings you back to the orchestrator from any worker's tab, in herdr's
`config.toml`:

```toml
[[keys.command]]
key = "prefix+alt+w"
type = "plugin_action"
command = "pack-leader.sidebar"
description = "Pack Leader: the pack"

[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "pack-leader.focus-leader"
description = "Pack Leader: back to the leader"
```

The sidebar outlines the selected worker in herdr's accent colour (`[ui]
accent` in that file) and shows that box's task and last message in full; the
others stay one line each.

## Use

Tell the orchestrator to delegate: "split this into workers", "fan out over
these three modules", "spawn a worker to fix the tests while you review". The
skill makes it run this loop:

```bash
pack-leader run create --objective "..."                 # binds the run to this pane, opens the sidebar
pack-leader worker start api --worktree new --spec "..." # one hidden tab (and git worktree) per worker
pack-leader check --wait --timeout 540000                # the oldest unread report, question or alert
pack-leader reply m7 --body "postgres"                   # answer a worker's question
pack-leader check --ack m7 --wait
pack-leader worker release api                           # archives its screen, closes its tab
pack-leader run close --release
```

Workers get a `[pack-leader dispatch]` preamble as their first prompt and talk
back with `pack-leader done`, `ask` (blocking, optionally with `--options`),
`note` (non-blocking), `heartbeat` and `inbox`. The orchestrator can message one
worker, `@all`, `@idle` or `@claude`, and workers of the same run can message
each other.

`pack-leader help` lists every command and flag. `pack-leader skill` prints the
full guide the agents follow ([docs/guide.md](docs/guide.md)).

## What you get

| | |
|---|---|
| **One view** | Orchestrator plus sidebar, its goal pinned above a scrolling list of workers. Workers live in hidden tabs; a click selects one and Enter or a second click opens it, `o` or the back-to-the-leader key comes back. `--placement split` puts a worker next to you instead. |
| **Isolation** | `--worktree new` gives a worker its own git worktree and herdr workspace, on branch `pack/<run>/<worker>`. |
| **Supervision** | Each sync judges every worker: `live`, `unverifiable` (agent gone, pane open), `exited`, `stalled`. Anything that needs you becomes an `attention` message with the exact next command to run. |
| **Nothing lost** | Dispatch records keep the exact preamble sent. Releasing a worker archives its screen, so `worker read` works after the tab is gone. The state file is written atomically under a pid-aware lock. |
| **Cleanup** | `run close` fails what is still open and closes the sidebar. `run prune` removes old runs, their records and archives. |

## How it works

- Every `pack-leader` command is a short-lived process over one JSON state
  file in `~/.local/state/herdr/plugins/pack-leader/`.
- Workers are started through herdr's socket API (`tab.create` or
  `pane.split`, `agent.start`, `agent.prompt`) with `PACK_*` variables in the
  pane environment; nothing is forked inside the orchestrator.
- `check --wait` subscribes to herdr's pane and tab events and reconciles each
  worker's live state against the run's records.
- The sidebar is a plugin pane that watches the state file and the same events.

See [docs/CHANGELOG.md](docs/CHANGELOG.md) for what each release added.

## Develop

```bash
npm install
npm test              # typecheck + node --test, no herdr needed
herdr plugin link .   # run this checkout as the installed plugin
```

Node 22.18+ runs the TypeScript directly; there is no build step.

## License

MIT.
