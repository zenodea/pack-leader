# feat/groups: group addresses and worker-originated messages

## What changed

- `lodestar send` takes a group address as well as a name: `@all` (workers whose
  task is dispatched), `@idle` (live herdr status idle or done, read with one
  `agent.list` at send time), `@<kind>` (by `Worker.kind`). Expansion happens at
  send time; each recipient gets its own followup through the existing
  `send()`/`deliver()` path. The result is `{ address, recipients: [{ worker,
  message_id, delivered }] }`; a plain name also keeps the old top-level
  `message` and `delivered` keys so existing callers keep working.
- An address that expands to nobody throws with the reason (per-worker task
  status, live status, or the kinds present). Nothing is stored in that case.
- `lodestar note "text"` (worker side) stores a `note` message to the
  orchestrator, unacked, and nudges an idle orchestrator once, like `ask` but
  without waiting. The sidebar shows it in the worker's box (`note: ...`), and
  the dispatch preamble gained one line pointing at it.
- `lodestar send <worker> "text"` from a worker pane (detected by `LODESTAR_WORKER`
  in the environment) goes through `workerSend()`: same run only, not to itself,
  no group addresses. The followup is stored with `from=<sender>` and the prompt
  prefix is `[lodestar follow-up from worker <sender>]`; queued ones keep that
  prefix when `sync()` delivers them. `lodestar inbox` output now includes `from`.
- `check` filters by `CHECK_TYPES = done, ask, attention, note` by default and
  validates `--types` against that set (in the CLI before any `--ack`, and in
  `check()` itself).

## Decisions

- The orchestrator's prompt prefix is unchanged (`[Lodestar follow-up from the
  orchestrator]`); only worker-sent followups use the new lowercase form the
  spec named.
- A worker pane always sends as that worker; `--run`/`--worker` flags cannot
  turn a worker send into an orchestrator (group) send.
- `@all` and `@idle` take precedence over a kind with the same name.
- `@idle` fails loudly when herdr does not answer, rather than falling back to
  the recorded `last_status`, since the spec asks for live status.
- Tests live in a new `test/groups.test.ts` (same fake herdr socket pattern as
  `test/inbox.test.ts`) to keep merges with sibling branches simple.
