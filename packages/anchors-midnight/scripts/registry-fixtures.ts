// Regenerates src/__tests__/fixtures/registry-transactions.json: a registry deploy and three
// registry calls proven in-process with the committed prover keys, all as the final bound bytes
// a submitter sends, with test-only secrets. Proving takes about a minute on one core, so run it
// at the lowest priority:
//   MIDNIGHT_PP=~/.cache/midnight/zk-params nice -n 19 node --import tsx scripts/registry-fixtures.ts
import { readFileSync, writeFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { provingProvider } from "@midnight-ntwrk/zkir-v2";
import { pureCircuits } from "../contract/managed/contract/index.js";
import { buildRegistryDeploy } from "../src/registry.js";
import { toHex } from "../src/scale.js";
import { NETWORK, deployOf, random32, unprovenRegistryCall } from "../src/__tests__/registry-call.js";

const params = process.env.MIDNIGHT_PP;
if (!params) throw new Error("MIDNIGHT_PP must name the directory holding bls_midnight_2p13 and 2p14 (tools/compactc/install.sh)");
const managed = new URL("../contract/managed/", import.meta.url);
const read = (rel: string) => new Uint8Array(readFileSync(new URL(rel, managed)));
const proofs: Uint8Array[] = [];
const real = provingProvider({
  async lookupKey(location: string) {
    return { proverKey: read(`keys/${location}.prover`), verifierKey: read(`keys/${location}.verifier`), ir: read(`zkir/${location}.bzkir`) };
  },
  async getParams(k: number) {
    return new Uint8Array(readFileSync(`${params}/bls_midnight_2p${k}`));
  },
});
const provider: L.ProvingProvider = {
  check: (preimage, location) => real.check(preimage, location),
  prove: async (preimage, location, binding) => {
    const proof = await real.prove(preimage, location, binding);
    proofs.push(proof);
    return proof;
  },
};
const costModel = L.CostModel.initialCostModel();
const ttl = new Date(Date.UTC(2030, 0, 1));
const final = async (tx: L.UnprovenTransaction) => {
  const bound = (await tx.prove(provider, costModel)).bind();
  return { tx: toHex(bound.serialize()), txHash: bound.transactionHash() };
};

const deploy = buildRegistryDeploy({ networkId: NETWORK, ttl });
const state = deployOf(deploy.tx).initialState;
const registry = { address: deploy.address, ...(await final(deploy.tx)) };
const authorSecret = random32();
const strangerSecret = random32();
const entry = { rootHash: random32(), manifestHash: random32(), merkleRoot: random32() };
const commitment = pureCircuits.entry_digest(entry.rootHash, entry.manifestHash, entry.merkleRoot);
const opening = { ...entry, salt: random32() };
const attribute = random32();
const call = (circuit: "anchor" | "anchor_hiding", secret: Uint8Array) =>
  unprovenRegistryCall({
    address: deploy.address,
    state,
    call: circuit === "anchor" ? { circuit, args: [commitment, 1n] } : { circuit, args: [attribute] },
    witnesses: { authorSecret: secret, hiddenEntry: { root_hash: opening.rootHash, manifest_hash: opening.manifestHash, merkle_root: opening.merkleRoot, salt: opening.salt } },
    ttl,
  });
const hiding = call("anchor_hiding", authorSecret);
const hex = (o: Record<string, Uint8Array>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toHex(v)]));
const fixture = {
  network: NETWORK,
  registry,
  author: { secret: toHex(authorSecret), key: toHex(pureCircuits.author_key(authorSecret)) },
  anchor: { ...(await final(call("anchor", authorSecret).tx)), entry: hex(entry), commitment: toHex(commitment) },
  hiding: { ...(await final(hiding.tx)), attribute: toHex(attribute), opening: hex(opening), commitment: toHex(hiding.after.last_commitment) },
  stranger: { ...(await final(call("anchor", strangerSecret).tx)), key: toHex(pureCircuits.author_key(strangerSecret)) },
  proof: toHex(proofs[0]!),
};
writeFileSync(new URL("../src/__tests__/fixtures/registry-transactions.json", import.meta.url), `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`registry ${registry.address}: deploy ${registry.txHash}, anchor ${fixture.anchor.txHash}, hiding ${fixture.hiding.txHash}, stranger ${fixture.stranger.txHash}; ${proofs.length} proofs`);
