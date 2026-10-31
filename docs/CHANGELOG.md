# Changelog

## Unreleased: usage pane and Rex

- A **Usage** pane below the sidebar shows what each agent (Claude Code, Codex, pi) spent
  over the last day and week, and how much of each plan limit is used. The sidebar opens
  it and it closes with the sidebar. Given the width, it lays the numbers out as a table
  with a total row. `lodestar usage --watch` shows the same anywhere; `lodestar usage`
  prints it as JSON.
- **Rex** works as a multiplexer next to herdr and tmux: inside a Rex terminal Lodestar
  uses Rex (or set `LODESTAR_MUX=rex`). The skill now accepts herdr, tmux or Rex.
- On Rex, agent status comes from Rex itself: Claude Code, Codex and fx report it to Rex,
  and Lodestar no longer adds hooks or writes status files there. pi gets a small extension
  (`pi -e`) that reports to Rex the same way (under tmux, to Lodestar).
- **fx** (Vercel) is a crewmate type: `--kind fx`, or pick it under Harness in settings.
- A Codex crewmate waiting at Codex's "Hooks need review" prompt shows as blocked, not `?`.
- On Rex the sidebar column is 30% of the window and keeps that size with the app attached.
- On Rex, crewmates placed beside the leader tile the right half as they do on herdr,
  instead of each one splitting off the leader.
- On Rex, `p` in the crew pane opens the selected crewmate in a **popup** floating over
  your tab: its screen, kept up to date, and what you type goes to it. ctrl-] closes it.
  Turn it off under Popup in the settings or with `lodestar config set --popup off`.
- On Rex, crewmates can run with **no tab** at all: Placement "no tabs", or
  `--placement background`. They show in the crew pane, and Enter opens one as a popup.
- The settings page hides what the multiplexer can't do: Popup and "no tabs" show under
  Rex only. A config asking for no tabs gives hidden tabs under herdr and tmux.
- In the crew pane, `r` is now called preview (the last lines of a crewmate), next to `p`.
- The website moved to [dea.dev/lodestar](https://dea.dev/lodestar/).

## Unreleased: the crew and the navigator

- Workers are now the **crew**, each one a **crewmate**: `lodestar crew start|list|show|…`
  (was `lodestar worker …`), `--crewmate` (was `--worker`), `LODESTAR_CREWMATE` (was
  `LODESTAR_WORKER`). The sidebar pane is titled "Crew".
- The observer (the "Advisor" pane) is now the **navigator**: `lodestar navigator [--close]`,
  `run create --no-navigator`, the `navigator` setting. `lodestar observe` is `lodestar survey`.
- The old command names, flags and environment variables still work; old commands print
  their new name.
- state.json moves to version 2 on first use (`workers` → `crewmates` and the matching
  fields); crewmate names are kept as they are.

## Unreleased: orchestration parity with Orca

- `check` returns the whole backlog in `messages` (oldest first, up to 50), so one
  wake handles every waiting report; `message` still holds the oldest.
- `lodestar spawn NAME --prompt "..."`: an unsupervised full handoff (new tab,
  optional worktree, prompt verbatim, no run or tracking).
- `--retry-request ID` on mutating commands and `request show ID`: a retried
  command replays its recorded result instead of acting twice.
- `worker abandon`: stop supervising without claiming the agent stopped.
- Retry limit: three failed attempts in a row block further dispatch of a task
  (`retry_limit`; `LODESTAR_MAX_FAILED_ATTEMPTS`; reset with `task update --status pending`).
- `task list --ready --status --brief`, and a read-only `check --all [--limit N]`.
- Decision gates: `gate create --options`, resolved with `gate resolve --choice`.
- `escalate`: an escalation message that requires the orchestrator to act;
  heartbeats take `--phase`, shown on worker rows.
- Sub-runs: a worker can lead workers of its own from its pane (`run create`),
  depth-limited by `LODESTAR_MAX_RUN_DEPTH` (default 1).
- `run use ID [--takeover]`, `worker start|prompt --dry-run`, and
  `worker read --source transcript`.

## Unreleased: fewer unreported idles

- A follow-up (from the orchestrator or another worker) delivered into a worker
  that still owes a report now ends with a reminder to carry on and report with
  `lodestar done`. Most "idle without having reported" attention alerts came
  from workers answering a follow-up and then ending their turn.

## Unreleased: opt-in model routing

- New workers can use **OpenAI Decisions** or **TypeSafe Jev** to select a model
  and effort from approved per-harness profiles. Routing is off by default;
  explicit model/native model or effort selections bypass it, and an explicit
  `--thinking` is preserved.
- `config set --routing-config FILE` imports profiles; `config set --router
  off|openai|jev` selects the active provider. `worker start --router` overrides
  it for one new session. Existing sessions are never rerouted.
- Bounded leader-side requests use a configured fallback for unavailable,
  malformed, refused, timed-out, or low-confidence decisions. Admission and
  approval gates remain authoritative, including while a decision is pending.
- Optional dispatch `runtime` and `routing` fields preserve per-attempt choices
  and fallback/bypass reasons without changing state version 1.
- See [Automatic model routing](model-routing.md) for credentials, configuration,
  limits, privacy, and examples. Live provider calls remain unverified; provider
  contracts and local/remote dispatch behavior are tested with fixtures.
- Vercel fx support was deferred: Herdr 0.9.1 does not recognize its agent kind.

## Unreleased: dispatch records, liveness, run hygiene, structured asks, group messaging, worktrees

Six feature branches merged together. Each branch's own decisions are in
`docs/changes/feat-*.md`; this entry folds them into one list and records how
they were made to work together. State stays `version: 1`: every new field and
map is optional, `emptyState()` includes `dispatches` and `worktrees`, and
`load()` accepts files written before any of this.

### Dispatch records and release archives (feat/dispatch)

- `state.dispatches`: one record per dispatch with `run_id`, `task_id`,
  `worker`, `attempt`, the exact `preamble` sent, `cwd`, `started_at`, and once
  settled `settled_at` + `outcome`; `retry_of` when it retries a failed task;
  `archive_path` / `archive_error`. Helpers live in `src/dispatch.ts`.
- Created by `worker start` and `worker prompt`; `worker resend` re-sends the
  stored text. Settled (first wins) by `done`, a forced release, a worker that
  exited owing a report, an agent that never came up, a start whose worktree,
  tab or pane could not be created, and `run close`.
- Release archives the worker's screen to
  `<stateDir>/archive/<run>/<worker>-<dispatch>.txt` (0700/0600) before closing
  its tab, falling back from a long unwrapped read to herdr's default read to
  the visible screen. `worker read NAME` falls back to the newest archive once
  the worker is gone; `--dispatch ID` reads a given one.
- `lodestar dispatch list [--task] [--worker]` and `dispatch show ID [--preamble]`;
  `task show` adds `dispatch_ids`, `status` counts dispatches per task.

### Liveness, stall alerts and next actions (feat/liveness)

- `sync()` stores `liveness` (`live` | `unverifiable` | `exited`) with a reason:
  agent in its pane is live, pane alive without an agent past 30 s is
  unverifiable, pane absent from two consecutive syncs is exited.
- New attention statuses `unverifiable` (once per dispatch) and `stalled`
  (owes a report, no sign of life for `LODESTAR_STALL_MS`, default 20 min, `0` off;
  never while its own question is open).
- herdr unreachable: verdicts stay, the run records `herdr_unreachable_since`,
  and `check`, `status`, `worker list/show` print a `warning`.
- Worker rows carry `last_seen`, `liveness`, `attention: {categories,
  requires_action}` and `next_action` (the argv to run next).
- `check --wait` writes a JSON heartbeat to stderr every
  `LODESTAR_WAIT_HEARTBEAT_MS` (15 s, `0` off). Sidebar glyphs for `NO AGENT` and
  `STALLED`.

### Run hygiene (feat/hygiene)

- `lodestar run prune [--keep N] [--older-than D] [--all] [--dry-run]` deletes
  closed runs and every record carrying their `run_id` (generic over the state's
  maps and arrays). Plain `prune` keeps the 5 most recent.
- `run close` refuses an already closed run without `--force`, refuses while a
  worker is dispatched unless `--release` or `--force`, fails dispatched tasks
  ("run closed"), releases with `--release`, forgets the rest, and closes the
  sidebar pane unless another active run shows it.
- A closed run named by `--run`/`LODESTAR_RUN_ID` is an error except for read-only
  commands. Task and worker commands check the record belongs to the run.
- `worker release` reports `closed_pane` and `closed_tab`; `status --all` lists
  closed runs.

### Structured questions (feat/ask)

- `ask --options a,b,c`; `reply` must name an option (exact, case-insensitive,
  or a unique prefix) unless `--free`. The reply carries `answer` and
  `option_index`; `check` adds `options` and a `reply_hint` to paste.
- The sidebar box builder is `boxLines()`; an open ask shows its question and
  `[a | b | c]` in yellow, a reply shows its answer.

### Group messaging and notes (feat/groups)

- `send` to `@all`, `@idle`, `@<kind>`, expanded at send time, one follow-up
  per recipient; an address that matches nobody is an error.
- Worker side: `lodestar note "text"` (non-blocking, surfaces in `check`) and
  `lodestar send <worker> "text"` to another worker of the same run, delivered
  with a `[lodestar follow-up from worker <sender>]` prefix.
- `check --types` is validated against `done, ask, attention, note`.

### A worktree per worker (feat/worktree)

- `worker start NAME --worktree new|PATH [--base REF] [--branch B]`, planned
  before anything is created; herdr's `worktree.create`/`open` with a
  `git worktree add` fallback; `state.worktrees` keeps the record after release.
- `worker release --remove-worktree` removes only a worktree Lodestar created,
  never forced; the branch is never deleted. Two active workers never share one.

### How the features fit together

- `run close` settles the dispatch records of the tasks it fails (and any other
  open dispatch of the run), and `--release` goes through `releaseWorker`, so
  every released worker's screen is archived; its `released` entries carry
  `archive_path` and `worktree` too. Workers it only forgets get their
  worktree record marked released.
- `run prune` also deletes the pruned runs' `archive/<run>` directories (their
  dispatch records, which point at them, are gone); `--dry-run` deletes nothing.
  Worktree records go with their run; worktrees on disk are never touched.
- `dispatch list|show` resolve the run with closed runs allowed (read-only), and
  `show` refuses a dispatch of another run. `worker read` resolves its run the
  same way; its archive fallback still works for a released worker of a closed
  run, and a name that is neither live in the run nor archived is an error.
- One `sync()` does liveness verdicts, `unverifiable`/`stalled` attention,
  exited-owing-report failure with dispatch settlement, and follow-up delivery,
  including queued worker-to-worker follow-ups with their sender's prefix. The
  `exited` verdict now needs two consecutive syncs, so the dispatch settlement
  test syncs twice.
- Signs of life (`last_seen`, re-arming a stall) include `note` and a worker's
  `send` as well as heartbeat, ask, done and herdr state changes. A worker
  cannot send inside a closed run.
- `attention.categories` lists `note` for an unacked note, but a note alone
  does not set `requires_action` or a `next_action`. For an ask with options,
  `next_action` reads `--body "<one of: a | b>"`.
- `boxLines()` renders the liveness glyphs and words, notes, asks with options
  and answers; the sidebar's empty state stays one line.
- `worker release` prints `closed_pane`, `closed_tab`, `archive_path` (or
  `archive_error`) and, with a worktree, `worktree`.
- The preamble is one list of rules: the task's directory, the worktree line
  when there is one, `ask` (with `--options`), `note`, `send` to another worker,
  `inbox`, `heartbeat`, `done`; the first line names the dispatch id. The
  stored dispatch preamble is exactly what was sent, so `resend` repeats the
  worktree line.
- `lodestar help`, the header of `src/cli.ts`, the Commands block of
  `docs/guide.md` and the README list every command and flag once, grouped as
  runs, tasks, workers, messaging and worker side.
