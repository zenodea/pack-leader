# Tasks and gates

Every worker works on a task. Most of the time the leader creates tasks for you, straight from `worker start --spec`. This page is for when you want more control: ordering, grouping, approval and retries.

## Writing a good spec

A worker only knows what its spec tells it. A good spec names:

- **Target**: the files, component or environment in scope.
- **Change**: the concrete result to produce.
- **Constraints**: what must not break, what not to touch.
- **Ownership**: what this worker may edit, and what belongs to someone else.
- **Acceptance**: the test, output or evidence that proves it's done.

Two workers should never own the same files. If their edits could collide, give each its own [worktree](?p=worktrees).

## Creating tasks up front

`worker start --spec` creates a task and starts it in one go. To plan first and start later, create tasks on their own:

```sh
lodestar task create --title "Schema" --spec "Add the imports table and migration."
# prints t1
lodestar task create --title "Importer" --spec "Write the CSV importer." --depends-on t1
lodestar task list --ready --brief
lodestar worker start schema --task t1
```

A task with `--depends-on` isn't ready until those tasks succeed. `task list --ready` shows what can start now. Parallel waves work better than long chains; past three steps deep, things tend to drift.

## Grouping with parents

`--parent` files a task under another one, to keep a big piece of work readable:

```sh
lodestar task create --title "Account import" --spec "Implement account import"   # t7
lodestar task create --title "CSV parser" --spec "Parse the CSV input" --parent t7
lodestar task create --title "Row validation" --spec "Validate imported rows" --parent t7
lodestar task tree t7
```

A parent is just organisation. It doesn't block anything, doesn't finish when its children do, and doesn't let a worker start tasks of its own. `task update t8 --parent none` moves a task back to the top.

## Approval gates

A gate holds a task until someone approves it. Use one when a step needs a yes before it runs, like a migration or a deploy:

```sh
lodestar gate create --task t4 --reason "Review the migration plan first"
lodestar gate resolve g5 --decision approve
```

A gate with options is a decision. Approving it means choosing:

```sh
lodestar gate create --task t4 --reason "Which database?" --options "postgres,sqlite"
lodestar gate resolve g6 --choice sqlite
```

How gates behave:

- A pending or rejected gate blocks every start of the task, including retries. All gates on a task have to be approved.
- Decisions are final. Repeating the same decision is fine; changing it isn't allowed.
- Only the leader of the run can create or resolve gates.
- The worker doesn't see the gate's choice. Put what was decided into the spec.
- Gates are for the leader's own decisions. A worker's question goes through `ask` and `reply`.

## Retries

When a task fails, start it again with `--retry`:

```sh
lodestar worker start parser --task t2 --retry
```

After three failed attempts in a row, a task stops taking new attempts. A fourth try of the same spec rarely goes differently, so the better move is a new, smaller task that uses what the failures showed. If you're sure the next attempt will differ, `task update t2 --status pending` resets the count. `LODESTAR_MAX_FAILED_ATTEMPTS` changes the limit.

## Dry runs

Add `--dry-run` to `worker start` or `worker prompt` to see exactly what would be handed over (the task, the directory, the worktree and the full preamble) without starting anything:

```sh
lodestar worker start parser --worktree new --spec "…" --dry-run
```

## Changing a task by hand

`task update` changes a task's status, parent or summary:

```sh
lodestar task update t3 --status pending      # back to the queue; clears its worker and outcome
lodestar task update t3 --summary "Done by hand in a1b2c3"
```

A task that's out with a worker can't be updated; it settles through the worker's `done`, or a release. A succeeded task only changes with `--force`. No update gets past a gate.
