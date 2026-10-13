# feat/liveness: layered liveness, stall detection, actionable worker list

## What changed

- `sync()` (src/inbox.ts) stores a verdict per worker: `liveness`
  (`live` | `unverifiable` | `exited`), `liveness_reason`, `missing_since`.
  Agent in its pane → live. Pane alive without an agent for longer than
  `START_GRACE_MS` (30 s, timed from `agent_missing_since`) → unverifiable,
  reason "agent gone, pane alive". Pane absent from two consecutive syncs →
  exited (status `exited`, task failed, `exited` attention, as before).
- herdr unreachable: verdicts untouched; every active run gets
  `herdr_unreachable_since` (first failure time, cleared on the next good
  sync). `check`, `status` and `worker list/show` print it as `warning`.
- New attention statuses: `unverifiable` (once per dispatch, tracked by
  `Worker.unverifiable_dispatch`) and `stalled` (owes a report and
  `now - last_seen > PACK_STALL_MS`, default 20 min; deduped by
  `Worker.stalled_since`).
- `touch()` refreshes `last_seen` and clears `stalled_since`. Called by
  `heartbeat`, `done`, `ask` (new question and `ask --id` resume), a herdr
  state change seen while the agent is present, and a new dispatch
  (`markDispatched`).
- `workerSummary` rows gain `last_seen`, `liveness`, `liveness_reason`,
  `missing_since`/`stalled_since` (when set), `attention: {categories,
  requires_action}` and `next_action` (argv or null). `pack-leader status` text
  shows liveness and a `next:` line per worker.
- `check --wait` writes `{"waiting":true,"elapsed_ms","pending","workers"}` to
  stderr every `PACK_WAIT_HEARTBEAT_MS` (default 15000, 0 disables; tests set 0).
- Sidebar: glyph/word for `unverifiable` (red ?, NO AGENT) and `stalled`
  (red ◌, STALLED).

## Decisions

- Pane absence no longer gets the start-grace exemption: the two-consecutive-
  syncs rule is the debounce. Agent absence still gets the grace.
- Status changes only refresh `last_seen` when herdr reports an agent in the
  pane; the agent vanishing or the pane closing is not a sign of life.
- No `stalled` alert while the worker has an unanswered `ask`: the next move is
  the orchestrator's. Stall needs `liveness === "live"` (unverifiable/exited
  have their own alerts). `PACK_STALL_MS=0` disables stall detection.
- `pending` in the wait heartbeat counts dispatched tasks still owing a report
  (unacked messages are always 0 while waiting).
- `next_action` priority: open ask → reply; exited with its task dispatched or
  failed by exit → `release --force`; any other unacked attention → `worker
  read`; else null. A `done` report awaiting ack is not counted as an alert.
- `attention.categories` uses `ask` for questions and the attention `status`
  otherwise.

All new state fields are optional; state stays `version: 1`.
