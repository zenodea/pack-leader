# Five optional Orca capabilities

Implemented as a supervised feature pack, preserving concurrent observer, sidebar, messaging and worktree-cleanup changes. All five implementations and their integration were finished before tests were run.

## Delivered scope

| Capability | Behavior | Boundary |
| --- | --- | --- |
| Durable approval gates | Coordinator-owned pending, approved or rejected task gates; decisions persist and dispatch admission checks them. | Separate from worker ask/reply; pending or rejected gates cannot be bypassed by retry. |
| Existing-agent adoption | Adopt an existing same-name idle/done local herdr agent, route by its stored pane and supply explicit worker context. | No restart or ownership of its pre-existing pane/tab; release leaves the adopted session open. |
| Parent/child tasks | Store parent provenance, validate cycles and cross-run links, and display task trees. | Not implicit dependencies, automatic decomposition, nested worker authorization or automatic completion. |
| Worktree setup hooks | Explicit local setup command before the initial worker launch/prompt, with bounded logs, timeout and renewed start claims. | Opt-in only, not script autodiscovery or a sandbox; deliberately escaped descendants may survive. |
| Remote placement | SSH execution-host profiles, host-specific lifecycle/routing, restricted callbacks to centralized leader state and outage-aware liveness. | Existing remote directory/workspace only; remote worktree creation, setup and adoption are unsupported. |

See `docs/guide.md` and CLI help for commands and supported flags.

## Review corrections

- Parent changes reject worker identity from environment or a registered local pane under the same state lock as the mutation.
- Remote callback argv cannot select another run/worker; task/dispatch overrides must match the bound worker's current attempt.
- Ambiguous SSH prompt/followup delivery is reconciled before automatic retry. Unknown followup evidence survives sender death and claim expiry.
- Local timeout compatibility remains separate from strict remote receipt observation, including adapters that omit a state counter.
- Worktree cleanup remains protected while release is in progress or pane closure is kept, forgotten or uncertain. Protection survives pruning; dirty previews remain read-only and report kept.

## Verification

The final source candidate is `c0cfaf20987a3aa0c1367901f02f9a7462b4659a`.

- Coordinator verification: `npm test`, including TypeScript checking, passed **327/327 tests** in the isolated integration checkout and again after application to the main checkout.
- Independent parent/gate/adoption review: **approved**, with **35/35** focused tests.
- Independent setup/checkout/CLI review: **approved**, with **62/62** focused tests.
- Independent remote callback/delivery review found one local-timeout compatibility regression after the initial repair. It was corrected and independently re-reviewed: **approved**, with **67/67** focused tests and a **1/1** corrected reproduction. The earlier remote-specific pass also checked callback parsing and unknown-delivery recovery.
- Application used the delta from the preserved user snapshot `70c0bb2`, after checking for concurrent source drift. All **103** candidate source/documentation/test files matched the main checkout byte-for-byte before adding this completion note.

The initial feature suite passing was not treated as review approval: the independent findings were repaired and checked again. Temporary coordination notes were removed after completion at the user's request. Feature and repair commits remain preserved on the integration and worker branches.

## Operational limits

- Remote verification uses fake SSH/socket transport. No live SSH host was configured or tested.
- Herdr sequence/status evidence is heuristic, not exactly-once delivery. The SSH account is trusted; callback validation does not create cryptographic worker isolation.
- Setup process groups are not a security sandbox.
- Interrupted or uncertain checkout cleanup fails closed and may require manual inspection/recovery, as described in the guide.
