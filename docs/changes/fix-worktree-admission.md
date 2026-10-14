# fix/worktree-admission: reserve checkouts during concurrent starts

`worker start --worktree PATH` now reserves the canonical checkout path in the same
locked state update that claims its dispatch. A second in-flight start cannot pass
admission with the same checkout, including when it uses a symlink alias; separate
checkouts can still start concurrently. Reservations belong to their dispatch and
are released when the attempt settles or its abandoned claim expires. Existing
worker records continue to hold their checkout until cleanup, while ordinary
`--cwd` starts do not create checkout reservations.

The optional `Dispatch.worktree_path` field is omitted for older dispatch records
and for starts that do not request `--worktree`, so existing state files remain
compatible.

Regression coverage: `test/worktree-admission.test.ts` uses temporary Git
worktrees and a fake herdr socket with explicit admission barriers.
