# feat/worktree: a git worktree per worker

`pack-leader worker start NAME --worktree new|PATH [--base REF] [--branch B]` gives a
worker its own working tree, so two workers never share one.

## What changed

- `src/worktree.ts` (new): plans a worktree before anything is created
  (`planWorktree`), and the `git worktree add/remove` fallback.
- `src/workers.ts`: `startWorker` takes `worktree`, `base`, `branch`; the worker's
  cwd becomes the worktree. `releaseWorker` takes `removeWorktree` and returns
  `worktree: { path, branch, kept, removed, note? }`. `preamble()` states the path and
  branch, that the worker commits on that branch, and (for a new checkout) that
  nothing was installed. `worker prompt` and `worker resend` repeat it, since the
  session stays in the same worktree. `workerSummary` includes `worktree`.
- `src/herdr.ts`: `worktreeCreate`, `worktreeOpen`, `worktreeRemove`.
- `src/state.ts`: optional `Worker.worktree` and `State.worktrees` (state stays
  `version: 1`; old files load unchanged).
- `src/cli.ts`: the flags, `worker release --remove-worktree`, the worktree in
  `worker start` output and in `status` text, and a `usage()` entry.
- docs/guide.md (task-spec contract, commands), README.md.
- test/worktree.test.ts: temp git repos plus the fake herdr socket.

## Decisions

- **Where:** `<main checkout parent>/<main checkout basename>-wt/<worker>`, or
  `$PACK_WORKTREE_DIR/<worker>`. The main checkout (from `git rev-parse
  --git-common-dir`) is used even when the run's cwd is itself a linked worktree,
  so every worker lands next to the repo. Nothing goes inside the repo.
- **Base:** default is HEAD of the checkout at the run's cwd (or `--cwd`),
  recorded as the resolved commit hash. `--base`/`--branch` without
  `--worktree new` are errors, and so is a branch that already exists or a
  target path that already exists.
- **Fail early:** the repo, base, branch and path are checked before the task,
  tab or checkout is created, so a non-git cwd leaves no trace.
- **herdr first:** with the default hidden-tab placement, herdr's `worktree.create`
  (or `worktree.open` for `--worktree PATH`) makes the checkout show up as a herdr
  workspace, and the worker's tab is created in that workspace (with the
  `PACK_*` env, which `worktree.create` cannot set). The workspace's own shell tab
  stays, so after release the worktree is still a workspace you can open. A herdr
  without the worktree API (`invalid_request: unknown variant`) falls back to
  `git worktree add`. `--placement split` always uses `git worktree add`, since the
  pane sits next to the orchestrator rather than in a new workspace.
- **Record:** `Worker.worktree = { path, branch, base, created_by_pack, repo,
  workspace_id? }`, and `state.worktrees[path]` keeps the same plus `worker`,
  `run_id`, `created_at`, `released_at`, `removed`, so the work is findable after
  the worker is gone.
- **Release:** keeps the worktree by default. `--remove-worktree` removes it only
  when `created_by_pack`, via herdr's `worktree.remove` when herdr created the
  workspace (else `git worktree remove`), and never with `--force`: a dirty
  checkout is kept and the output's `note` says how to remove it by hand. The
  branch is never deleted. `--remove-worktree` with `--keep-pane` or a retained
  worker is refused, since the agent would be left in a deleted directory.
- **Sharing:** a start that would put a second active worker in the same
  worktree path is refused.
