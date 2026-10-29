# Environment variables

Lodestar works without any of these set. They're for changing a default, pointing it at a different place, or scripting around it. Times are in milliseconds; a value that isn't a non-negative number is ignored and the default is used.

## Choosing the multiplexer

| Variable | What it does | Default |
| --- | --- | --- |
| `LODESTAR_MUX` | Force `herdr` or `tmux`. Any other value is an error. | herdr if its environment is present, tmux if you're inside a tmux client, otherwise herdr. |
| `LODESTAR_TMUX_SOCKET` | Talk to the tmux server on this socket (passed as `tmux -S`). | The server of the tmux session you're in. |
| `HERDR_SOCKET_PATH` | The herdr socket to talk to. | `$XDG_CONFIG_HOME/herdr/sessions/$HERDR_SESSION/herdr.sock` when `HERDR_SESSION` is set, otherwise `$XDG_CONFIG_HOME/herdr/herdr.sock`. |
| `HERDR_BIN_PATH` | The `herdr` executable. | `herdr` on your `PATH`. |

## Where things are kept

| Variable | What it does | Default |
| --- | --- | --- |
| `HERDR_PLUGIN_STATE_DIR` | Where runs, tasks, messages and screen archives live. herdr sets it for plugins. | `$XDG_STATE_HOME/herdr/plugins/lodestar` |
| `HERDR_PLUGIN_CONFIG_DIR` | Where settings and host profiles live. | `$XDG_CONFIG_HOME/herdr/plugins/config/lodestar` |
| `XDG_STATE_HOME`, `XDG_CONFIG_HOME` | The usual base folders the two above are built from. | `~/.local/state`, `~/.config` |
| `LODESTAR_WORKTREE_DIR` | The folder new worktrees go in, as `NAME` under it. | `<repo>-wt/` next to your repository. |
| `LODESTAR_ROOT` | Where Lodestar's own files (guide, skill, scripts) are. | Found from the location of the `lodestar` binary. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` | Where `skill --install` puts the skill for each agent. | `~/.claude`, `~/.codex`, `~/.pi/agent` |

## Timing and limits

| Variable | What it does | Default |
| --- | --- | --- |
| `LODESTAR_MIN_WAIT_MS` | The shortest timeout `check --wait` accepts; shorter ones are raised to it. | `300000` (5 minutes) |
| `LODESTAR_WAIT_HEARTBEAT_MS` | How often `check --wait` writes a progress line to stderr. `0` turns it off. | `15000` |
| `LODESTAR_STALL_MS` | How long a crewmate that owes a report can show no sign of life before the leader gets a `stalled` alert. `0` turns it off. Wins over the stall setting. | The stall setting (20 minutes). |
| `LODESTAR_RENUDGE_MS` | How long unread reports, questions or notes sit before an idle leader is nudged again. | `60000` |
| `LODESTAR_MAX_FAILED_ATTEMPTS` | Failed attempts in a row before a task stops retrying. `0` means no limit. | `3` |
| `LODESTAR_MAX_RUN_DEPTH` | How deep sub-runs can go. `1` lets crewmates of a top-level run lead a sub-run of their own; `0` forbids sub-runs. | `1` |
| `LODESTAR_PROMPT_RETRY_MS` | Base delay between attempts to type a task into a crewmate that isn't ready. | `1000` |
| `LODESTAR_HANDOFF_IDLE_MS` | How long Lodestar waits for a leader to go idle before clearing its session on handoff. | `600000` (10 minutes) |
| `LODESTAR_HANDOFF_SETTLE_MS` | Pause after the leader goes idle before the session is cleared. | `2000` |

## Appearance

| Variable | What it does | Default |
| --- | --- | --- |
| `LODESTAR_BAR` | Set to `0` to skip the "Back to leader" bar at the top of each crewmate's pane. | The bar is shown. |
| `LODESTAR_ACCENT` | Accent colour for the crewmate bar, as `#rrggbb`. | herdr's accent colour from its config. |

## Model routing

Only read when [model routing](?p=model-routing) is turned on.

| Variable | What it does |
| --- | --- |
| `OPENAI_API_KEY` | Key for the `openai` router. |
| `TYPESAFE_API_KEY` | Key for the `jev` router. |

## Set by Lodestar

Lodestar puts these in each crewmate's pane, which is how crewmate commands know who they are. You don't need to set them, but you can read them in scripts.

| Variable | What it holds |
| --- | --- |
| `LODESTAR_ROLE` | `crewmate` in a crewmate's pane. |
| `LODESTAR_RUN_ID` | The run. In a leader's shell, setting it makes commands act on that run, like `--run`. |
| `LODESTAR_CREWMATE` | The crewmate's name. |
| `LODESTAR_TASK_ID` | The task it's working on. |
| `LODESTAR_DISPATCH_ID` | The current attempt. |
