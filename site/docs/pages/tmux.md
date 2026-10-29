# Running under tmux

Lodestar runs inside a plain tmux session (tmux 3.x) as well as herdr. A tmux session plays the part of a herdr workspace, and a window plays the part of a tab.

## Picking the multiplexer

You don't need to choose. Inside tmux, Lodestar uses tmux; inside herdr, it uses herdr. To force one:

```sh
export LODESTAR_MUX=tmux    # or herdr
```

Each run remembers which multiplexer it was created under, and only that one manages it.

## How it knows what agents are doing

herdr can see whether an agent is working or idle. tmux can't, so Lodestar starts Claude Code and Codex workers with hooks that report their status back (`lodestar __agent-status`).

pi has no such hooks. Its status stays `unknown`, which never counts as idle. pi workers still report through `done` and `ask` as usual; they just don't get the idle-based nudges.

## What's different from herdr

| | herdr | tmux |
| --- | --- | --- |
| Agent status | Native | Hooks for Claude Code and Codex; pi is `unknown` |
| Updates | Live event stream | Polling |
| Sidebar and Advisor | Yes | No |
| Worker placement | Hidden tabs or beside the leader | Split beside the leader |
| Moving and swapping panes | Yes | No |
| Worktrees | Opened as a herdr workspace | Plain `git worktree` checkouts |
| Remote workers over SSH | Yes | No |

Everything else (runs, tasks, gates, messages, worktrees, handoffs, the state file) works the same way.
