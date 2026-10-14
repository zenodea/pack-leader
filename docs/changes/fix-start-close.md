# Fence worker starts during run close

An accepted `worker start` now reserves its run through its unsettled dispatch, including the interval before a worker record exists. Ordinary `run close` refuses while a recent start claim is in flight. `--force` and `--release` revoke starts that have not committed a prompt; if the prompt handoff is already in flight, close serializes after it and then applies the normal closed-run outcomes.

If revocation happens after this attempt creates a pane/tab, only that returned resource is closed. A worktree created by Pack Leader is removed only through the existing non-forced cleanup path (so dirty worktrees remain); an adopted worktree is left untouched. Ordinary start failures still keep their existing diagnostics and retry behavior.
