# Checkout garbage-collection reconciliation

`run prune` and the garbage-collection tail of `run close` now sweep released
Pack Leader-created checkouts before pruning records, preserving the ownership
lease until cleanup finishes. The sweep revalidates that lease under the same
per-checkout fence used by worktree admission and refuses cleanup when a local
worker (including one using a plain `cwd` alias) or unsettled local dispatch
still claims the checkout. Kept, superseded, and unprovable legacy leases fail
closed; remote cwd and pane strings are treated as belonging to a separate host.

Dry-run is a read-only preview: it does not acquire filesystem locks, update
state, remove checkouts, or mark missing paths as removed. Physical cleanup
continues to use non-forced Git/herdr removal, retaining dirty and user-kept
checkouts.

Regression coverage is in `test/worktree-sweep.test.ts`. Tests were authored but
not executed as required by the integration embargo; see the Pack Leader report
for the permitted source-review evidence and remaining checks.
