// Verifies FPS's first two Midnight mainnet anchors against the registry generation
// MIDNIGHT_REGISTRIES pins, with FPS's mainnet author key pinned by the caller, and the negative
// controls beside them; it exits 1 unless every verdict is the one RUNS expects. It reads one
// Midnight node's JSON-RPC and nothing else. No mainnet indexer answers without a credential
// since Midnight decommissioned its own on 2026-10-09, so the node plays the indexer's part
// (nodeIndexer): the verifier treats an indexer as untrusted and checks what it says against
// the node's blocks and GRANDPA anyway, but the transaction's status comes from the node alone.
// Finality starts from CHECKPOINT_FILE, a GRANDPA set the caller trusts (a CheckpointJson): one
// walk from it to the registry's deploy block yields the set every verification then starts from.
//   node mainnet-anchors.mjs CHECKPOINT_FILE
// With FIXTURE it also writes what the verifications read to FIXTURE, the file verify.test.ts
// replays. Recording loads the suite's TypeScript helper, so it runs from this package's
// directory, after pnpm build:
//   node --import tsx scripts/mainnet-anchors.mjs CHECKPOINT_FILE src/__tests__/fixtures/mainnet-anchors.json
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MIDNIGHT_REGISTRIES,
  contractStateOnNode,
  decodeAnchorTransaction,
  finalityRpc,
  midnightSource,
  midnightTransactionIn,
  verifyFinality,
  verifyMidnightAnchor,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";

const PACKAGE = "@fluxpointstudios/orynq-sdk-anchors-midnight";
const OPERATOR = "rpc.mainnet.midnight.network";
const FPS_AUTHOR = "6a140f2346ec16bc587b506e3d447f05ddcc9bdd72778bee578767571b061f08";
const KIND1 = { txHash: "e273d480e57b3315937c8929fbc3c11ab798d42b4ff6c0b88172856dec6b7d58", height: 3113832, commitment: "c5027cecfc7c6dac5dcce026178ccaec51afe30735dc311635907b8e06b69a59" };
const KIND2 = {
  txHash: "5cf70930503785a1a4524f458ec6986d9e1083ad04a2851946e911bb87338643",
  height: 3113847,
  commitment: "7d3e484c72ad02493526ba7bd885977264e02b57d8bc4645d4d67c18123476da",
  attribute: "6087363539cf4a83f465b586740d385ffe9d87d3be00701a66f0ad0f2f50ae15",
};
// Another contract's call, in the kind-1 anchor's block.
const STRANGER = { txHash: "987c01eeee3fc7123b82cdcaa476c44927d283b5d6ab1e3d337ba7ea4bd013ec", height: 3113832 };

const flipLastBit = (hex) => hex.slice(0, -1) + (Number.parseInt(hex.at(-1), 16) ^ 1).toString(16);
const [registry] = MIDNIGHT_REGISTRIES.mainnet;
if (!registry) throw new Error(`${PACKAGE} pins no mainnet registry generation`);

const RUNS = [
  { name: "kind 1, FPS key pinned", txHash: KIND1.txHash, expect: { kind: 1, commitment: KIND1.commitment }, expectedAuthor: FPS_AUTHOR, want: ["valid", KIND1.commitment] },
  { name: "kind 2, FPS key pinned", txHash: KIND2.txHash, expect: { kind: 2, attribute: KIND2.attribute }, expectedAuthor: FPS_AUTHOR, want: ["valid", KIND2.commitment] },
  { name: "kind 1, no author key pinned", txHash: KIND1.txHash, expect: { kind: 1, commitment: KIND1.commitment }, want: ["unauthenticated", KIND1.commitment] },
  { name: "kind 2, no author key pinned", txHash: KIND2.txHash, expect: { kind: 2, attribute: KIND2.attribute }, want: ["unauthenticated", KIND2.commitment] },
  { name: "kind 1, wrong author key", txHash: KIND1.txHash, expect: { kind: 1, commitment: KIND1.commitment }, expectedAuthor: flipLastBit(FPS_AUTHOR), want: ["unauthenticated", KIND1.commitment] },
  { name: "kind 2, wrong author key", txHash: KIND2.txHash, expect: { kind: 2, attribute: KIND2.attribute }, expectedAuthor: flipLastBit(FPS_AUTHOR), want: ["unauthenticated", KIND2.commitment] },
  { name: "kind 1, commitment one bit off", txHash: KIND1.txHash, expect: { kind: 1, commitment: flipLastBit(KIND1.commitment) }, expectedAuthor: FPS_AUTHOR, want: ["invalid", KIND1.commitment] },
  { name: "kind 2, attribute one bit off", txHash: KIND2.txHash, expect: { kind: 2, attribute: flipLastBit(KIND2.attribute) }, expectedAuthor: FPS_AUTHOR, want: ["invalid", KIND2.commitment] },
  {
    name: "kind 1, registry address not pinned",
    txHash: KIND1.txHash,
    expect: { kind: 1, commitment: KIND1.commitment },
    expectedAuthor: FPS_AUTHOR,
    registries: [{ ...registry, address: flipLastBit(registry.address) }],
    want: ["invalid", null],
  },
  { name: "another contract's call", txHash: STRANGER.txHash, expect: { kind: "any" }, expectedAuthor: FPS_AUTHOR, want: ["invalid", null] },
];

const SYSTEM_EVENTS = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
const TIMESTAMP_NOW = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
const CONTRACT_ADDRESS = "midnight:contract-address[v2]:";

// Runtime 1000300's System.Events, every record decoded. Only the events of a block holding
// nothing but successful Midnight transactions are known: System.ExtrinsicSuccess and
// Midnight's ContractCall (0), ContractDeploy (1) and TxApplied (2). Any other is refused, never
// skipped, so a failed or partly failed transaction is never reported as anything.
function decodeEvents(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  let at = 0;
  const take = (n) => {
    if (at + n > b.length) throw new Error("System.Events ends inside a record");
    at += n;
    return b.subarray(at - n, at);
  };
  const compact = () => {
    const mode = b[at] & 3;
    if (mode === 0) return take(1)[0] >> 2;
    if (mode === 1) return take(2).readUInt16LE(0) >> 2;
    if (mode === 2) return take(4).readUInt32LE(0) >>> 2;
    take((take(1)[0] >> 2) + 4);
    return Number.NaN;
  };
  const events = [];
  for (let n = compact(); n > 0; n--) {
    const phase = take(1)[0];
    if (phase !== 0) throw new Error(`a System.Events record in phase ${phase}, not ApplyExtrinsic`);
    const extrinsic = take(4).readUInt32LE(0);
    const [pallet, variant] = take(2);
    if (pallet === 0 && variant === 0) {
      compact();
      compact();
      take(2);
      events.push({ extrinsic, event: "ExtrinsicSuccess" });
    } else if (pallet === 5 && variant <= 2) {
      const txHash = take(32).toString("hex");
      if (variant === 2) events.push({ extrinsic, event: "TxApplied", txHash });
      else {
        const address = take(compact()).toString("latin1");
        if (!address.startsWith(CONTRACT_ADDRESS)) throw new Error(`a contract address without the ${CONTRACT_ADDRESS} prefix`);
        events.push({ extrinsic, event: variant === 0 ? "ContractCall" : "ContractDeploy", txHash, address: Buffer.from(address.slice(CONTRACT_ADDRESS.length), "latin1").toString("hex") });
      }
    } else throw new Error(`event ${pallet}.${variant} is not one this reader knows`);
    if (compact() !== 0) throw new Error("an event with topics");
  }
  if (at !== b.length) throw new Error("System.Events carries bytes after its records");
  return events;
}

// The indexer's answer about a transaction, from the node's block at the height `heights` names
// for it: its bytes, located by strict decode of every Midnight extrinsic; SUCCESS only where
// that extrinsic's events show System.ExtrinsicSuccess and Midnight.TxApplied for it; and each
// contract it acts on, with the state the node holds there at the end of the block.
function nodeIndexer(source, heights) {
  const unavailable = (what) => () => {
    throw new Error(`${OPERATOR} is a node: it answers no ${what}`);
  };
  const stateAt = async (address, blockHash) => {
    const state = await contractStateOnNode(source, address, blockHash);
    if (state === null) throw new Error(`the node holds no contract at ${address} in block ${blockHash}, which acts on it`);
    return state.replace(/^0x/, "");
  };
  return {
    async transactions(hash) {
      const height = heights.get(hash);
      if (height === undefined) throw new Error(`no block height is known for transaction ${hash}`);
      const blockHash = (await source.node.call("chain_getBlockHash", [height])).replace(/^0x/, "");
      const { block } = await source.node.call("chain_getBlock", [`0x${blockHash}`]);
      const carried = block.extrinsics.map((e) => midnightTransactionIn(Buffer.from(e.replace(/^0x/, ""), "hex")));
      const index = carried.findIndex((tx) => tx !== null && decodeAnchorTransaction(tx, []).txHash === hash);
      if (index < 0) return [];
      const events = decodeEvents(await source.node.call("state_getStorage", [SYSTEM_EVENTS, `0x${blockHash}`])).filter((e) => e.extrinsic === index);
      const applied = events.some((e) => e.event === "ExtrinsicSuccess") && events.some((e) => e.event === "TxApplied" && e.txHash === hash);
      const actions = events.filter((e) => (e.event === "ContractCall" || e.event === "ContractDeploy") && e.txHash === hash);
      const now = Buffer.from((await source.node.call("state_getStorage", [TIMESTAMP_NOW, `0x${blockHash}`])).replace(/^0x/, ""), "hex");
      return [
        {
          hash,
          raw: Buffer.from(carried[index]).toString("hex"),
          block: { height, hash: blockHash, timestamp: Number(now.readBigUInt64LE(0)) },
          status: applied ? "SUCCESS" : null,
          contractActions: await Promise.all(actions.map(async (a) => ({ kind: a.event, address: a.address, state: await stateAt(a.address, blockHash) }))),
        },
      ];
    },
    head: unavailable("indexer head"),
    latestAction: unavailable("contract actions"),
    contractActions: unavailable("contract action subscription"),
  };
}

const checkpointFromJson = (c) => ({ setId: BigInt(c.setId), startsAfter: c.startsAfter, authorities: c.authorities.map((a) => ({ key: a.key, weight: BigInt(a.weight) })) });
const checkpointToJson = (c) => ({ setId: String(c.setId), startsAfter: c.startsAfter, authorities: c.authorities.map((a) => ({ key: a.key, weight: String(a.weight) })) });

const [checkpointFile, fixture] = process.argv.slice(2);
if (!checkpointFile) {
  process.stderr.write("usage: node mainnet-anchors.mjs CHECKPOINT_FILE [FIXTURE]\n");
  process.exit(2);
}
const root = JSON.parse(readFileSync(checkpointFile, "utf8"));
process.stdout.write(`${PACKAGE} from ${realpathSync(fileURLToPath(import.meta.resolve(PACKAGE)))}\n`);

// midnightSource's node half; its indexer half is never called.
const { node } = midnightSource({ operator: OPERATOR, indexer: `https://${OPERATOR}`, indexerWs: `wss://${OPERATOR}`, node: `https://${OPERATOR}`, headers: {} });
const nodeOnly = { operator: OPERATOR, node };
const live = {
  ...nodeOnly,
  indexer: nodeIndexer(nodeOnly, new Map([[KIND1.txHash, KIND1.height], [KIND2.txHash, KIND2.height], [STRANGER.txHash, STRANGER.height], [registry.deployTxHash, registry.deployHeight]])),
};
const recorder = fixture ? (await import("../src/__tests__/recorded-source.ts")).recordingSource(live, "mainnet") : null;
const source = recorder?.source ?? live;

const deployBlock = { height: registry.deployHeight, hash: (await node.call("chain_getBlockHash", [registry.deployHeight])).replace(/^0x/, "") };
const derivation = await verifyFinality({ rpc: finalityRpc(nodeOnly), block: deployBlock, checkpoints: [checkpointFromJson(root)] });
if (!derivation.finalized) throw new Error(`the registry's deploy block is not final from set ${root.setId}: ${derivation.reason}`);
const { checkpoint } = derivation;
process.stdout.write(`set ${root.setId} -> set ${checkpoint.setId}: ${derivation.setChanges} set changes, ${derivation.requests} requests; deploy block ${deployBlock.height} justified at ${derivation.justified.height}\n`);

const lines = (r) => r.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
const runs = [];
let wrong = 0;
for (const run of RUNS) {
  const request = { txHash: run.txHash, expect: run.expect, ...(run.expectedAuthor ? { expectedAuthor: run.expectedAuthor } : {}) };
  const r = await verifyMidnightAnchor({ network: "mainnet", ...request }, { source, checkpoints: [checkpoint], ...(run.registries ? { registries: run.registries } : {}) });
  const [status, commitment] = run.want;
  const ok = r.status === status && r.assurance === "consensus-verified" && (r.anchor?.commitment ?? null) === commitment;
  if (!ok) wrong++;
  process.stdout.write(`${ok ? "as expected" : "UNEXPECTED "}  ${run.name}: ${r.status} at ${r.assurance}, author ${r.author ? `${r.author.status} ${r.author.key}` : "none"}\n`);
  if (!ok) for (const line of lines(r)) process.stdout.write(`    ${line}\n`);
  runs.push({
    name: run.name,
    request,
    ...(run.registries ? { registries: run.registries } : {}),
    status: r.status,
    assurance: r.assurance,
    block: r.block,
    anchor: r.anchor,
    author: r.author,
    verifiedFields: r.verifiedFields,
    notes: r.notes,
    checks: lines(r),
  });
}
if (recorder) {
  const record = {
    network: "mainnet",
    operator: OPERATOR,
    root: checkpointToJson(checkpointFromJson(root)),
    derivation: { setChanges: derivation.setChanges, requests: derivation.requests, justified: derivation.justified },
    checkpoint: checkpointToJson(checkpoint),
    runs,
    recording: recorder.recording,
  };
  writeFileSync(fixture, `${JSON.stringify(record, null, 1)}\n`);
}
process.stdout.write(wrong === 0 ? `all ${runs.length} verdicts as expected\n` : `${wrong} of ${runs.length} verdicts unexpected\n`);
process.exit(wrong === 0 ? 0 : 1);
