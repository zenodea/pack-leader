# Settings

Lodestar has one settings page, and the same values can be set from scripts.

## The settings page

```sh
lodestar settings
```

It opens in your terminal and covers:

| Setting | What it controls | Default |
| --- | --- | --- |
| Harness | Which agent new crewmates run: Claude Code, Codex, pi or fx | Claude Code |
| Model and effort | The model and thinking level for each harness | The harness's own default |
| Placement | Crewmates in hidden tabs, or split beside the leader | Hidden tabs |
| Worktrees | Always give crewmates a worktree, never, or let the leader decide | Leader decides |
| Navigator | Open the Navigator with every run | On |
| Stall alert | Minutes of silence before a crewmate that owes a report is flagged. `0` is off | 20 |
| Handoff | Hand the leader over to a fresh session when its context fills | Off |
| Handoff at | The context size, in tokens, that triggers it | 200,000 |

On herdr you can bind it to a key as a popup. See [Keyboard shortcuts](#keyboard-shortcuts-herdr).

## From a script

`config set` writes the same values:

```sh
lodestar config set --kind codex --default
lodestar config set --kind claude --model sonnet --thinking high
lodestar config set --placement split
lodestar config set --worktree-mode on
lodestar config set --navigator off
lodestar config set --stall-minutes 30
lodestar config set --handoff on --handoff-at 180000
```

`lodestar config show` prints the current settings as JSON. `--clear-model` and `--clear-thinking` remove a saved model or effort so the harness default applies again.

## Per crewmate

Anything in the settings can be overridden when a crewmate starts:

```sh
lodestar crew start tests --kind pi --model openai/gpt-6-luna --thinking low --spec "…"
lodestar crew start parser --placement split --direction down --spec "…"
lodestar crew start parser --spec "…" -- --dangerously-skip-permissions
```

Everything after `--` goes to the agent's own command line unchanged. `--no-default-args` drops the arguments Lodestar would normally add.

Automatic model choice per task is covered in [Model routing](?p=model-routing).

## Placement

- **Hidden tabs** (the default): each crewmate gets a tab of its own, and the sidebar shows them all.
- **Beside the leader**: no sidebar. The leader keeps the top left, the Navigator the bottom left, and crewmates fill the right half of the tab, each new one splitting the biggest crewmate the other way. When a crewmate is released, its neighbour takes the space.

Under tmux, new crewmates always split beside the leader.

## Keyboard shortcuts (herdr)

Add these to herdr's `config.toml` to get the settings, the sidebar and the leader on keys:

```toml
[[keys.command]]
key = "prefix+p"
type = "popup"
command = "lodestar settings"
description = "Lodestar: settings"
width = "60%"
height = "60%"

[[keys.command]]
key = "prefix+alt+w"
type = "plugin_action"
command = "lodestar.sidebar"
description = "Lodestar: show the crewmates"

[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "lodestar.focus-leader"
description = "Lodestar: back to the leader"
```
