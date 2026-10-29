# How it fits together

A handful of words come up everywhere in Lodestar. This page explains them once.

## The leader

The agent you talk to. It owns a run: it creates tasks, starts workers, answers their questions and decides when things are finished. The commands call it the orchestrator or the coordinator. It's an ordinary Claude Code, Codex or pi session that has loaded the Lodestar skill.

## Workers

Agents the leader starts to do one task each. A worker lives in its own tab (or a split beside the leader), optionally in its own Git worktree. It talks to the leader only through the `lodestar` CLI, and finishes by reporting `done`.

You can also **adopt** an agent that's already running (`worker adopt`), so the leader supervises it without restarting it.

## Runs

A run is one piece of work you asked for, bound to the leader's pane. It has an objective, and holds the tasks, workers, messages and gates for that job. A pane can lead more than one run (`run create --another`), and a run can move to a new pane if the old one dies (`run use`).

## Tasks

A unit of work with a spec. Tasks can depend on other tasks (`--depends-on`), which holds them back until those succeed, and can be grouped under a parent for organisation (`--parent`). A task ends with an outcome: `succeeded` or `failed`.

## Dispatches

One attempt at a task by one worker. Each `worker start` or `worker prompt` creates a dispatch and records the exact instructions the worker was sent (the **preamble**). If a task fails and is retried, the new attempt is a new dispatch. `dispatch show ID --preamble` prints exactly what a worker was told.

## Messages

Everything between workers and the leader goes through messages, stored in the run:

| From a worker | Means |
| --- | --- |
| `ask` | A question the worker can't continue without. It waits for the reply. |
| `note` | Something worth knowing. The worker keeps going. |
| `escalate` | The leader has to act (wrong spec, a clash with another worker). The worker keeps going. |
| `heartbeat` | Still alive, and which phase it's in. |
| `done` | The report that finishes the task. |

Lodestar adds `attention` messages of its own when a worker goes quiet, gets stuck on a prompt, or disappears. You can add `user` messages with `lodestar say`.

The leader reads all of them with one `check`, and marks them handled with `--ack`.

## Gates

An approval gate holds a task until someone approves or rejects it. A gate with options is a decision: approving it means picking one. Decisions are recorded and can't be changed afterwards. See [Tasks and gates](?p=tasks).

## The state file

All of the above lives in one lock-protected state folder, normally `~/.local/state/herdr/plugins/lodestar/`, outside every agent's context. That's why a run survives a cleared session, a crashed pane or a long weekend.

## The sidebar and the Advisor (herdr)

On herdr, `run create` opens two extra panes next to the leader:

- **Workers**, the sidebar: one box per worker with its agent, runtime, state, task and last message. Questions show their choices. See [Supervising a run](?p=supervising#the-sidebar).
- **Advisor**: a second agent you can ask about the run. It reads the run state, the leader's recent turns and, when you ask about one, a worker's screen. It's read-only: it never steers workers or acknowledges messages. Ask it to pass something on and it arrives at the leader as a `user` message.

Skip them with `run create --no-sidebar` or `--no-observer`. Both are herdr features; under tmux there's no sidebar or Advisor.

## Full handoff

Sometimes you don't need supervision, just another agent working on something. `lodestar spawn` starts an agent in its own tab, types your prompt in and walks away. No run, no tasks, no reports. See [Handoffs and sub-runs](?p=long-runs).
