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
| Routing | Let OpenAI Decisions or TypeSafe Jev pick each crewmate's model from profiles you approve. See [Model routing](?p=model-routing) | Off |
| Placement | Crewmates in hidden tabs, split beside the leader, or (Rex) in no tab at all | Hidden tabs |
| Popup (Rex) | `p` in the crew pane opens the selected crewmate in a window floating over your tab | On |
| Worktrees | Always give crewmates a worktree, never, or let the leader decide | Leader decides |
| Navigator | Open the Navigator with every run | On |
| Review | The leader checks each crewmate's work before accepting its report | On |
| Retry limit | Failed attempts in a row before a task is no longer retried. `0` is no limit; `LODESTAR_MAX_FAILED_ATTEMPTS` still wins | 3 |
| Stall alert | Minutes of silence before a crewmate that owes a report is flagged. `0` is off | 20 |
| Handoff | Hand the leader over to a fresh session when its context fills | Off |
| Handoff at | The context size, in tokens, that triggers it | 200,000 |
| Sidebar side | Which side of the leader the sidebar opens on. `--left` still wins for one run | Right |
| Usage pane | The sidebar opens a pane below the crew with plan limits and spend | On |
| Crewmate bar | The strip above each crewmate with its branch and task. `LODESTAR_BAR=0` still turns it off | On |
| Accent | The highlight colour. `theme` uses herdr's accent under herdr and the terminal's cyan elsewhere; the colour names come from the terminal's palette, so they follow its theme; or a colour like `#89b482`. `LODESTAR_ACCENT` still wins | theme |

Keys:

| Key | Does |
| --- | --- |
| `j` / `k` (or ↓ / ↑, `ctrl-j` / `ctrl-k`) | Move down or up |
| `g` / `G` | First or last setting |
| `l` / `h` (or → / ←, `ctrl-l` / `ctrl-h`) | Step the value on or back; flips an on/off setting |
| Enter or Space | Move into the setting's choices on the right (the full list on a narrow pane); flips an on/off setting |
| `q` or Esc | Close |

On a wide pane, the selected setting's choices show to the right of the rows, with the current one marked and the `lodestar config set` command that sets it. `h` / `l` move the mark. Enter moves into those choices and greys the setting out: `j` / `k` move, Enter or `l` picks, `/` opens the full list to search or type a value, and `h` or Esc goes back.

In the full list, letters search, so the keys take ctrl: `ctrl-j` / `ctrl-k` move (as do `ctrl-n` / `ctrl-p` and the arrows), `ctrl-l` picks and `ctrl-h` backs out.

The page only lists what the multiplexer you're in can do. Popup and the "no tabs" placement show under Rex and stay hidden under herdr and tmux.

On herdr you can bind it to a key as a popup. See [Keyboard shortcuts](#keyboard-shortcuts-herdr).

## From a script

`config set` writes the same values:

```sh
lodestar config set --kind codex --default
lodestar config set --kind claude --model sonnet --thinking high
lodestar config set --placement split
lodestar config set --worktree-mode on
lodestar config set --navigator off
lodestar config set --popup off
lodestar config set --usage-pane off
lodestar config set --sidebar-side left --crew-bar off --accent blue --retry-limit 5
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
- **No tabs** (Rex only, `--placement background`): crewmates run in no tab. The crew pane lists them, and Enter opens one as a [popup](?p=rex#the-popup). On herdr and tmux this setting gives hidden tabs.

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
