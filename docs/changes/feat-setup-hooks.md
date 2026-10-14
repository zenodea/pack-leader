# Explicit local worktree setup hooks

`worker start --worktree new|PATH --setup-command "..."` now runs an explicitly
provided platform-shell command after the checkout is materialized and ownership is
validated, but before any worker agent launch or task prompt. Setup is opt-in, does
not discover repository scripts, runs once per initial `worker start`, and is not
rerun on later `worker prompt` redispatches. `--setup-timeout MS` defaults to
120000 ms and is limited to 300000 ms.

The dispatch stores the command, cwd, timestamps, exit/signal/status, private log
path and whether output was truncated. Stdout/stderr capture is capped at 256 KiB;
nonzero exits, timeouts and spawn/log failures block the worker and include the log
path in the CLI error. Existing and dirty checkouts are preserved on failure.
After timeout, process-group termination and pipe-close waiting are bounded; if a
detached descendant retains stdout/stderr, Pack Leader closes its local pipes,
marks output truncated, records the cleanup error, and returns. Setup is not
sandboxed, so a descendant that deliberately escapes its process group may outlive
the timeout.

Regression tests were added but not executed, per the implementation-pack
verification hold.
