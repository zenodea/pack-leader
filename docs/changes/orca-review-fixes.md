# Orca comparison: nine reliability and CLI fixes

Implementation scope: the nine confirmed defects from the Orca comparison, not the five optional feature gaps. Every implementation and independent-review pack worker was explicitly launched with `openai/gpt-6-luna` and `xhigh`.

## Fixed

| Defect | Result |
| --- | --- |
| Run close racing worker start | Start admission and prompt handoff are fenced against closure. Revoked starts clean up their own resources; a fast terminal report is not mistaken for revocation. |
| Concurrent checkout admission | Canonical checkout reservations reject competing starts. Dispatch-owned leases and a per-checkout fence keep delayed cleanup from deleting a successor's checkout. |
| Followup lost when sender dies | Delivery uses recoverable owned claims and is acknowledged only after backend acceptance. |
| Stale dispatch supervision/messages | Worker control messages require current run/task/dispatch authority. Recipient-bound messages cannot silently cross into a successor dispatch; explicit CLI context overrides work after reuse. |
| Corrupt-state reader/writer race | Ordinary reads are non-mutating and report corruption. Recovery re-reads and quarantines only under the writer lock, preserving healthy replacements. |
| Ignored or malformed safety flags | Command-level validation rejects unknown, missing, malformed, and invalid negative timeout values before effects. Native arguments after `--` remain passthrough. |
| Invalid configuration silently overwritten | Invalid JSON, invalid shapes, and read errors are explicit; invalid bytes and compatible extension fields are preserved. |
| Explicit status selector silently falls back | An invalid explicit run selector is an error. Fleet fallback is limited to implicit selection. |
| Structured herdr errors lose their code | CLI error JSON preserves a safe string `code` alongside its existing `error` field. |

## Integration and verification

- Nine initial implementation tasks ran in isolated worktrees. Follow-up repairs addressed independent review findings before application.
- The independently reviewed candidate passed typecheck and **237/237 tests**. Final CLI review passed **33/33 focused tests**; final runtime review passed **37/37 focused tests**. Both reviewers approved.
- Existing and concurrent user changes were preserved, including theme/sidebar work, the worker leader bar, and default cleanup of clean Pack-created worktrees with `--keep-worktree` opt-out. Those flags are accepted by strict validation. Revoked split starts also clean up their own leader bar.
- The sidebar first-line test now ignores centering whitespace when testing the bold label; its separate centering assertion remains intact.

## Boundaries

- Delivery is **at least once**, not exactly once, when backend acceptance is ambiguous. Stable message IDs identify retries; already-lost acknowledgments from the old implementation cannot be recovered retroactively.
- Abandoned claims expire; legacy in-flight records without the new reservation/ownership fields cannot provide the full new guarantees. Ownership ambiguity is handled conservatively by leaving a checkout in place.
- Backend acceptance followed by process death can still require inspection/resend; this is not transactional delivery across herdr and local state.
- Most race regressions use deterministic fake-herdr fixtures and isolated temporary state. They do not establish full end-to-end coverage of every real backend failure.
- Approval gates, existing-agent adoption, task hierarchy, setup policy, and remote placement were intentionally **not** added.
