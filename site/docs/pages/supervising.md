# Supervising a run

Most of a run is the leader waiting for messages and dealing with them. This page covers that loop, what each message means, and how you can keep an eye on things yourself.

## The loop

The leader starts every worker it can start right away, then waits:

```sh
lodestar check --wait --timeout 540000
```

`check --wait` returns the moment a message arrives, so a long timeout costs nothing. Waits shorter than five minutes are raised to five minutes, because a short wait comes back empty and each return costs the leader a full model call. A `timeout` result isn't a failure: the leader looks at `lodestar status` and waits again.

When messages come back, the leader handles every one of them, then acknowledges them in the next wait:

```sh
lodestar reply m7 --body "Use the existing helper in src/net.ts; don't add a dependency."
lodestar check --ack m7,m8,m9 --wait --timeout 540000
```

Only `--ack` marks a message handled. A plain `check`, or looking at a message in the sidebar, doesn't.

## What each message means

| Type | What happened | What the leader does |
| --- | --- | --- |
| `done` | The worker finished its task, `succeeded` or `failed` | Check the work, then give it another task, keep it, or release it |
| `ask` | The worker is blocked on a question | `reply` to it. If the question came with options, pick one |
| `note` | A worker wants the leader to know something | Read it, act if needed, ack it |
| `escalation` | The worker needs the leader to act and keeps working meanwhile | Act (a follow-up, a spec change, a gate, a stop), then ack it |
| `attention` | Lodestar noticed something: the worker went idle without a report, is blocked on a prompt, went quiet, or its pane is gone | Read its screen, then nudge it or release it |
| `user` | You said something with `lodestar say` (or through the Advisor) | Treat it as an instruction from you |

A worker that owes a report and shows no sign of life for 20 minutes raises a `stalled` alert. Change that with the stall setting, or `0` to turn it off.

## Answering questions

```sh
lodestar reply m9 --body "sqlite"
lodestar reply m9 --body "sq"                         # a unique prefix works too
lodestar reply m9 --free --body "Neither: keep the JSON file."
```

When a question has options, the answer has to be one of them. `--free` answers outside them.

## Following up

`send` gives one or more workers a follow-up. It's typed into the worker's prompt when it's ready for input, or queued for its next `inbox` check:

```sh
lodestar send parser "Also handle a UTF-8 BOM at the start of the file."
lodestar send @all "Report your test command and its output."
```

| Address | Who gets it |
| --- | --- |
| `parser` | That worker |
| `@all` | Every worker that still owes a report |
| `@idle` | Every worker that's idle or done right now |
| `@claude`, `@codex`, `@pi` | Every worker of that kind |

`--now` delivers straight away instead of waiting for the worker to be ready.

## Seeing what's going on

```sh
lodestar status                 # the run, its tasks and workers
lodestar status --all           # every run, including closed ones
lodestar worker list            # liveness, attention and the next thing to do, per worker
lodestar worker read parser     # its screen, live or archived
lodestar worker read parser --source transcript --turns 10
lodestar worker focus parser    # bring its tab up
```

Each worker row has:

- **liveness**: `live` (agent seen in its pane), `unverifiable` (pane there, no agent for 30 seconds) or `exited` (pane gone).
- **attention**: what its unhandled messages are about, and whether any need action.
- **next_action**: the exact command to run next, or `null` if nothing is needed.

Idle isn't done. A worker sitting quietly at its prompt hasn't finished until it reports `done`, or there's proof it stopped.

## The sidebar

On herdr, the **Workers** pane shows the run's goal and one box per worker: agent, runtime, state, task, and the last thing it said. An open question shows its choices.

| Key | Does |
| --- | --- |
| Click | Select a worker |
| Enter, or click again | Open its tab |
| `o` | Back to the leader |
| `u` | Unread: reports, questions, notes and alerts the leader hasn't handled |
| `y` | From you: your messages the leader hasn't picked up |
| `j` / `k`, arrows | Move through a list |
| Esc | Back out, from a message to the list to the workers |

These views are read-only. Opening a message doesn't acknowledge it.

Each worker tab has a two-line **Back to leader** bar on top: click it, or press Enter, `o` or Space while it has focus.

With placement set to "beside the leader" there's no sidebar. The leader keeps the top left, the Advisor the bottom left, and workers fill the right half.

## The Advisor

The Advisor is a second agent under the leader, there to answer your questions about the run. It reads `lodestar observe` (the run, its workers, unread messages and the leader's last few turns) and, when you ask about a specific worker, that worker's screen.

It can't steer workers, acknowledge messages or edit files. If you want the leader to know something, tell the Advisor to pass it on, or say it yourself:

```sh
lodestar say "Leave the docs task for last."
```

`lodestar observer` reopens it if you closed it; `lodestar observer --close` closes it.

## When a worker finishes

After a `done` report, the leader does one of three things with the worker:

1. **Reuse it**: `lodestar worker prompt parser --spec "…"` gives it the next task in the same session.
2. **Keep it**: `lodestar worker retain parser`, when you want its pane left open.
3. **Release it**: `lodestar worker release parser` saves its screen and closes its tab. A worktree it made is removed if it's clean; its branch is always kept.

To interrupt a worker mid-turn, `lodestar worker stop parser`. That's an interruption, not a report: the task stays open.
