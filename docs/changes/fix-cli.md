# fix/cli: close out the review items owned by src/cli.ts

Items: B4, B8, E3, E6, E9, V1, V2, V4, V7/S10, V8, T8, T10, S23 (rows in
docs/review/findings-status.md), plus the 7 "Guide changes needed" of
docs/review/final-code-review.md applied to docs/guide.md and, where it repeats
them (1, 3, 4, 5), README.md.

## What changed

- **task update (B4)**: `refuseTransition()` is the whitelist. A dispatched task
  is refused as before (even with `--force`); a succeeded task changes status
  only with the new `--force`; pending/blocked/failed move freely; setting the
  same status again (a new `--summary`) is allowed. Back to `pending` clears
  `worker`, `dispatch_id` and `outcome` (and ignores `--summary`).
- **run create (B8, V2)**: `--cwd` is resolved against the process cwd and must be
  an existing directory, checked before anything is written. Every step after
  the run is committed is in one try: a failure becomes `warning` next to the
  printed run, so the run id is never lost.
- **check --ack (E3)**: bare `--ack` is a usage error. Ids that are no message of
  the run are listed in `ack_unknown` (with `ack_warning`), also under `--wait`.
  The existing `acked: 0` + `ack_warning` for "matched nothing" is unchanged.
- **workspaceOf (E6)**: `export function workspaceOf(paneId)` in src/cli.ts
  validates a `workspace:pane` id (`w5:p2` -> `w5`, anything else -> null); here()
  and openSidebar use it. src/cli.ts now runs `main()` only under
  `import.meta.main`, so it can be imported (tests do).
- **worker show (E9)**: messages filtered by the worker's run.
- **task create (V1)**: a dependency that is failed or blocked adds a `warning`;
  the task is still created (exit 0).
- **done --report-path (V4)**: resolved against the cwd `done` runs in, in
  cli.ts, before inbox.ts stores it. No inbox.ts change needed.
- **usage() and guide (V7/S10)**: every accepted flag is in both, including a
  `lodestar COMMAND ... [--run ID]` line and a
  `lodestar WORKER-COMMAND ... [--worker NAME] [--run ID] [--task ID] [--dispatch ID]`
  line (uppercase words are ignored by the drift test's command parser). The
  "Less common flags, not in the list above" list became "What the less obvious
  flags do". test/skill.test.ts needed no change.
- **--direction (V8)**: an error with `--placement tab`; `--direction` alone
  still implies split; a split without it goes right (help and guide say so).
- **here() (T10)**: `here(env = process.env, cwd = process.cwd())`, exported; a
  context JSON that parses to a non-object counts as none.
- **herdr-plugin.toml (S23)**: a comment explains the relative `src/cli.ts`
  convention instead of switching the commands, so `herdr plugin action list`
  is unchanged. I did not `herdr plugin link` this worktree: that would have
  replaced the live plugin the orchestrator runs on. The line-2 "sibling panes"
  comment (left over from S5) now says hidden tabs.
- **event (from the runtime worker)**: `event` syncs when the payload has a
  `tab_id` too, for the `tab.closed` hook fix/runtime adds to herdr-plugin.toml.

Tests: test/cli.test.ts (12 tests; the CLI as a child process with a temp state
dir, a socket path nothing listens on and `--no-sidebar`; B8 uses a fake herdr
binary via `HERDR_BIN_PATH` that takes the state lock, so that test takes ~5 s).

## Requests for other owners

- **src/workers.ts (runtime worker)**: the tab placement still does
  `(o.targetPane ?? o.run.orchestrator.pane_id)?.split(":")[0]` (~l.192). Replace
  it with `workspaceOf(...)` from src/cli.ts (`import { workspaceOf } from "./cli.ts"`
  is safe now that cli.ts only runs main() as the entry point). If importing
  the CLI module from workers.ts feels wrong, moving `workspaceOf` to
  src/paths.ts (state worker) is the alternative; cli.ts would then re-export it.
- **guide wording 2** says `worker prompt` prints a `warning` and exits 1 when the
  prompt may not have landed. fix/runtime makes a prompt that definitely failed
  throw instead; the wording still holds for the warning case, but the
  integrator may want a sentence for the thrown error.
