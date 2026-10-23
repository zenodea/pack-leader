import type { Dispatch } from "./state.ts";

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
