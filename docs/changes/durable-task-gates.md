# Durable task approval gates

Added coordinator-owned, persisted approval gates with explicit `approve` / `reject` decisions. Pending and rejected gates block all new task dispatches through the shared `createDispatch` admission path; every gate must be approved, and resolved decisions are immutable (same-decision retries are idempotent).

The CLI now supports `gate create --task ID --reason TEXT`, `gate list [--task ID]`, `gate show ID`, and `gate resolve ID --decision approve|reject [--reason TEXT]`. Gate creation is serialized against accepted, not-yet-registered start claims. Task readiness, task/worker/status views, help, and the guide expose blockers; gate records load compatibly with existing v1 state and are removed when their closed run is pruned.

Regression coverage was added for legacy state, multi-gate decisions, dispatch blocking, start-claim races, coordinator/run scoping, task-update bypasses, and pruning. **Tests, typecheck, and lint were not run by user request; this is an implementation handoff, not a tested release.**
