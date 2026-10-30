# Running under tmux

Lodestar runs inside a plain tmux session (tmux 3.x) as well as herdr. A tmux session plays the part of a herdr workspace, and a window plays the part of a tab.

## Picking the multiplexer

You don't need to choose. Inside tmux, Lodestar uses tmux; inside herdr, it uses herdr. To force one:

```sh
export LODESTAR_MUX=tmux    # or herdr
```

Each run remembers which multiplexer it was created under, and only that one manages it.

## How it knows what agents are doing

herdr can see whether an agent is working or idle. tmux can't, so Lodestar starts Claude Code and Codex crewmates with hooks that report their status back (`lodestar __agent-status`).

pi has no hooks, so Lodestar loads a small pi extension (`pi -e`) that reports the same way: idle when a session starts, working while it runs, idle once pi won't continue on its own. pi doesn't ask for permission, so it never shows as blocked. The same goes for Rex.

## What's different from herdr

| | herdr | tmux |
| --- | --- | --- |
| Agent status | Native | Hooks for Claude Code and Codex, an extension for pi |
| Updates | Live event stream | Polling |
| Sidebar and Navigator | Yes | No |
| Crewmate placement | Hidden tabs or beside the leader | Split beside the leader |
| Moving and swapping panes | Yes | No |
| Worktrees | Opened as a herdr workspace | Plain `git worktree` checkouts |
| Remote crewmates over SSH | Yes | No |

Everything else (runs, tasks, gates, messages, worktrees, handoffs, the state file) works the same way.
