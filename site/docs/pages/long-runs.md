# Handoffs and sub-runs

Three things for bigger or longer jobs: a leader that runs out of context, work you want to hand off without supervising, and crewmates that need crewmates of their own.

## When the leader's context fills up

Turn handoff on in the settings, or:

```sh
lodestar config set --handoff on --handoff-at 200000
```

With handoff on, a Claude Code or pi leader checks its own context each time it waits. Once it's past the limit (200,000 tokens by default), `check` tells it to hand off instead of waiting. The leader then:

1. writes a note for its replacement: your goal, every instruction and decision you gave it, anything it promised you, and what it was about to do;
2. saves it with `lodestar handoff --body "…"`;
3. ends its turn.

Lodestar waits until the leader is idle, clears the session (`/clear` in Claude Code, `/new` in pi), and starts the fresh one with the run and the note. Tasks, crewmates and messages don't need to go in the note; they're in the run's state already. Messages that arrive in between wait in the inbox.

Keep the limit below your agent's own auto-compact point, so the handoff happens first. Codex leaders aren't asked to hand off.

## Handing work off without supervising

When nobody needs to track the result, skip the run entirely:

```sh
lodestar spawn fix-login --prompt "The login form double-submits on Enter. Find out why and fix it."
lodestar spawn fix-login --worktree new --kind codex --prompt "…"
```

`spawn` opens a new tab, starts an agent and types your prompt in, word for word. There's no run, no task, no report and no questions. It's much cheaper than a supervised crewmate. With `--worktree new` it gets a checkout on branch `lodestar/spawn/<name>`.

Lodestar never closes a spawned tab or removes its worktree. Write the prompt like a task spec: it's the only thing the agent gets.

## Crewmates with crewmates of their own

A crewmate whose task is itself a fan-out can lead a **sub-run**. Ask for it in the spec ("split this into parallel crewmates and coordinate them"); otherwise crewmates do their task themselves. The crewmate then runs the same commands a leader does, from its own pane:

```sh
lodestar run create --objective "Port the three exporters"
lodestar crew start csv --spec "…"
lodestar check --wait --timeout 540000
lodestar run close --run <sub-run id>
lodestar done --outcome succeeded --summary "…"
```

Things to know:

- From that pane, leader commands act on the sub-run, while `done`, `ask`, `note` and the rest still go to the run that started the crewmate.
- A sub-run has no sidebar or Navigator.
- The crewmate can't report `done` while its sub-run is open.
- `run close` on the parent refuses while a sub-run is open, unless you pass `--release` or `--force`, which close the sub-runs first.
- Depth is limited by `LODESTAR_MAX_RUN_DEPTH`. The default, 1, lets crewmates of a top-level run lead a sub-run but not their crewmates. `0` turns sub-runs off.
