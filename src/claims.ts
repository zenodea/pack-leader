// Shared admission-lease semantics. Keep this type-only dependency so gates,
// dispatch history and worker lifecycle can use it without runtime import cycles.
import type { Dispatch } from "./state.ts";

/** Renewed leases fail closed when malformed; old records retain their age-based expiry. */
export function startClaimIsFresh(d: Pick<Dispatch, "started_at" | "claim_until">, staleAfterMs: number, at = Date.now()): boolean {
  const canonicalTimestamp = (value: unknown): number | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return null;
    try {
      return new Date(parsed).toISOString() === value ? parsed : null;
    } catch {
      return null;
    }
  };
  if (!Number.isFinite(at)) return true;
  if (Object.prototype.hasOwnProperty.call(d, "claim_until")) {
    const claimUntil = canonicalTimestamp(d.claim_until);
    return claimUntil === null || at <= claimUntil;
  }
  const started = Date.parse(d.started_at);
  return Number.isFinite(started) && at - started <= staleAfterMs;
}
