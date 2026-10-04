import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { provingProvider } from "@midnight-ntwrk/zkir-v2";
import { pureCircuits } from "../contract/managed/contract/index.js";
import { registryInitialState } from "../src/registry.js";
import { windowHits } from "../src/__tests__/privacy-scan.js";
import { NETWORK, random32, unprovenRegistryCall } from "../src/__tests__/registry-call.js";

// Proves real registry calls in-process with zkir-v2: prover keys and zkir come from
// contract/managed, public parameters only from MIDNIGHT_PP, and nothing is fetched.
const params = process.env.MIDNIGHT_PP;
const managed = new URL("../contract/managed/", import.meta.url);
const read = (rel: string) => new Uint8Array(readFileSync(new URL(rel, managed)));
const provider = () => {
  if (!params) throw new Error("MIDNIGHT_PP must name the directory holding bls_midnight_2p13 and 2p14 (tools/compactc/install.sh)");
  return provingProvider({
    async lookupKey(location: string) {
      return { proverKey: read(`keys/${location}.prover`), verifierKey: read(`keys/${location}.verifier`), ir: read(`zkir/${location}.bzkir`) };
    },
    async getParams(k: number) {
      return new Uint8Array(readFileSync(`${params}/bls_midnight_2p${k}`));
    },
  });
};

const now = new Date();
const ttl = new Date(now.getTime() + 1800e3);
const strictness = () => {
  const s = new L.WellFormedStrictness();
  s.enforceBalancing = false;
  s.verifyNativeProofs = false;
  s.verifyContractProofs = true;
  return s;
};
const context = (state: L.LedgerState) =>
  new L.TransactionContext(state, {
    secondsSinceEpoch: BigInt(Math.floor(now.getTime() / 1000)),
    secondsSinceEpochErr: 30,
    parentBlockHash: "00".repeat(32),
    lastBlockTime: BigInt(Math.floor(now.getTime() / 1000) - 6),
  });

const deploy = new L.ContractDeploy(registryInitialState());
const address = String(deploy.address);
let ledgerState = L.LedgerState.blank(NETWORK);
const authorSecret = random32();
const commitment = random32();
const entry = { root_hash: random32(), manifest_hash: random32(), merkle_root: random32(), salt: random32() };
const attribute = random32();
let anchorProven: Uint8Array;
let anchorFinal: Uint8Array;
let hidingFinal: Uint8Array;
let hidingCommitment: Uint8Array;

beforeAll(async () => {
  const deployTx = L.Transaction.fromParts(NETWORK, undefined, undefined, L.Intent.new(ttl).addDeploy(deploy)).eraseProofs();
  [ledgerState] = ledgerState.apply(deployTx.wellFormed(ledgerState, strictness(), now), context(ledgerState));
  const state = ledgerState.index(address)!;
  const costModel = L.CostModel.initialCostModel();

  const anchor = unprovenRegistryCall({ address, state, call: { circuit: "anchor", args: [commitment, 1n] }, witnesses: { authorSecret }, ttl });
  const anchorTx = await anchor.tx.prove(provider(), costModel);
  anchorProven = anchorTx.serialize();
  anchorFinal = anchorTx.bind().serialize();

  const hiding = unprovenRegistryCall({
    address,
    state,
    call: { circuit: "anchor_hiding", args: [attribute] },
    witnesses: { authorSecret, hiddenEntry: entry },
    ttl,
  });
  hidingCommitment = hiding.after.last_commitment;
  hidingFinal = (await hiding.tx.prove(provider(), costModel)).bind().serialize();
});

describe("the proven, bound bytes a submitter sends", () => {
  it("positive control: they carry every disclosed value, all 25 windows", () => {
    const author = pureCircuits.author_key(authorSecret);
    expect(windowHits(anchorFinal, commitment)).toBe(25);
    expect(windowHits(anchorFinal, author)).toBe(25);
    for (const value of [hidingCommitment, attribute, author]) expect(windowHits(hidingFinal, value)).toBe(25);
  });

  it("hold no window of the author secret or of the kind-2 opening in any encoding", () => {
    expect(windowHits(anchorFinal, authorSecret)).toBe(0);
    for (const [name, value] of Object.entries({ authorSecret, ...entry })) expect(windowHits(hidingFinal, value), name).toBe(0);
  });
});

// ledger-wasm is built without the proof-verifying feature, so wellFormed() never checks a
// contract proof. Nothing here may present wellFormed() as proof verification; this canary
// fails the day upstream starts verifying.
describe("canary: ledger-v8 WASM does not verify contract proofs", () => {
  const reparse = (bytes: Uint8Array) => L.Transaction.deserialize("signature", "proof", "pre-binding", bytes);

  it("accepts the untampered proven call", () => {
    expect(() => reparse(anchorProven).wellFormed(ledgerState, strictness(), now)).not.toThrow();
  });

  it("rejects a tampered binding", () => {
    const tampered = Buffer.from(anchorProven);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => reparse(tampered).wellFormed(ledgerState, strictness(), now)).toThrow(/binding commitment calculation mismatch/);
  });

  it("accepts a transcript that no longer matches its proof", () => {
    const tampered = Buffer.from(anchorProven);
    tampered[tampered.indexOf(Buffer.from(commitment)) + 5]! ^= 1;
    expect(() => reparse(tampered).wellFormed(ledgerState, strictness(), now)).not.toThrow();
  });
});
