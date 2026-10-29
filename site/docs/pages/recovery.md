# Recovery and cleanup

Shells time out, panes crash and agents wander off. This page covers getting a run back on track, and tidying up afterwards.

## A command whose result you never saw

If a command might have run but you didn't see its output, running it again could do the thing twice. Give mutating commands a request id of your own, and repeat the exact same command with the same id:

```sh
lodestar worker start api --spec "…" --retry-request start-api-1
```

- If the first one finished, you get its recorded result back (marked `replayed_request`) and nothing else happens.
- If it's still running, the retry is refused with `request_running`.
- If its process died before recording a result, you get `request_outcome_unknown`: look at the run, and only use a new id if it didn't take effect.

`lodestar request show start-api-1` says whether a request `completed`, is `pending`, or is `absent`. Absent doesn't prove nothing happened. Request records are kept for a week.

## A worker you can't account for

If a worker's host is unreachable, its pane is in a state you can't read, or you want to take it over yourself, stop supervising it without pretending it finished:

```sh
lodestar worker abandon parser
```

Its task fails as abandoned and its dispatch is settled, but nothing is touched: the pane, the agent and the checkout stay as they are, and the name is free again.

Compare with `worker release --force`, which closes the worker's tab. Use that only when the pane is already gone with its task still open.

## A leader that crashed

A new session can pick up a run from its own pane:

```sh
lodestar run use r4
```

If the old leader's pane is still open, this is refused. Pass `--takeover` only when that leader is really gone or is handing over. Workers, tasks and messages stay as they were; nudges go to the new pane.

## A worker stuck on a dialog

If `worker start` warns that the worker is stuck on a startup dialog, it never got its task. Read its screen, answer the dialog if it's plainly safe, then send the task again:

```sh
lodestar worker read parser
lodestar worker resend parser
```

## Closing a run

```sh
lodestar run close
```

- It refuses while a worker still owes a report. Wait for the reports, or pass `--release` to release every worker (their tasks are marked failed with "run closed"), or `--force` to close anyway.
- It closes the run's sidebar, unless another active run still uses it.
- A closed run is read-only. `status`, `task list`, `worker read`, `dispatch show` and the other read commands still work on it until it's pruned.

## Pruning old runs

Closing a run also cleans up: it keeps the five most recently closed runs and deletes the rest, with their records and saved screens, and removes clean checkouts of released workers. To do it on demand:

```sh
lodestar run prune --dry-run            # see what would go
lodestar run prune                      # keep the 5 most recent
lodestar run prune --keep 10
lodestar run prune --older-than 2d      # units: s m h d w
lodestar run prune --all
```

Active runs are never pruned. Neither are checkouts that are live, dirty, existing ones you passed in, or protected after an uncertain release.

## Where the state lives

Everything is in `~/.local/state/herdr/plugins/lodestar/`: atomic, lock-protected records of runs, tasks, workers, messages, dispatches and gates, plus saved worker screens. It's outside every agent's context, which is what lets a run survive a cleared session.
