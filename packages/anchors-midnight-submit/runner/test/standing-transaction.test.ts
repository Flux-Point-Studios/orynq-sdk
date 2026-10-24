import { expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { registryInitialState } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { batchAuthors as authors, batchBytes, batchScope as scope } from "./batch-fixture.js";
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
