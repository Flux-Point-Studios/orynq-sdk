import { expect, it } from "vitest";
import * as L from "@midnightntwrk/ledger-v8";
import { registryInitialState } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { MIDNIGHT_REGISTRIES } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { batchAuthors as authors, batchBytes, batchBytes9, batchScope as scope } from "./batch-fixture.js";
import { assertStandingTransaction } from "../standing-transaction.js";

const h = (n: number) => n.toString(16).padStart(64, "0"), now = 1_800_000_000_000;
const head = { height: 100, timestamp: now, runtimeSpecVersion: 1000300 };
async function bytes(options: { kind?: number; ttl?: number; modify?: (tx: L.UnprovenTransaction) => void } = {}) {
  return batchBytes({ ...options, ttl: options.ttl ?? now + 10 * 60_000 });
}

it("accepts one canonical batch call under the current signed batch-author window", async () => {
  const raw = await bytes(), result = assertStandingTransaction(raw, scope, head, authors());
  expect(result).toMatchObject({ commitment: scope.commitment, ttl: now + 10 * 60_000, fee: 0n });
  expect(result.txHash).toMatch(/^[a-f0-9]{64}$/);
});

it.each(["registry", "author", "commitment"] as const)("refuses substituted expected %s", async field => {
  const raw = await bytes(); expect(() => assertStandingTransaction(raw, { ...scope, [field]: h(7) }, head, authors())).toThrow();
});

it("refuses a non-batch anchor", async () => {
  const raw = await bytes({ kind: 1 }); expect(() => assertStandingTransaction(raw, scope, head, authors())).toThrow(/batch|kind|scope/i);
});

it.each([{ role: "relay" as const }, { validFrom: 101 }, { validTo: 99 }])("requires a current batch-author role: %j", async change => {
  const raw = await bytes(); expect(() => assertStandingTransaction(raw, scope, head, authors(change))).toThrow(/author/i);
});

it.each([now, now + 15 * 60_000 + 1000])("bounds the serialized TTL at %s", async ttl => {
  const raw = await bytes({ ttl }); expect(() => assertStandingTransaction(raw, scope, head, authors())).toThrow(/ttl/i);
});

it("checks every serialized intent TTL", async () => {
  const raw = await bytes({ modify(tx) { tx.intents = new Map([...tx.intents!, [2, L.Intent.new(new Date(now + 16 * 60_000))]]); } });
  expect(() => assertStandingTransaction(raw, scope, head, authors())).toThrow(/ttl/i);
});

it("refuses an unrelated deployment alongside the intended call", async () => {
  const raw = await bytes({ modify(tx) { const intents = tx.intents!, first = intents.values().next().value!; first.actions = [...first.actions, new L.ContractDeploy(registryInitialState())]; tx.intents = intents; } });
  expect(() => assertStandingTransaction(raw, scope, head, authors())).toThrow(/action|scope/i);
});

it.each(["guaranteedUnshieldedOffer", "fallibleUnshieldedOffer"] as const)("refuses %s even when empty", async field => {
  const raw = await bytes({ modify(tx) { const intents = tx.intents!, first = intents.values().next().value!; first[field] = L.UnshieldedOffer.new([], [], []); tx.intents = intents; } });
  expect(() => assertStandingTransaction(raw, scope, head, authors())).toThrow(/offer/i);
});

it("refuses DUST registrations alongside fee payment", async () => {
  const raw = await bytes({ modify(tx) { const intents = tx.intents!, first = intents.values().next().value!; first.dustActions = new L.DustActions("signature", "pre-proof", new Date(now), [], [new L.DustRegistration("signature", L.signatureVerifyingKey(L.sampleSigningKey()), undefined, 0n)]); tx.intents = intents; } });
  expect(() => assertStandingTransaction(raw, scope, head, authors())).toThrow(/registration/i);
});

it("refuses unknown runtimes and invalid authenticated heights", async () => {
  const raw = await bytes();
  expect(() => assertStandingTransaction(raw, scope, { ...head, runtimeSpecVersion: 1000301 }, authors())).toThrow(/runtime/i);
  expect(() => assertStandingTransaction(raw, scope, { ...head, height: NaN }, authors())).toThrow(/height|head/i);
});

it("refuses a new mainnet registry before any authorization can admit it", async () => {
  const raw = await bytes(); expect(() => assertStandingTransaction(raw, { ...scope, network: "mainnet", registry: h(7) }, head, authors())).toThrow(/registry/i);
});

it("accepts a ledger 9 batch call, its fee one DUST spend, while the head runs runtime 2001100", async () => {
  const raw = await batchBytes9({ ttl: now + 10 * 60_000, feeSpends: 1 });
  const result = assertStandingTransaction(raw, scope, { ...head, runtimeSpecVersion: 2001100 }, authors());
  expect(result).toMatchObject({ commitment: scope.commitment, ttl: now + 10 * 60_000 });
  expect(result.fee).toBeGreaterThan(0n);
});

it("refuses a transaction of the other ledger than the head's runtime executes", async () => {
  const v9 = await bytes(), v12 = await batchBytes9({ ttl: now + 10 * 60_000 });
  expect(() => assertStandingTransaction(v9, scope, { ...head, runtimeSpecVersion: 2001100 }, authors())).toThrow("transaction header midnight:transaction[v9] is not one runtime 2001100 executes");
  expect(() => assertStandingTransaction(v12, scope, head, authors())).toThrow("transaction header midnight:transaction[v12] is not one runtime 1000300 executes");
});

it("binds the head's runtime to mainnet generation 1's span: 1000300 through 3346138, 2001100 from 3346139", async () => {
  const raw = await bytes(), mainnet = { ...scope, network: "mainnet" as const, registry: MIDNIGHT_REGISTRIES.mainnet[0]!.address };
  for (const [height, spec] of [[3346138, 2001100], [3346139, 1000300]] as const) {
    expect(() => assertStandingTransaction(raw, mainnet, { height, timestamp: now, runtimeSpecVersion: spec }, authors())).toThrow(`Standing runtime ${spec} at block ${height} is outside registry generation 1's spans`);
  }
  // Inside the span the runtime passes, and the fixture's call to another registry is what mainnet refuses.
  expect(() => assertStandingTransaction(raw, mainnet, { height: 3346138, timestamp: now, runtimeSpecVersion: 1000300 }, authors())).toThrow("Transaction is outside the intended standing batch scope");
});

