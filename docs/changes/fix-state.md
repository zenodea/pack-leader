# fix/state: state file, lock, log, paths and args hardening

Closes review items B3, B7, E1, E7, E8, S26, S29, R25, T1, T2, T4, T7, T9
(rows in `docs/review/findings-status.md`). Tests: `test/state.test.ts`,
`test/args.test.ts`, new `test/paths.test.ts`.

## What changed

- **Lock (B3, R25).** `acquire()` writes `{pid, host}` to `state.lock/owner`
  right after the `mkdir`. A lock is swept when its owner (on this host) is
  dead, when it has no owner and is older than 30 s (old builds, or a holder
  that died before writing it), or when it is older than 10 min whatever the
  owner says (pid reuse). A live holder is never swept before that. A stale
  lock is renamed aside before removal and given back if what was renamed turns
  out to be live, so two sweepers cannot delete a third process's fresh lock.
  Sweeps log `state.lock_swept`. `release()` only removes a lock this process
  owns.
- **update() is synchronous (R25).** Decision: all 35 call sites already pass
  sync callbacks, so the type is now `fn: (state) => T` with `T` not a promise
  (compile error otherwise), and a callback that returns a thenable at run time
  throws "update() callback must be synchronous" with nothing saved. No lock
  refresh is needed: the lock is held for load + fn + save only.
- **save() (B7, E7, S29).** Writes `<file>.<pid>.tmp` through an fd, fsyncs
  it, renames, then fsyncs the directory (errors from a dir fsync are
  ignored). It creates `dirname(file)`, not the real state dir. Orphaned
  `<file>.<digits>.tmp` older than a minute are removed on each save.
- **Lock and log follow the file.** `update(fn, file)` locks `<file minus
  .json>.lock` (`lockFor`) and `load()` logs next to the file, so a custom
  file never touches the real state dir. For the default file these are the
  same paths as before.
- **Log rotation (E8).** Past 2 MB (`LOG_MAX_BYTES`), `events.jsonl` is renamed
  to `events.jsonl.1` (replacing the previous `.1`) instead of being emptied.
  `log()` takes an optional third `maxBytes` argument (tests).
- **State dir (S26).** Decision: `HERDR_PLUGIN_STATE_DIR` always wins over the
  XDG default (herdr hands it to plugin commands; tests rely on it). When it
  names another dir *and* the XDG default also holds a `state.json`, the first
  `update()` of each process logs `state.dir_divergent` (`env_dir`,
  `default_dir`, `using`) to the env dir's `events.jsonl`. New pure helpers in
  `src/paths.ts`: `defaultStateDir`, `resolveStateDir`, `stateDirDivergence`.
- **Args (E1).** `--body` and `--summary` (`TEXT_FLAGS` in `src/args.ts`)
  always take the next token, even one starting with `--` (but not the `--`
  separator itself): `reply m5 --body "--no"`, `note --body "--x"`,
  `done --summary "--dry-run was enough"`. Every other flag still reads a
  following `--token` as the next flag; `--flag=value` is the escape.
  `parseArgs(argv, textFlags?)` accepts its own set.

Compatibility: state stays version 1, no new state fields. During an upgrade
an old build cannot `rmdir` a stale new-format lock (it has an `owner` file);
it then times out with the usual "locked" error, and the next new-build command
sweeps it.

## Requests for files outside this branch's ownership

Not edited here (owned by the cli/docs worker); please apply:

1. `docs/guide.md`, the paragraph after the Commands block, replace the last
   sentence ("A flag value that itself starts with `--` must be written
   `--flag=value` (`--body=--no`), or it is read as the next flag.") with:

   > A flag value that itself starts with `--` must be written `--flag=value`
   > (`--spec=--x`), or it is read as the next flag. `--body` and `--summary`
   > are free text and take the next word whatever it is (`reply m5 --body "--no"`).

2. `README.md`, the bullet "State is one JSON file under
   `~/.local/state/herdr/plugins/lodestar/`, written atomically under a
   lock; ...", replace with:

   > - State is one JSON file under `~/.local/state/herdr/plugins/lodestar/`
   >   (`$HERDR_PLUGIN_STATE_DIR` wins when set; if both hold a state.json, a
   >   `state.dir_divergent` event is logged), written atomically (fsync + rename)
   >   under a lock that records its holder's pid, so a crashed command's lock is
   >   swept at once; every `lodestar` command is a short-lived process.
   >   `events.jsonl` rotates to `events.jsonl.1` at 2 MB.

3. `docs/review/findings-status.md`, the "Totals" line: this branch moves 13
   items from still-open to fixed-now (wontfix unchanged); recount after merging
   all branches.
