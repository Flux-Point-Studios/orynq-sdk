import { parseDust } from "../src/preflight.js";
import { LIMITS } from "./limits.js";

export interface ObservedFee { txHash: string; fee: bigint; atMillis: number }
export interface ConfirmedFee { txHash: string; fee: bigint; confirmedAt: number; validUntil: number; state: "unknown" | "landed" | "absent" }
export interface StandingFeeFacts { chainTime: number; observations: readonly ObservedFee[]; confirmations: readonly ConfirmedFee[] }

const time = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid authenticated accounting time"); return value; };
function feeFact(row: { txHash: string; fee: bigint }) {
  if (!/^[a-f0-9]{64}$/.test(row.txHash) || typeof row.fee !== "bigint" || row.fee < 0n) throw new Error("Invalid fee identity or amount");
}

export function standingFeeUnion(facts: StandingFeeFacts): { total: bigint; conflicts: string[] } {
  const now = time(facts.chainTime), cutoff = now - 24 * 60 * 60_000;
  const fees = new Map<string, { fee: bigint; included: boolean }>(), conflicts = new Set<string>();
  const add = (row: { txHash: string; fee: bigint }, included: boolean) => {
    feeFact(row); const previous = fees.get(row.txHash);
    if (previous && previous.fee !== row.fee) conflicts.add(row.txHash);
    fees.set(row.txHash, { fee: previous && previous.fee > row.fee ? previous.fee : row.fee, included: included || previous?.included === true });
  };
  for (const row of facts.observations) {
    const at = time(row.atMillis); if (at > now) throw new Error("Observed fee lies beyond the authenticated accounting head");
    add(row, at >= cutoff);
  }
  for (const row of facts.confirmations) {
    const confirmedAt = time(row.confirmedAt), validUntil = time(row.validUntil);
    if (confirmedAt > now || !["unknown", "landed", "absent"].includes(row.state)) throw new Error("Invalid confirmation accounting facts");
    add(row, row.state === "unknown" || (row.state === "landed" && Math.max(confirmedAt, validUntil) >= cutoff));
  }
  return { total: [...fees.values()].reduce((sum, row) => sum + (row.included ? row.fee : 0n), 0n), conflicts: [...conflicts].sort() };
}

export function assertStandingFeeBudget(facts: StandingFeeFacts, candidate: { txHash: string; fee: bigint }) {
  feeFact(candidate);
  const perTransaction = parseDust(LIMITS.maxFeeDustPerTransaction), perDay = parseDust(LIMITS.maxDustPer24Hours);
  if (perTransaction === null || perDay === null) throw new Error("Standing DUST caps are invalid");
  if (candidate.fee > perTransaction) throw new Error("Standing transaction fee exceeds its approved cap");
  const result = standingFeeUnion({ ...facts, confirmations: [...facts.confirmations, { ...candidate, confirmedAt: facts.chainTime, validUntil: facts.chainTime, state: "unknown" }] });
  if (result.conflicts.length) throw new Error("Standing fee integrity conflict requires reconciliation");
  if (result.total > perDay) throw new Error("Standing daily fee cap has no headroom");
  return result;
}
