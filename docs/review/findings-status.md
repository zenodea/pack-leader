# Review findings: status

Every item of the original read-only review (core.md: state/cli, runtime.md:
workers/herdr/inbox, surface.md: manifest/sidebar/docs/packaging), checked
against the code on main (ccd156f) and then this branch (review/findings).
Report line numbers were stale and items were matched by description. Evidence
line numbers refer to ccd156f unless the item is marked fixed-now.

Statuses: **fixed-in-wave-1** (812d9a0: state env leak, corrupt state moved
aside, follow-up claim-before-prompt, cap keeps unacked, late replies, truncate
close, repeated flags), **fixed-in-wave-2** (the feature merges in
docs/CHANGELOG.md, 5e1c9d2..c4b9a38), **fixed-now** (this branch), **still-open**
(with the owning file), **obsolete** (the premise no longer holds). No item was
set to wontfix: nothing in the code or docs records a decision against one.

Totals (101 items plus one new finding): fixed-in-wave-1: 13 · fixed-in-wave-2: 17 · fixed-now: 25 · still-open: 44 · obsolete: 3 · wontfix: 0.

Ids: core.md keeps its own (B bugs, E edge cases, V validation, T tests);
runtime.md item n is Rn; surface.md item n is Sn.

## core.md (state, cli)

| id | description | status | where fixed / why still open |
|---|---|---|---|
| B1 | resolveRun reads process.env.WOLF_RUN_ID directly; suite fails inside a worker pane | fixed-in-wave-1 | state.ts:274-279 `resolveRun(state, opts, env = process.env)`; state.test.ts:64 passes `env = {}`; 13/13 pass with PACK_RUN_ID=rc set (812d9a0) |
| B2 | corrupt/wrong-version state.json silently becomes emptyState and is persisted over | fixed-in-wave-1 | state.ts:164-190 renames to `state.json.corrupt-<ts>`, logs `state.corrupt`, throws if rename fails (812d9a0) |
| B3 | stale-lock sweep keys on lock mtime never refreshed; long async update() callback can lose its lock | fixed-now | state.ts acquire() writes {pid,host} to state.lock/owner; lockIsStale() sweeps a dead owner at once, an ownerless lock after 30 s, any lock after 10 min; a live holder keeps it; rename-aside sweep; test/state.test.ts (child process holds the lock) |
| B4 | task update allows succeeded->pending and keeps old worker/dispatch_id/outcome | fixed-now | cli.ts `refuseTransition()` whitelist: dispatched never (settles via done/release --force), succeeded only with `--force`; back to pending clears worker/dispatch_id/outcome; test/cli.test.ts T8/V1/B4 + refuseTransition (fix/cli) |
| B5 | task show / task update ignore run scoping | fixed-in-wave-2 | cli.ts:171-176 and 183-186 require `t.run_id === run.id`; covered by runs.test.ts:190-210 (5598c3f feat/hygiene) |
| B6 | run close on closed run succeeds and overwrites closed_at; resolveRun returns closed run by id | fixed-in-wave-2 | runs.ts:109 refuses without --force; state.ts:283 closed run only with allowClosed; probe: 2nd close errors (5598c3f) |
| B7 | save() has no fsync before rename; crash can leave empty state.json | fixed-now | state.ts save(): write via fd + fsyncSync, rename, fsync the dir; test/state.test.ts "save: creates the file's own dir..." |
| B8 | run create: second update() for sidebar_pane_id can fail after run committed; caller gets no run id | fixed-now | cli.ts run create: everything after the run is committed (log, label, sidebar open + record) is in a try; a failure adds `warning` next to the printed run; test/cli.test.ts B8 (fake herdr holds the lock) (fix/cli) |
| E1 | value starting with `--` cannot be passed as `--flag value` (e.g. `reply m5 --body "--no"`) | fixed-now | args.ts TEXT_FLAGS: --body and --summary always take the next token (reply/send/ask/heartbeat/note --body, done --summary); other flags use --flag=value; test/args.test.ts. Guide wording requested in docs/changes/fix-state.md |
| E2 | repeated `--depends-on a --depends-on b` keeps only last; comment promised join | fixed-in-wave-1 | args.ts:11-15 `set()` comma-joins repeats, header comment updated; args.test.ts:167-179 (812d9a0) |
| E3 | bare `--ack` silently ignored; unknown ack ids warn then continue | fixed-now | cli.ts check: bare `--ack` is a usage error; ids that are no message of the run are listed in `ack_unknown` with `ack_warning`; guide change 4 applied; test/cli.test.ts E3 (fix/cli) |
| E4 | `--types` not validated; typo filters to nothing and `--wait` blocks | fixed-in-wave-2 | inbox.ts:534-542 `checkTypes()` against done/ask/attention/note; cli.ts:339 validates before acking (5e1c9d2 feat/groups) |
| E5 | run selection matches worker pane / explicit id of a closed run; commands mutate closed run | fixed-in-wave-2 | state.ts:283 explicit closed id errors unless allowClosed; :290 worker pane requires active run; state.test.ts:83-99 (5598c3f) |
| E6 | workspace inferred as text before `:` of pane id in two places; no validating helper | fixed-now | cli.ts exports `workspaceOf(paneId)` (validates `w5:p2`, else null), used by here() and openSidebar; cli.ts runs main() only under import.meta.main so it can be imported. workers.ts tab placement (~l.192) still splits ad hoc: requested in docs/changes/fix-cli.md (runtime worker); test/cli.test.ts T10/E6 (fix/cli) |
| E7 | orphaned state.json.<pid>.tmp files never removed | fixed-now | state.ts save() sweeps `<file>.<digits>.tmp` older than 60 s (sweepTmp); test/state.test.ts |
| E8 | log truncation drops whole events.jsonl history at 2 MB | fixed-now | state.ts log() renames events.jsonl to events.jsonl.1 past LOG_MAX_BYTES instead of truncating; test/state.test.ts |
| E9 | worker show lists messages by name across all runs; reused name leaks other run's traffic | fixed-now | cli.ts worker show filters messages by `m.run_id === w.run_id`; test/cli.test.ts E9 (fix/cli) |
| E10 | orchestrator (HERDR_PLUGIN_STATE_DIR) and worker panes (XDG fallback) may use different stateDir | still-open | workers.ts:130 worker env has only PACK_* vars, no HERDR_PLUGIN_STATE_DIR; paths.ts:76 unchanged. Owner: src/workers.ts (other) |
| E11 | run close leaves sidebar_pane_id set and pane open; next run opens second sidebar | fixed-in-wave-2 | runs.ts:142-163 clears sidebar_pane_id and closes pane unless shared; cli.ts:481-493 reuses any live sidebar (5598c3f, c4b9a38) |
| V1 | task create accepts a dependency on an already failed/blocked task without warning | fixed-now | cli.ts task create adds `warning` naming each failed/blocked dependency (task still created); test/cli.test.ts T8/V1/B4 (fix/cli) |
| V2 | run create `--cwd` not checked to exist or be absolute | fixed-now | cli.ts `runCwd()`: `--cwd` resolved against the process cwd, must be an existing directory, checked before the run is written; test/cli.test.ts T8/V2 + runCwd (fix/cli) |
| V3 | worker read/focus/stop/retain take any NAME with no run check | fixed-in-wave-2 | cli.ts:55-60 `runWorker()` used at :276, :281, :288; read checks run at :264-270; runs.test.ts:213-218 (5598c3f) |
| V4 | `done --report-path` stored as given, may be relative to worker cwd | fixed-now | cli.ts `reportPath()` resolves `--report-path` against the cwd `done` runs in before inbox.ts stores it; test/cli.test.ts V4 (fix/cli) |
| V5 | `ask --id X` does not verify X is an ask from this worker; wrong id waits full timeout | still-open | inbox.ts:186-191 resume path only looks up options (defaults []), no existence/owner check before polling. Owner: src/inbox.ts (other) |
| V6 | message type `note` has no producer | fixed-in-wave-2 | `pack-leader note` cli.ts:417-424 -> inbox.ts note() (~:150-163) creates type "note" (5e1c9d2 feat/groups) |
| V7 | usage() omits --another, --target-pane, --ratio, --title, --no-default-args, --timeout, --body, overrides, cmds | fixed-now | usage() lists --run, run create --another/--cwd/--left, task update --summary/--force, worker start --title/--target-pane/--ratio/--no-default-args/--timeout, worker prompt --title, --body forms, worker-side --worker/--run/--task/--dispatch; guide Commands block matches (drift test in test/skill.test.ts passes) (fix/cli) |
| V8 | `--direction` with `--placement tab` silently ignored; split without direction defaults right | fixed-now | cli.ts worker start: `--direction` with `--placement tab` is an error; help and guide say a split without --direction goes right; test/cli.test.ts V8 (fix/cli) |
| T1 | update() concurrency test: serialisation, timeout text, stale sweep | fixed-now | test/state.test.ts: 4 processes x 25 update() lose nothing; live child holds the lock -> timeout text; killed child -> swept; ownerless/abandoned/other-host staleness |
| T2 | update() rollback test: callback throws -> file unchanged, lock released | fixed-now | test/state.test.ts "update: a throwing or async callback changes nothing and releases the lock" |
| T3 | load() on invalid JSON and version 2 | fixed-in-wave-1 | state.test.ts:22-61 covers parse error, version 2, missing file (812d9a0) |
| T4 | nextId: prefix, base36, strictly increasing, survives save/load | fixed-now | test/state.test.ts "nextId: prefix plus base-36 counter..." |
| T5 | resolveRun with injected PACK_RUN_ID, closed explicit run, worker pane of closed run | fixed-in-wave-2 | env injection state.test.ts:79-80 (812d9a0); closed-run cases state.test.ts:83-99 (5598c3f) |
| T6 | parseArgs: `--k=` empty, value starting with `--`, repeats, single-dash, num on bare flag | fixed-in-wave-1 | args.test.ts:167-201 cover all five (`--timeout --wait` pins the `--` value rule) (812d9a0) |
| T7 | paths.ts: state dir env precedence and herdrSocketPath three branches | fixed-now | new test/paths.test.ts: resolveStateDir precedence, stateDirDivergence, herdrSocketPath three branches |
| T8 | CLI integration via child process: run create -> task create -> task update, dispatched refusal | fixed-now | test/cli.test.ts: run create (--cwd), task create (dep warning), task update rules and the dispatched refusal, all through `node src/cli.ts` with a temp HERDR_PLUGIN_STATE_DIR and --no-sidebar (fix/cli) |
| T9 | log() truncation at 2 MB | fixed-now | test/state.test.ts "log: past the size limit events.jsonl is rotated..." (log() takes maxBytes) |
| T10 | here(): context JSON precedence over env, malformed JSON, workspace-from-pane fallback | fixed-now | here(env, cwd) exported from cli.ts; test/cli.test.ts covers context JSON precedence, malformed/non-object JSON, empty strings, workspace-from-pane fallback (fix/cli) |

## runtime.md (workers, herdr, inbox)

| id | description | status | where fixed / why still open |
|---|---|---|---|
| R1 | Start not atomic with live-agent check: two concurrent `worker start NAME` can both pass | still-open | workers.ts:86-87 `listAgents()` still outside the lock; the first `update()` (l.91-128) only refuses an already recorded worker, and the record is written later (l.180), after the tab/pane exists, so no name reservation. Owner: src/workers.ts |
| R2 | Task/dispatch allocated before tab/pane exists; nothing rolled back if tab.create/pane.split throws | still-open | Partly addressed in wave 2 (d2579e5): catch at workers.ts:155-158 settles the dispatch record as failed. A fresh `--spec` task is still left `pending` with no worker and the dispatch id is burned; no delete/rollback of the task. Owner: src/workers.ts |
| R3 | One missing `pane.list` entry after grace fails the task at once | fixed-in-wave-2 | 9bb74d2 (feat/liveness): inbox.ts:446-456 `missing_since`; `paneGone` only on the second consecutive miss; status `exited` and task failure only then (l.469, 495). Tested in liveness.test.ts:122,150 |
| R4 | Follow-up double delivery from concurrent `sync()` calls | fixed-in-wave-1 | 812d9a0: `deliver()` (inbox.ts:360-382) claims delivered+acked inside the lock before prompting, reverts on failure; sync uses it (l.525). Tested inbox.test.ts:174,204 |
| R5 | `send` vs `sync` double delivery (send prompts without a claim) | fixed-in-wave-1 | 812d9a0: `send()` (inbox.ts:250-265) stores undelivered then goes through `deliver()`. Tested inbox.test.ts:121,145,160 |
| R6 | `redispatch` prompts without checking the agent is idle | still-open | workers.ts:274 `agentPrompt(name, r.text)` directly, no `getAgent`/`agentWait` for idle/done first. Owner: src/workers.ts |
| R7 | `ask` polls the whole state file every second from every waiting worker | still-open | inbox.ts:195-207 still `load()` + 1000 ms sleep loop; no fs.watch or longer fallback tick. Owner: src/inbox.ts |
| R8 | Message cap (2000) drops unacked messages | fixed-in-wave-1 | 812d9a0: `message()` calls `prune()` (inbox.ts:20-48): acked heartbeats first, then acked, never unacked. Tested inbox.test.ts:65 |
| R9 | A reply to a timed-out ask is never delivered; `inbox` returns only followups | fixed-in-wave-1 | 812d9a0: `inbox()` (inbox.ts:215-224) returns and acks unacked `followup` and `reply` to the worker. Tested inbox.test.ts:98 |
| R10 | Followups queued for a released worker are orphaned | still-open | `releaseWorker` (workers.ts:296-313) and `closeRun` (runs.ts) never ack them. Worse: sync's toDeliver (inbox.ts:520) does not filter by `run_id`, so a later worker reusing the name (any run) gets the stale followups prompted. Owner: src/workers.ts (+ src/inbox.ts:520) |
| R11 | Nudge dropped when the orchestrator is busy; never retried | still-open | `nudgeOrchestrator` (inbox.ts:51-61) prompts only when idle/done, no `nudged_at`, no re-nudge in `sync`; groups.test.ts:183 asserts the busy case is simply skipped. Owner: src/inbox.ts |
| R12 | Tab-placed workers: no `tab.closed` subscription, exit seen only on next poll | still-open | check subscribes only pane.updated/closed/exited (inbox.ts:595); herdr-plugin.toml hooks only pane.closed/pane.exited (l.38-43); no tab.closed anywhere. Owner: src/inbox.ts + herdr-plugin.toml (unassigned) |
| R13 | No stall detection: `last_seen` written but never compared to now | fixed-in-wave-2 | 9bb74d2: inbox.ts:509-517 raises `stalled` attention after `PACK_STALL_MS` (default 20 min), re-armed by `touch()`. Tested liveness.test.ts:162,202 |
| R14 | `unknown` (agent quit to shell, pane alive) never surfaced; task stays dispatched | fixed-in-wave-2 | 9bb74d2: `agent_missing_since` + `unverifiable` liveness past START_GRACE_MS and one `unverifiable` attention per dispatch (inbox.ts:451-462, 503-507); task failed only via `release --force` (nextAction). Tested liveness.test.ts:78 |
| R15 | `blocked` after `done` not reported because `owes=false` | still-open | inbox.ts:485 still `if (owes && settled)`; blocked raises nothing once the task is settled (e.g. a permission prompt from a follow-up). Owner: src/inbox.ts |
| R16 | Redispatch skips the dependency check | still-open | workers.ts:237-240 `redispatch --task` checks only dispatched/succeeded, never `ready()` (startWorker does at l.104). No recorded decision. Owner: src/workers.ts |
| R17 | Worker records from closed runs are silently overwritten by a new start | fixed-in-wave-2 | 5598c3f (feat/hygiene): `closeRun` deletes every worker record of the run (runs.ts:143-150); `run prune` sweeps the rest. Tested runs.test.ts:267,310 |
| R18 | `closed_pane` carries the tab id for tab workers | fixed-in-wave-2 | 5598c3f: `ReleaseResult` has separate `closed_pane`/`closed_tab` (workers.ts:294, 333-345). Tested runs.test.ts:339 |
| R19 | `redispatch` has no prompt retry and no rollback on prompt failure | still-open | workers.ts:274 single `agentPrompt` (not `promptWithRetry`); on throw the task stays `dispatched` under the new ids with no rollback or warning. Owner: src/workers.ts |
| R20 | Preamble failure after 5 tries throws and leaves a phantom dispatch | obsolete | Already changed in baseline f82f032, before both waves: workers.ts:217-223 catches, logs `worker.prompt_failed`, returns a `warning` naming `worker resend` (cli.ts:232 exit code 1). Task stays dispatched by design so `resend` can recover it |
| R21 | `herdr()` resolves `undefined` when `result` is missing; wrappers then TypeError without `.code` | still-open | herdr.ts:58 `resolve(msg.result)` with no presence check; getAgent/getPane/paneSplit/tabCreate (l.95-124) index into it unguarded. Owner: src/herdr.ts |
| R22 | Silent swallows hide leaked panes (release close, labelPane, notify) | still-open | workers.ts:346 `catch {}` around getPane/tabClose/paneClose (only archive failures are logged now); herdr.ts:154,161 `catch {}`; no `herdr.error` log anywhere. Owner: src/workers.ts, src/herdr.ts |
| R23 | `subscribe` retries forever with fixed 1.5 s backoff; sync still waits 15 s per call while down | still-open | herdr.ts:195-199 fixed 1500 ms, no cap/exponential; `check` passes no `onState` and syncs every loop (inbox.ts:595-605). Owner: src/herdr.ts (+ src/inbox.ts) |
| R24 | `check --wait` cannot say "herdr unreachable"; times out silently after 9 min | fixed-in-wave-2 | 9bb74d2: sync sets `run.herdr_unreachable_since` (inbox.ts:425-431); `check` adds `warning` to message/empty/timeout (l.578-599) and to stderr heartbeats. Tested liveness.test.ts:252,276 |
| R25 | `update()` accepts an async `fn`, inviting herdr calls under the 5 s lock | fixed-now | update<T>(fn: (state) => Sync<T>): a promise-returning callback is a type error and throws at run time before save; all call sites were already sync, so no lock refresh is needed; test/state.test.ts |
| R26 | inbox.ts/workers.ts untested beyond the preamble string | still-open | Largely addressed (812d9a0 inbox.test.ts; wave 2 dispatch/liveness/groups/ask/runs/worktree tests, 93 pass). Gaps left: herdr() transport (timeout/unreachable/foreign id/missing result), done stale/double dispatch, redispatch refusal + suffix, split placement, release refusing without --force. Owner: test/ for src/herdr.ts, src/inbox.ts, src/workers.ts |

## surface.md (manifest, sidebar, docs, packaging)

| id | description | status | where fixed / why still open |
|---|---|---|---|
| S1 | guide Commands block lacks `--placement tab\|split` on `worker start` | fixed-in-wave-2 | guide.md:294 has `[--placement tab\|split]`; added in 83393c0 (init block lacked it) |
| S2 | guide Commands block lacks `--no-sidebar` on `run create` | fixed-in-wave-2 | guide.md:287 `run create --objective "..." [--no-sidebar]`; added in 83393c0 |
| S3 | guide says "Unknown flags are errors; do not guess" but parseArgs accepts any flag | fixed-now | guide.md: false claim replaced; it now says flags are not checked and how to pass a value starting with `--`; drift test in test/skill.test.ts |
| S4 | guide says "`pack-leader help` prints the same list" but help is a superset | fixed-now | guide Commands block gains `# either` (skill, sidebar, help); test/skill.test.ts asserts the block and `pack-leader help` list the same commands and flags |
| S5 | guide/README/SKILL.md first paragraph say workers run "in sibling panes" (default is hidden tab) | fixed-now | guide.md, README.md, skill/SKILL.md say hidden tabs (or a split); guide release line says tab or split pane. The comment at herdr-plugin.toml:2 (not owned here) still says sibling panes |
| S6 | README "How it works" says `herdr pane split` starts a worker; default is `tab.create` | fixed-now | README "How it works": tab.create (pane.split with `--placement split`), then agent.start and agent.prompt |
| S7 | README sidebar keys list only j/k, Enter ("focuses the worker's pane"), r | fixed-now | README lists j/k (with scrolling), Enter, o, r, R (shift-r), ?, q, and the `?` status before herdr answers |
| S8 | README keybinding snippet uses a format different from sibling plugins | obsolete | already `[[keys.command]] ... command = "pack-leader.sidebar"` in init f82f032 (pre-wave-1). NEW bug: see note below table |
| S9 | cli.ts header comment drifts from `usage()` | fixed-now | cli.ts header comment: `[--no-sidebar]` on run create and `--ack ID[,ID]`, matching usage() |
| S10 | `usage()` omits accepted flags (--run, --another, --cwd, --title, --target-pane, --ratio, ...) | fixed-now | same change as V7: usage() and the guide Commands block list every accepted flag; drift test passes (fix/cli) |
| S11 | SKILL.md requires HERDR_ENV=1 but requireHerdr() also accepts HERDR_PLUGIN_ID/HERDR_SOCKET_PATH | fixed-now | SKILL.md check and description accept HERDR_ENV=1, HERDR_SOCKET_PATH or HERDR_PLUGIN_ID like requireHerdr(); tested by running the stub's snippet |
| S12 | README diagram runtime row lacks the status word (`runtime 3m · working`) | fixed-now | README diagram redrawn from boxLines: `goal` header, `runtime 3m · work…` status word, last-message line |
| S13 | statusOf fallback is "exited", so workers absent from `live` (first frame / herdr down) show "gone" | fixed-now | sidebar.ts `statusOf(w, live|null)`: before the first agent list or after a failed one/socket drop, a worker shows `?` (or gone only if liveness says exited); tests in test/sidebar.test.ts |
| S14 | `R` (refresh) unreachable: readline names shift-R as "r" | fixed-now | sidebar.ts `keyName()` upper-cases shifted letters, so `R` refreshes; tested through readline's emitKeypressEvents |
| S15 | unused imports/locals in sidebar (inverse, width, stateFile, all); noUnusedLocals off | still-open | sidebar.ts dead imports (inverse, stateFile) and the `all` local removed (fixed now). Still open: tsconfig noUnusedLocals, because src/cli.ts imports paneClose and never uses it (owner: src/cli.ts); enable the flag once that import goes |
| S16 | sidebar has no scrolling; boxes past pane height are cut | fixed-now | sidebar.ts `scrollFor()` keeps the selected box (with its run's goal line for the first box) in view; preview/message stay pinned; tested, and seen in a 20-row pty |
| S17 | sidebar's sync ticker can double-deliver follow-ups (delivered set after prompt) | fixed-in-wave-1 | inbox.ts:360 `deliver()` claims delivered+acked inside one locked update before prompting (812d9a0) |
| S18 | sidebar note shows last done/ask even after a redispatch (no dispatch_id filter) | fixed-now | lastMessageFor(state, run, worker, dispatchId) only counts the worker's current dispatch; the sidebar passes w.dispatch_id; tested |
| S19 | non-TTY sidebar runs the 5 s sync ticker forever (`pack-leader sidebar < /dev/null` hangs) | fixed-now | runSidebar throws "the sidebar needs a terminal" when stdin is not a TTY outside a herdr pane (exit 1 instead of hanging) |
| S20 | `truncate` ends with full reset, killing an enclosing style | fixed-in-wave-1 | ansi.ts:34 `closeStyles` (22/27/39), truncate(s,max,close=closeStyles) ansi.ts:41-61 (812d9a0) |
| S21 | `width()` counts code points; wide glyphs miscount | fixed-now | ansi.ts width()/truncate() count terminal cells per grapheme (wide CJK/emoji = 2, combining marks = 0) and never split a grapheme; tests in test/ansi.test.ts |
| S22 | bin launcher does not check node >= 22.18 | fixed-now | bin/pack-leader checks `node --version` and exits with "needs Node 22.18 or newer" (or 127 when node is missing); tested with a fake node |
| S23 | manifest actions use relative `src/cli.ts`, depending on herdr's cwd convention | fixed-now | herdr-plugin.toml: comment explains the relative `src/cli.ts` convention (cwd = plugin root) vs the pane entry's $HERDR_PLUGIN_ROOT; commands unchanged, so `herdr plugin action list` is unaffected (checked on the linked plugin; the worktree was not linked, to leave the live plugin alone). Line-2 "sibling panes" comment fixed too (fix/cli) |
| S24 | tsconfig `rewriteRelativeImportExtensions` is a no-op under noEmit | fixed-now | tsconfig.json: rewriteRelativeImportExtensions removed; tsc still clean |
| S25 | package.json `bin` unused by install path; npm link undocumented | fixed-now | kept `bin` (it is what `npm link` uses); README Develop documents `npm link` |
| S26 | paths.ts: HERDR_PLUGIN_STATE_DIR vs computed XDG path can diverge between actions and CLI | fixed-now | paths.ts: HERDR_PLUGIN_STATE_DIR always wins (resolveStateDir); stateDirDivergence() + update() log `state.dir_divergent` once per process when the XDG default also holds a state.json; test/paths.test.ts, test/state.test.ts; decision in docs/changes/fix-state.md |
| S27 | add `pretest: tsc -p .` so type errors fail before tests | fixed-now | package.json `pretest: tsc -p .` |
| S28 | resolveRun reads PACK_RUN_ID from env so `npm test` fails in a worker pane | fixed-in-wave-1 | state.ts:274-277 `resolveRun(state, opts, env = process.env)`; test/state.test.ts passes `{}` (812d9a0) |
| S29 | `save()` touches the real state dir even with a custom file | fixed-now | state.ts save() does ensureDir(dirname(file)); update() locks lockFor(file) and load() logs next to the file; test/state.test.ts |
| S30 | no tests for ansi.ts | fixed-in-wave-1 | test/ansi.test.ts (9 tests: width/truncate/pad) added in 812d9a0 |
| S31 | no tests for skill.ts installSkill() against a temp HOME | fixed-now | test/skill.test.ts: installSkill against a temp HOME (stub copied, link made, idempotent, foreign symlink replaced, regular file left with a note, PATH note) |
| S32 | no tests for sidebar's pure parts / keypress table | fixed-now | test/sidebar.test.ts: statusOf, keyName (keypress table), scrollFor, lastMessageFor by dispatch |
| S33 | no tests for inbox.ts / workers.ts; fake herdr socket would cover herdr.ts | fixed-in-wave-2 | test/inbox.test.ts with fake socket (wave 1); dispatch/worktree/liveness/groups tests drive workers.ts via fake socket (wave 2) |
| S34 | no test asserting guide.md Commands block matches `usage()` | fixed-now | test/skill.test.ts compares the guide Commands block with `node src/cli.ts help` (flags and command words, both directions) |
| S35 | README install: no bootstrap form for `skill --install` before pack-leader is on PATH | fixed-now | README bootstrap: `herdr plugin action invoke install-skill --plugin pack-leader` (or `bin/pack-leader skill --install` from a checkout) |
| S36 | README: say where `Bash(pack-leader:*)` goes and that check --wait needs a long Bash timeout | fixed-now | README: `permissions.allow` in ~/.claude/settings.json (or project .claude/settings.json), and the Bash timeout must cover `check --wait --timeout 540000` |
| S37 | installSkill PATH note computed in installer's (herdr's) process | fixed-now | skill.ts: the not-on-PATH note carries the `export PATH="…/.local/bin:$PATH"` line to add |
| S38 | ~/wolf not a git repo; `herdr plugin install` / Develop untestable | obsolete | repo is under git (ccd156f "initial GitHub commit"); README Develop uses `herdr plugin link ~/pack-leader` |

## New finding

| id | description | status | where fixed / why still open |
|---|---|---|---|
| N1 | README keybinding snippet put next_agent/previous_agent/focus_agent inside the `[[keys.command]]` entry | fixed-now | `herdr config check` warned `unknown config key keys.command.0.next_agent`; README now puts them under `[keys]` (checked: `config: ok`); focus_agent dropped, its `1..9` value format could not be verified |

## Still open, by owner

Not fixed here because these files belong to the other worker (or to nobody on this run):

- **src/cli.ts**: B4, B8, E3, E6, E9, V1, V2, V4 (with src/inbox.ts), V7 (usage()), V8, T8, T10; S10; the unused `paneClose` import that blocks noUnusedLocals (S15).
- **src/state.ts**: B3, B7, E7, E8, R25; S29; tests T1, T2, T4, T9.
- **src/args.ts**: E1.
- **src/paths.ts**: S26; test T7.
- **src/workers.ts**: E10, R1, R2, R6, R10 (with src/inbox.ts:520, which does not filter queued follow-ups by run), R16, R19, R22 (with src/herdr.ts).
- **src/inbox.ts**: V5, R7, R11, R12 (with herdr-plugin.toml), R15, R23 (with src/herdr.ts).
- **src/herdr.ts**: R21.
- **test/** for herdr/inbox/workers: R26.
- **herdr-plugin.toml** (unassigned): S23, part of R12, the "sibling panes" comment left from S5.
