# review/code: final review of the feature wave, with fixes

An adversarial review of the merged wave; the full findings (file:line, verdict, pinning test)
are in `docs/review/final-code-review.md`, the tests in `test/review.test.ts`.

Fixed: followups/replies reaching another run's or an earlier same-named worker (F1); the idle
baseline taken after the prompt (F2); a failed `worker prompt` prompt now warns with the resend
command (F3); followups no longer overtake a worker's dispatch prompt (F4, new optional
`Worker.awaiting_prompt`); concurrent starts of one task or name (F5, `START_CLAIM_MS`); a fresh
worktree removed again when the start fails after making it (F6); `close_error` on a release that
could not close the tab/pane (F7); herdr list answers without the list are errors, not "no panes"
(F8); sync ignores workers recorded after its herdr snapshot (F9); prune skips a run whose close is
still releasing workers (F10, `skipped`, `CLOSE_GRACE_MS`); `check --ack` prints one JSON object
(F11, `ack_warning`); group sends survive a recipient released mid-send (F12, recipient `error`);
the redispatch preamble states the flags up front (F13); a herdr answer without the new pane fails
the start cleanly (F14); a herdr error while clearing the folder-trust dialog no longer aborts a
recorded start (F15).

Decisions: output changes are additive fields only (`warning` on `worker prompt`, `close_error`,
`ack_warning`, `skipped`, recipient `error`); state stays version 1 with one new optional field.
The guide and README are owned by another worker, so the wording they need is listed under
"Guide changes needed" in the review instead of being edited here.
