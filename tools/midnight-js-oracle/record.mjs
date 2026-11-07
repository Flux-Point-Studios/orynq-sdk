// Records midnight-js 5's construction of ledger 9 calls to the immutable ledger 8 registry, for
// the anchors-midnight oracle test: `npm ci && npm run record`. It reads only committed files
// (the compiled registry and the recorded mainnet state) and writes one fixture.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as L9 from "@midnightntwrk/ledger-v9";
import { createLedger8UnprovenCallTxFromInitialStates } from "@midnight-ntwrk/midnight-js-contracts";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { SerializedContractState, SerializedLedgerParameters } from "@midnight-ntwrk/midnight-js-types";

const PACKAGE = new URL("../../packages/anchors-midnight/", import.meta.url);
const CONTRACT = new URL("contract/", PACKAGE);
const FORK = new URL("src/__tests__/fixtures/rpc-mainnet-fork.json", PACKAGE);
const OUT = new URL("src/__tests__/fixtures/midnight-js-registry-calls.json", PACKAGE);
const REGISTRY = "438b1ea134e760e8b4e87409d663f36561f15341880c118dc41e4fc2b224c736";

// midnight-js reads the artifacts without its integrity manifest, which compactc 0.31.1 does not
// emit, so every file it reads is checked against the registry's own pins first.
const pins = new Map(readFileSync(new URL("HASHES.txt", CONTRACT), "utf8").trim().split("\n").map((line) => line.split(/\s+/).reverse()));
for (const name of ["contract/index.js", "compiler/contract-info.json", ...["anchor", "anchor_hiding"].flatMap((c) => [`keys/${c}.prover`, `keys/${c}.verifier`, `zkir/${c}.bzkir`])]) {
  const digest = createHash("sha256").update(readFileSync(new URL(`managed/${name}`, CONTRACT))).digest("hex");
  if (digest !== pins.get(`managed/${name}`)) throw new Error(`managed/${name} hashes to ${digest}, not its pin`);
}
// The contract module resolves compact-runtime here, so it shares midnight-js's onchain runtime.
const local = new URL("node_modules/.registry-contract/", import.meta.url);
mkdirSync(local, { recursive: true });
copyFileSync(new URL("managed/contract/index.js", CONTRACT), new URL("index.js", local));
const { Contract } = await import(new URL("index.js", local).href);

const fork = JSON.parse(readFileSync(FORK, "utf8"));
const blockHash = fork.recording[`chain_getBlockHash${JSON.stringify([fork.end.height])}`];
const state = fork.recording[`midnight_contractState${JSON.stringify([REGISTRY, blockHash])}`];
const parameters = L9.LedgerParameters.initialParameters().serialize();
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytes = (value) => Uint8Array.from(Buffer.from(value, "hex"));
const plain = (value) => JSON.parse(JSON.stringify(value, (_, v) => (v instanceof Uint8Array ? { bytes: hex(v) } : typeof v === "bigint" ? { bigint: String(v) } : v)));

const SECRET = "07".repeat(32);
const cases = [
  { name: "kind 1", circuit: "anchor", args: [{ bytes: "ab".repeat(32) }, { bigint: "1" }] },
  { name: "kind 3", circuit: "anchor", args: [{ bytes: "cd".repeat(30) + "0000" }, { bigint: "3" }] },
  { name: "kind 2", circuit: "anchor_hiding", args: [{ bytes: "ef".repeat(32) }], hiddenEntry: { root_hash: "11".repeat(32), manifest_hash: "22".repeat(32), merkle_root: "33".repeat(32), salt: "44".repeat(32) } },
];
const revive = (arg) => ("bytes" in arg ? bytes(arg.bytes) : BigInt(arg.bigint));
const zk = new NodeZkConfigProvider(new URL("managed/", CONTRACT).pathname, { verify: "off" });

const recorded = [];
for (const c of cases) {
  const hidden = c.hiddenEntry && Object.fromEntries(Object.entries(c.hiddenEntry).map(([k, v]) => [k, bytes(v)]));
  const contract = new Contract({
    author_secret: ({ privateState }) => [privateState, bytes(SECRET)],
    hidden_entry: ({ privateState }) => [privateState, hidden],
  });
  const out = await createLedger8UnprovenCallTxFromInitialStates(zk, {
    compiledContract: contract,
    contractAddress: REGISTRY,
    circuitId: c.circuit,
    args: c.args.map(revive),
    head: "v9",
    initialContractState: SerializedContractState.fromBytes("v9", bytes(state.replace(/^0x/, ""))),
    ledgerParameters: SerializedLedgerParameters.fromBytes("v9", parameters),
    coinPublicKey: "00".repeat(32),
    config: { networkId: "mainnet", ttlSeconds: 900 },
  }, "00".repeat(32));
  const { unprovenTx, input, output, privateTranscriptOutputs } = out.private;
  if (unprovenTx.era !== "v9") throw new Error(`midnight-js built a ${unprovenTx.era} transaction`);
  recorded.push({ ...c, oracle: { tx: hex(unprovenTx.serialize()), input: plain(input), output: plain(output), privateTranscriptOutputs: plain(privateTranscriptOutputs) } });
}

const versions = Object.fromEntries(["@midnight-ntwrk/midnight-js-contracts", "@midnight-ntwrk/midnight-js-protocol", "@midnightntwrk/ledger-v9"].map((name) => [name, JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, import.meta.url), "utf8")).version]));
writeFileSync(OUT, `${JSON.stringify({
  provenance: `Recorded by tools/midnight-js-oracle/record.mjs with ${Object.entries(versions).map(([n, v]) => `${n}@${v}`).join(", ")}: createLedger8UnprovenCallTxFromInitialStates with head v9, against mainnet registry ${REGISTRY}'s state at block ${fork.end.height} (rpc-mainnet-fork.json) and ledger 9's initial parameters, under the test author secret ${SECRET}.`,
  network: "mainnet",
  address: REGISTRY,
  stateAt: fork.end,
  parameters: hex(parameters),
  authorSecret: SECRET,
  cases: recorded,
}, null, 1)}\n`);
console.log(`wrote ${recorded.length} cases`);
