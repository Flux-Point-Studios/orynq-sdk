// Records what verifyMateriosCheckpointAnchor reads from Cardano mainnet through Koios for the
// anchors below into FIXTURE, the file src/__tests__/materios-checkpoint.test.ts replays, and exits 1
// unless every run in RUNS gives the verdict it expects. It reads Koios and nothing else. From this
// package's directory, after pnpm build:
//   node scripts/record-materios-checkpoint.mjs src/__tests__/fixtures/materios-checkpoint-mainnet.json
//
// The claims are public data read on 2026-10-24; every run checks them against the chain. RECEIPTS
// are OrinqReceipts.Receipts[receipt_id], raw SCALE from Materios state. Leaf hashes, block ranges,
// anchor ids and tx hashes are the gateway's batch records (GET /preprod-blobs/batches/{anchorId}),
// except the flat anchor's tx hash, which its batch record lacks and that worker's log names; its
// one leaf is a receipt of the core checkpoint corpus. The two batches whose record names another
// chain than its leaves and manifest commit to were found by a survey of the pinned wallets' label
// 8746 records: each is a one-leaf anchor whose root is the leaf of a core checkpoint corpus receipt.
// A certification block is the block of the receipt's AvailabilityCertified event (events indexer
// /receipt-attestors); a one-leaf batch's range is that block.
import { writeFileSync } from "node:fs";
import { decodeReceiptRecord, merklePath } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { verifyMateriosCheckpointAnchor } from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import { createKoiosCheckpointSource } from "@fluxpointstudios/orynq-sdk-anchors-cardano/providers";

const LIVE_GENESIS = "0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf";
// The cert-daemon kept binding this earlier chain's genesis into its leaves and manifests until
// 2026-05-12, two weeks into LIVE_GENESIS's chain.
const LEGACY_GENESIS = "bc0531cb311281565036fb397a376f0e0fa37005589655f97a7924b2729a164c";
const WALLETS = {
  // Funds every anchor the live cert-daemon path writes, in the detailed-schema encoding.
  worker: "addr1v8jk9tqygmwd7xvf86pkz2033ahf0zrzdeesz0wy25my7xqgduf4l",
  // Funded the Lucid-based worker's flat anchors (2026-04-18 to 2026-06-29) and a v:3 finality record.
  lucid: "addr1qx2h3pcsp6l9lxc0nujfdrczrmmstvju024xxvjcu2ywptslud3z94x5tgw8p0aefdjm8wxwrt0j49y384nuxgsjd9xq89stdk",
};
const RECEIPTS = {
  "0x4888d96dd61c26a8ade6886c89c403cc62f4dcbb1185651a227185453a1cefe8":
    "0000000000000000000000000000000000000000000000000000000000000000b5a0f702bb85225c9b7b306307a0a557b09c246833492de935a0cbd552c82eb3b5a0f702bb85225c9b7b306307a0a557b09c246833492de935a0cbd552c82eb3010000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000cab0f81814eb84c9338938e702c8e8854c6cb17b371a9fd784a08e41c75d71b500000000000000000000000000000000000000000000000000000000000000007393991383aa2010796da231c1f4b54b86ff49b5b44428027a89901134f35a900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000023f6217f5204a2efb06d340b9ea14aad9e898b89830b66f25ffdfb91d2a02d4dc0942f189e010000d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
  "0x49e4c772346c02f26e5759763a424336930ed382059ba38061d4cfa1d48fa386":
    "cab0f81814eb84c9338938e702c8e8854c6cb17b371a9fd784a08e41c75d71b5305f36018a93bf92c0acee7f4c040b4c183afb0b968c7daa4b4ed6bf1b0bbdda305f36018a93bf92c0acee7f4c040b4c183afb0b968c7daa4b4ed6bf1b0bbdda00002e25b1d154a705e7ba1d8f681b21a339c28919c14a75a44a52f8843d6de0049e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f4be40717f9e568698f143576e1234d787d974d7422a61e417250700c58b75910ee18fd9e010000d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
  "0x81af72e96bb24ce917a511ebb3b32c28eb60ebb500f0b31a8d6217b07638cbe7":
    "2aa950df31d7f9efa570f39e1fce597e287d30b2d22e223428d155261573d73269bb2fa6c306cd54688af465fb316737fd17323af416e574ab602f3ed32f7e0f69bb2fa6c306cd54688af465fb316737fd17323af416e574ab602f3ed32f7e0f0000946fb6db4df45d6e40e71abcd6a63b66b2c97cd80274aab773e4f0589c897fa100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008fb3693459333fb821928baf4c0504150fdffe9d3d6fc383433c31a1ea984fbe7078356ca1010000d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
  "0xd99f66f17695a54861006ee4ce3762e4af7b30cab2b9b1d6136ff044794fb72c":
    "2aa950df31d7f9efa570f39e1fce597e287d30b2d22e223428d155261573d732f4ee007e8ab51202a85bdff4d4f820d3d16c2c0cf0eca7ca3d628ca78ad190b1f4ee007e8ab51202a85bdff4d4f820d3d16c2c0cf0eca7ca3d628ca78ad190b10000e71575137da33ec7f868d0ff8042a94c270a7313a0019c68aa1328261f442a9300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006425ba7808cd7229c4712aecedd4c1ef16595cef72b77ac762ca051577467593608a527c9f010000d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
  // A dcbor-v1 receipt whose Cert names LEGACY_GENESIS.
  "0x24ae1ca8d5f6494d716927ba6c4d950b2b6220211ac159b23b7bf071b31abd6a":
    "0000000000000000000000000000000000000000000000000000000000000000a8453427d2cfd9afbc6110af5acd5002073cfc31a2b018bc350ae5ec5fbc550f014e30d9a922772aa0083be49277fc8f5833eab65707916ca5c85a2de5415b44000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a8453427d2cfd9afbc6110af5acd5002073cfc31a2b018bc350ae5ec5fbc550f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000443f3cad15230f873828bb1a09f6299a5a4679349c0d32c988efd6f09af72d1500b818f99d01000098e8b2b482eaae94f6e5276440169c47d55817a81de8b5cb8e290d681ef64713",
};
const BATCHES = {
  wrapped5: {
    genesis: LIVE_GENESIS,
    txHash: "f5839cb05c63e51bf9628c13b43c9d809a0c6218f08cc314f8b7e8b0504cae9d",
    anchorId: "0x58195392534123d10f5f30325d533fd571e7ffd2871dece07571a0ce20092a92",
    rootHash: "63274c072be9336905146221bb950a30434abd363000f9587fea33f390bdb486",
    leafHashes: [
      "88931b8023d476504f5308514e0b3fc139d945c932f7c1d182bbed4b112d6b16",
      "7366d8f09551e47b9a9623d5c3511f7415a5e4698769ef1f0215be25c2001588",
      "157dd1081cd6dfe94470b52e78ce4ce3f9274eb97dd66c1e9bd4d604a3c6f355",
      "9e9e3bd42c036d55e0b2cdf79ccb559d33c12dcbfbccf8e2925aac91efcd117c",
      "564bb8e435f1c7a46068412de93b102ea837e7915db7097afc28e8afba4808ce"
    ],
    fromBlock: 2426749,
    toBlock: 2426811,
    receiptId: "0x4888d96dd61c26a8ade6886c89c403cc62f4dcbb1185651a227185453a1cefe8",
    leaf: "0x157dd1081cd6dfe94470b52e78ce4ce3f9274eb97dd66c1e9bd4d604a3c6f355",
    certifiedBlock: 2426751
  },
  wrapped3: {
    genesis: LIVE_GENESIS,
    txHash: "2abb9fc984dc60c9a9723fb72778d8d5a1c217aa21f82c55299326f5193456e5",
    anchorId: "0xad866d1824d87c9413d49c4440c3a1efddb77bae06ef143b3d6b7367e0922772",
    rootHash: "28c69c86b4601d1ea829443760a9396dec4d2a0f16686c8b601a4282d3ddff4b",
    leafHashes: [
      "efbbdab9ffde29c46804342a622d7050ae5268d1cd3ebda42840b9c82e59b079",
      "90944130a7c69502a91ae4192f2ba9b0a966a2538e215e5704c68edfa8b6f714",
      "f8b3a8afa0165e97bd27c49dbd951728390ea722b70c49a93f4b3495033a1ac7"
    ],
    fromBlock: 2420514,
    toBlock: 2420840,
    receiptId: "0x81af72e96bb24ce917a511ebb3b32c28eb60ebb500f0b31a8d6217b07638cbe7",
    leaf: "0xf8b3a8afa0165e97bd27c49dbd951728390ea722b70c49a93f4b3495033a1ac7",
    certifiedBlock: 2420840
  },
  flat1: {
    genesis: LIVE_GENESIS,
    txHash: "7371ac946c94e8a3677f80f18f4451161860293c66583e630988bf4837b60021",
    anchorId: "0x13ed9e10bb2988f4e82d38b390fefeae462b2233a7b1bb98dd04ce031ee55544",
    rootHash: "bc6f02abe0e66081a7b0f8e0cd2232195843c70bf18de00f063fb433c5daf802",
    leafHashes: [
      "bc6f02abe0e66081a7b0f8e0cd2232195843c70bf18de00f063fb433c5daf802"
    ],
    fromBlock: 711540,
    toBlock: 711540,
    receiptId: "0x49e4c772346c02f26e5759763a424336930ed382059ba38061d4cfa1d48fa386",
    leaf: "0xbc6f02abe0e66081a7b0f8e0cd2232195843c70bf18de00f063fb433c5daf802",
    certifiedBlock: 711540
  },
  // The live worker's record names its fallback chain id 5663079a…; its leaf and manifest commit to LIVE_GENESIS.
  fallbackLabel1: {
    genesis: LIVE_GENESIS,
    txHash: "d736a898c5a37087479199b79c1c9c346f1e89ea01301d95488ed5637afd3c1b",
    rootHash: "806705e210474e453fc3c1d4ff37e2f34d83022d96df025e094524ed37bcee3a",
    leafHashes: [
      "806705e210474e453fc3c1d4ff37e2f34d83022d96df025e094524ed37bcee3a"
    ],
    fromBlock: 1053004,
    toBlock: 1053004,
    receiptId: "0xd99f66f17695a54861006ee4ce3762e4af7b30cab2b9b1d6136ff044794fb72c",
    leaf: "0x806705e210474e453fc3c1d4ff37e2f34d83022d96df025e094524ed37bcee3a",
    certifiedBlock: 1053004
  },
  // The Lucid-based worker's flat record names LIVE_GENESIS; its leaf and manifest commit to LEGACY_GENESIS.
  legacyGenesis1: {
    genesis: LEGACY_GENESIS,
    txHash: "4310e0d9aa187cb6dc1522a903996680cc7e58671eac017fbe9c893f434a1dd1",
    rootHash: "e809c9e1bf812de9cc152c444d865db1a727d422d889d24ca1d073735b57d05a",
    leafHashes: [
      "e809c9e1bf812de9cc152c444d865db1a727d422d889d24ca1d073735b57d05a"
    ],
    fromBlock: 75109,
    toBlock: 75109,
    receiptId: "0x24ae1ca8d5f6494d716927ba6c4d950b2b6220211ac159b23b7bf071b31abd6a",
    leaf: "0xe809c9e1bf812de9cc152c444d865db1a727d422d889d24ca1d073735b57d05a",
    certifiedBlock: 75109
  },
};
// The v:3 finality record the Lucid wallet wrote under label 8746.
const FINALITY_RECORD_TX = "1c52f9fad96530da0f672149c2de4d48942991559a1354c7a9f7abe9b86085aa";
// A scan from just below wrapped5's block finds it and the worker's later anchors, among them this one.
const SCAN_FROM_BLOCK_HEIGHT = 14110400;
const SCAN_LATER_TX = "8d7519d46cef28ce5c2a72304befa1aa9b97d557e5035f3dadeffb714ae31b90";

// The cert-daemon hashes Python json.dumps(manifest, sort_keys=True) with its default separators.
// This writes that preimage out by hand, independent of the SDK's manifestHash, for the suite to
// compare against the manifest each anchor carries.
const manifestPreimage = (b) =>
  `{"cardano_network_id": "", "count": ${b.leafHashes.length}, "from_block": ${b.fromBlock}, "materios_chain_id": "${b.genesis}", "root": "${b.rootHash}", "to_block": ${b.toBlock}}`;

function claim(name, over = {}) {
  const b = BATCHES[name];
  const record = decodeReceiptRecord(Buffer.from(RECEIPTS[b.receiptId], "hex"));
  return {
    genesis: b.genesis,
    receiptId: b.receiptId,
    cert: { certFormat: { format: "scale-v1", chainId: null }, contentHash: record.contentHash, baseRootSha256: record.baseRootSha256, storageLocatorHash: record.storageLocatorHash },
    certifiedBlock: b.certifiedBlock,
    inclusion: { leafHashes: b.leafHashes },
    manifest: { fromBlock: b.fromBlock, toBlock: b.toBlock },
    anchorId: b.anchorId,
    cardano: { txHash: b.txHash },
    ...over,
  };
}

const byCertHash = (name) => ({ cert: undefined, certHash: decodeReceiptRecord(Buffer.from(RECEIPTS[BATCHES[name].receiptId], "hex")).availabilityCertHash });
const lastLeaf = () => ({ ...byCertHash("wrapped3"), inclusion: { index: 2, count: 3, path: merklePath(BATCHES.wrapped3.leafHashes, 2) } });
const scan = { cardano: { scanFromBlockHeight: SCAN_FROM_BLOCK_HEIGHT } };

// want: null for verified, else the check expected to refuse.
const RUNS = [
  { name: "five-leaf detailed-schema anchor, receipt fields and leaf list", claim: claim("wrapped5"), want: null },
  { name: "three-leaf detailed-schema anchor, last leaf by Merkle path", claim: claim("wrapped3", lastLeaf()), want: null },
  { name: "flat anchor of the Lucid-based worker", claim: claim("flat1"), want: null },
  { name: "detailed-schema anchor naming the worker's fallback chain id", claim: claim("fallbackLabel1"), want: null },
  // The core encoder rebuilds a dcbor-v1 Cert only for LIVE_GENESIS, so this receipt is claimed by its cert hash.
  { name: "flat anchor whose leaf and manifest commit to the earlier genesis", claim: claim("legacyGenesis1", byCertHash("legacyGenesis1")), want: null },
  { name: "scan of the pinned wallets", claim: claim("wrapped5", scan), want: null },
  { name: "v:3 finality record", claim: claim("wrapped5", { cardano: { txHash: FINALITY_RECORD_TX } }), want: "record" },
  { name: "flat anchor with its wallet unpinned", claim: claim("flat1"), wallets: [WALLETS.worker], want: "wallet" },
  { name: "scan with only the Lucid wallet pinned", claim: claim("wrapped5", scan), wallets: [WALLETS.lucid], want: "tx" },
];

const [fixture] = process.argv.slice(2);
if (!fixture) {
  process.stderr.write("usage: node scripts/record-materios-checkpoint.mjs FIXTURE\n");
  process.exit(2);
}

const koios = {};
async function recordingFetch(input, init) {
  const response = await fetch(input, init);
  if (!response.ok) return response;
  const answer = await response.json();
  koios[`${init?.method ?? "GET"} ${String(input)} ${init?.body ?? ""}`] = answer;
  return new Response(JSON.stringify(answer), { status: response.status });
}
const source = createKoiosCheckpointSource({ network: "mainnet", fetchFn: recordingFetch });

let wrong = 0;
for (const run of RUNS) {
  const r = await verifyMateriosCheckpointAnchor(run.claim, { source, anchorWallets: run.wallets ?? [WALLETS.worker, WALLETS.lucid] });
  const got = r.refusal?.check ?? null;
  const ok = got === run.want;
  if (!ok) wrong++;
  process.stdout.write(`${ok ? "as expected" : "UNEXPECTED "}  ${run.name}: ${r.verified ? `verified in ${r.txHash}, ${r.confirmations} confirmations` : `refused by ${got}: ${r.refusal.reason}`}\n`);
}
const scanned = Object.entries(koios).some(([key, answer]) => key.includes("/tx_info") && Array.isArray(answer) && answer.length > 1 && answer.some((row) => row.tx_hash === SCAN_LATER_TX));
if (!scanned) {
  wrong++;
  process.stdout.write(`UNEXPECTED   the scan did not list ${SCAN_LATER_TX}\n`);
}
if (wrong) process.exit(1);

const batches = Object.fromEntries(Object.entries(BATCHES).map(([name, b]) => [name, { ...b, manifestPreimage: manifestPreimage(b) }]));
const recording = {
  recordedAt: new Date().toISOString(),
  wallets: WALLETS,
  receipts: RECEIPTS,
  batches,
  finalityRecordTx: FINALITY_RECORD_TX,
  scanFromBlockHeight: SCAN_FROM_BLOCK_HEIGHT,
  scanLaterTx: SCAN_LATER_TX,
  koios,
};
writeFileSync(fixture, `${JSON.stringify(recording, null, 1)}\n`);
process.stdout.write(`wrote ${Object.keys(koios).length} Koios answers to ${fixture}\n`);
