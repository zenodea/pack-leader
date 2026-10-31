# Running under Rex

Lodestar runs inside Rex the same way it runs inside herdr. A Rex session plays the part of a herdr workspace, and a Rex window (a tab in the app) plays the part of a tab.

## Picking the multiplexer

Inside a Rex terminal (`REX_SESSION` is set), Lodestar uses Rex. To force it:

```sh
export LODESTAR_MUX=rex
```

Each run remembers which multiplexer it was created under, and only that one manages it.

## How it knows what agents are doing

Claude Code, Codex and fx tell Rex their status themselves, and Lodestar reads it from Rex: no hooks, no status files. pi gets a small extension (`pi -e`) that reports to Rex the same way.

## Where crewmates go

The Placement setting decides it, as on herdr:

- **Hidden tabs** (the default): each crewmate gets a window of its own. The crew pane and the usage pane sit beside the leader.
- **Beside the leader**: the leader keeps the top left, the Navigator the bottom left, and crewmates tile the right half, each new one splitting the biggest crewmate the other way.
- **No tabs** (Rex only): crewmates run in no window at all. They show in the crew pane like any other crewmate, and Enter opens one as a [popup](#the-popup). Choose it on the settings page, with `lodestar config set --placement background`, or for one crewmate with `lodestar crew start NAME --placement background`.

## The popup

Select a crewmate in the crew pane and press `p`. A window floats over your tab with the crewmate's screen, kept up to date. What you type goes to the crewmate, so you can answer a question without leaving the leader. ctrl-] closes the popup; the crewmate keeps running.

- The popup shows the bottom of the crewmate's screen. A crewmate in a tab that's wider than the popup loses its right edge. A crewmate with no tab is resized to fit the popup exactly.
- Turn the `p` key off under Popup on the settings page, or with `lodestar config set --popup off`. Crewmates with no tab still open as a popup, since there's no tab to switch to.
- `lodestar popup PANE` opens the same view in any terminal.

## What's different from herdr

| | herdr | Rex |
| --- | --- | --- |
| Agent status | Native | Reported to Rex by the agents; an extension for pi |
| Updates | Live event stream | Live event stream |
| Sidebar, usage pane and Navigator | Yes | Yes |
| Crewmate placement | Hidden tabs or beside the leader | Hidden tabs, beside the leader, or no tabs |
| Popup | No | Yes |
| Worktrees | Opened as a herdr workspace | Plain `git worktree` checkouts |
| Remote crewmates over SSH | Yes | No |
| Notifications | herdr's own | macOS notifications |

The settings page only shows what the multiplexer you're in can do: Popup and "no tabs" appear under Rex and stay hidden under herdr and tmux. A config that asks for no tabs gives hidden tabs on a multiplexer that can't run a crewmate without one.
