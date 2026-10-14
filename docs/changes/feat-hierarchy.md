# Task hierarchy

Tasks may now carry an optional `parent_id` as provenance/containment metadata. Create
with `task create --parent ID`; reparent or clear with `task update ID --parent ID|none`,
independently of status. Parent changes are locked state updates and coordinator-only.
They require a same-run parent, reject self/cycle links, and refuse dispatched tasks or
tasks with an unsettled dispatch claim. Hierarchy does
not change `depends_on`, readiness, completion, or worker authority.

`task show` reports parent and direct child IDs; `task list`, run summaries, and task
summaries expose `parent_id`. `task tree [ID]` renders deterministic nested views with
per-subtree status counts and diagnostics for malformed legacy links. Deep views cap
rendered nesting while retaining complete subtree counts. Existing v1 tasks without the
field remain roots; closed-run tree/show/list reads remain available.

Regression coverage is in `test/hierarchy.test.ts`. Per the implementation-pack
instruction, tests and typechecking have not been run.
