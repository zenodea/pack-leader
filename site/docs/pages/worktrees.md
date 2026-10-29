# Worktrees and merging

Two agents editing the same checkout will trip over each other. A Git worktree gives each worker its own checkout on its own branch, so they can't.

## Giving a worker its own checkout

```sh
lodestar worker start parser --worktree new --spec "…"
```

This creates a worktree next to your repository, at `<repo>-wt/parser` (or `$LODESTAR_WORKTREE_DIR/parser`), on a new branch `lodestar/<run>/parser` from your current HEAD, and starts the worker in it.

| Flag | Does |
| --- | --- |
| `--worktree new` | A new checkout and branch |
| `--worktree PATH` | Use a checkout that already exists |
| `--base REF` | Branch from something other than HEAD |
| `--branch NAME` | Name the branch yourself |

The run's directory has to be inside a Git repository. Lodestar refuses to put two workers in the same worktree.

Whether the leader uses worktrees on its own is a setting: always, never, or let the leader decide (the default). See [Settings](?p=settings).

## Setting up the checkout

A new worktree is a bare checkout: no `node_modules`, no build output. The worker is told to install what it needs. To do it before the agent starts, pass a setup command:

```sh
lodestar worker start parser --worktree new --setup-command "npm ci" --spec "…"
```

- It runs once, in the checkout, before the agent launches. If it fails or times out, the worker doesn't start.
- It only runs when you pass it. Lodestar never picks one up from the repository.
- `--setup-timeout` sets the limit in milliseconds: 120000 by default, 300000 at most.
- The output goes to a private log; its path is saved on the dispatch.
- It runs with your permissions and isn't sandboxed.

## Merging

Workers commit to their own branches. When the reports are in, the leader reviews the work and merges those branches from your main checkout, the same way you would. Lodestar itself never merges anything automatically, and it doesn't take a worker's word for what it did: checking is part of the leader's job.

If you'd rather merge yourself, say so when you give the task ("leave the branches for me"), and the leader stops at the review.

## What happens on release

`lodestar worker release parser`:

- saves the worker's screen, then closes its tab;
- removes the worktree if Lodestar created it and it has no uncommitted changes;
- **always keeps the branch**, so the work stays reachable.

The checkout is kept instead when it has uncommitted changes, when the pane stays open (`--keep-pane`, or a retained worker), when it was an existing checkout you passed with `--worktree PATH`, or when you ask with `--keep-worktree`.

## Cleanup is careful on purpose

A checkout is only removed once Lodestar has confirmed its pane is closed. Anything uncertain (an interrupted release, a pane that might still be open, a run closed without releasing its workers) stays protected, through later cleanups too. If you clean up by hand, check nothing is using the checkout and use `git worktree remove <path>`, without `--force` if it has changes.
