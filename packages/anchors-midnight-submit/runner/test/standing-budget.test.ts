import { expect, it } from "vitest";
import { parseDust } from "../../src/preflight.js";
import { assertStandingFeeBudget, standingFeeUnion, StandingFeeCap } from "../standing-budget.js";

const h = (n: number) => n.toString(16).padStart(64, "0"), dust = (value: string) => parseDust(value)!;
const day = 24 * 60 * 60_000, now = day + 10_000;
const observed = (n: number, amount = "0.01", atMillis = now) => ({ txHash: h(n), fee: dust(amount), atMillis });
const local = (n: number, amount = "0.01", state: "unknown" | "landed" | "absent" = "unknown") => ({ txHash: h(n), fee: dust(amount), confirmedAt: 0, validUntil: 1, state });

it("unions observed fees and local confirmations by exact transaction hash", () => {
  expect(standingFeeUnion({ chainTime: now, observations: [observed(1), observed(1), observed(2)], confirmations: [local(1), local(3)] })).toEqual({ total: dust("0.03"), conflicts: [] });
});

it("keeps old unresolved reservations until authenticated retirement", () => {
  expect(standingFeeUnion({ chainTime: now, observations: [], confirmations: [local(1)] }).total).toBe(dust("0.01"));
  expect(standingFeeUnion({ chainTime: now, observations: [], confirmations: [local(1, "0.01", "absent")] }).total).toBe(0n);
});

it("retains paid fees even when a local attempt is retired or its author later revoked", () => {
  expect(standingFeeUnion({ chainTime: now, observations: [observed(1)], confirmations: [local(1, "0.01", "absent")] }).total).toBe(dust("0.01"));
});

it("uses the maximum conflicting fee and blocks new admission with an integrity error", () => {
  const facts = { chainTime: now, observations: [observed(1, "0.003")], confirmations: [local(1, "0.004")] };
  expect(standingFeeUnion(facts)).toEqual({ total: dust("0.004"), conflicts: [h(1)] });
  expect(() => assertStandingFeeBudget(facts, { txHash: h(2), fee: 0n })).toThrow(/integrity/i);
});

it("retains the full rolling boundary and the later serialized TTL of landed confirmations", () => {
  const facts = { chainTime: now, observations: [observed(1, "0.01", 9_999), observed(2, "0.01", 10_000)], confirmations: [{ ...local(3, "0.01", "landed"), validUntil: 10_000 }] };
  expect(standingFeeUnion(facts).total).toBe(dust("0.02"));
  expect(standingFeeUnion({ ...facts, chainTime: now + 1 }).total).toBe(0n);
});

it("allows the exact approved caps and deduplicates an identical pending retry", () => {
  const facts = { chainTime: now, observations: Array.from({ length: 10 }, (_, n) => observed(n)), confirmations: [] };
  expect(assertStandingFeeBudget(facts, { txHash: h(0), fee: dust("0.01") }).total).toBe(dust("0.1"));
  expect(() => assertStandingFeeBudget(facts, { txHash: h(11), fee: 1n })).toThrow(/daily/i);
  expect(() => assertStandingFeeBudget({ ...facts, observations: [] }, { txHash: h(11), fee: dust("0.010000000000001") })).toThrow(/transaction/i);
});

it("distinguishes approved cap holds from integrity failures for durable alerts", () => {
  expect(() => assertStandingFeeBudget({ chainTime: now, observations: [], confirmations: [] }, { txHash: h(20), fee: dust("0.02") })).toThrow(StandingFeeCap);
  expect(() => assertStandingFeeBudget({ chainTime: now, observations: Array.from({length:10},(_,n)=>observed(n)), confirmations: [] }, { txHash:h(20),fee:1n })).toThrow(StandingFeeCap);
  try { assertStandingFeeBudget({chainTime:now,observations:[observed(1)],confirmations:[local(1,"0.002")]},{txHash:h(20),fee:0n}); }
  catch(error) { expect(error).not.toBeInstanceOf(StandingFeeCap); expect(error).toBeInstanceOf(Error); return; }
  throw new Error("Conflicting accounting was accepted");
});

it.each([NaN, Infinity, -1, 0.5])("rejects invalid authenticated chain time %s", chainTime => {
  expect(() => standingFeeUnion({ chainTime, observations: [], confirmations: [] })).toThrow();
});

it.each(["hash", "fee", "future", "timestamp"])("rejects corrupt or contradictory fee facts: %s", mode => {
  const row = observed(1);
  if (mode === "hash") row.txHash = "0x" + row.txHash;
  if (mode === "fee") row.fee = -1n;
  if (mode === "future") row.atMillis++;
  if (mode === "timestamp") row.atMillis = NaN;
  expect(() => standingFeeUnion({ chainTime: now, observations: [row], confirmations: [] })).toThrow();
});
