# fix/state: serialize corruption recovery with writers

## What changed

- `load()` no longer renames or logs malformed and unsupported-version state.
  Missing files still return an empty state; corruption throws an explicit
  error naming the state path and parse/version reason, while leaving the bytes
  in place for a later writer to recover safely.
- `update()` rereads state only after acquiring the file's writer lock. If the
  current bytes are malformed or use an unsupported version, it quarantines
  those bytes as `state.json.corrupt-<timestamp>`, logs `state.corrupt` with the
  state path and reason, then applies the callback to an empty state and saves
  atomically as before.
- Tests cover non-mutating reads, preservation and diagnostics for parse/version
  corruption, and a deterministic reader/writer interleaving where a stale
  reader resumes after a healthy replacement has been committed.

## Compatibility and remaining risk

Read-only loads now throw a path-specific parse/version error on corruption;
missing files still return an empty state. Quarantine is deferred until the
next `update()`, which avoids a reader acting on a stale parse verdict;
corruption details are also recorded when locked recovery occurs.
The lock serializes all Pack Leader writers, while external tools that directly
replace the state file without using that lock remain outside this guarantee.
