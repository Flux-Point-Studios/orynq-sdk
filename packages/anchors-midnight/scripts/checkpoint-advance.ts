import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkpointId } from "../src/checkpoints.js";
import { checkpointFromJson, deriveCheckpointAdvance, verifyCheckpointAdvanceHistory, type CheckpointAdvance } from "../src/checkpoint-advance.js";
import { knownAuthors, type KnownAuthors } from "../src/known-authors.js";
import { headerFromRpc, headerHash, type RpcHeader } from "../src/substrate.js";
import { finalityRpc, type MidnightSource } from "../src/source.js";
import { rpcOnlySource } from "../src/rpc-source.js";
import { writePrivateFile } from "../src/private-file.js";
import type { MidnightNetwork } from "../src/registries.js";
import { verifyBlockEffects } from "../src/execution.js";

export async function checkpointMaintenance(argv: string[], dependencies: { authors?: () => KnownAuthors; source?: (network: MidnightNetwork, node: string, signal: AbortSignal) => MidnightSource; now?: () => number } = {}) {
  const [command, ...args] = argv;
  if (command !== "derive" && command !== "verify") throw new Error("Use checkpoint-advance.ts derive|verify --network mainnet|preprod --history FILE [--node HTTPS --out NEW_FILE]");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--network", "--history", "--node", "--out"].includes(key) || value === undefined || value.startsWith("--") || values.has(key)) throw new Error("Invalid checkpoint maintenance arguments");
    values.set(key, value);
  }
  const network = values.get("--network"), input = values.get("--history");
  if ((network !== "mainnet" && network !== "preprod") || !input) throw new Error("Checkpoint maintenance requires network and history");
  let artifacts: CheckpointAdvance[] = [];
  if (existsSync(input)) {
    if (!statSync(input).isFile() || statSync(input).size > 512 * 1024 * 1024) throw new Error("Checkpoint history input exceeds its bounds");
    let value: unknown;
    try { value = JSON.parse(readFileSync(input, "utf8")); } catch { throw new Error("Checkpoint history input is not JSON"); }
    if (!Array.isArray(value)) throw new Error("Checkpoint history input must be a list");
    artifacts = value;
  } else throw new Error("Checkpoint history input is missing");
  const originals = (dependencies.authors ?? knownAuthors)().checkpoints(network);
  const verified = await verifyCheckpointAdvanceHistory({ expectedNetwork: network, checkpoints: originals, artifacts });
  if (command === "verify") {
    if (values.has("--node") || values.has("--out")) throw new Error("Offline verification takes no node or output path");
    return { network, artifacts: verified.artifacts.length, tips: verified.tips.map(tip => ({ rootId: tip.rootId, sequence: tip.sequence, checkpointId: checkpointId(tip.checkpoint), digest: tip.digest })) };
  }
  const node = values.get("--node"), output = values.get("--out");
  if (!node || !output || resolve(input) === resolve(output)) throw new Error("Derivation requires a node and a distinct new output path");
  const url = new URL(node), loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(network === "preprod" && url.protocol === "http:" && loopback))) throw new Error("Invalid checkpoint maintenance endpoint");
  const abort = new AbortController(), stop = () => abort.abort();
  const timer = setTimeout(stop, 45 * 60_000);
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    const source = dependencies.source?.(network, node, abort.signal) ?? rpcOnlySource({ network, node, operator: "checkpoint-maintenance", hints: [], registries: [], signal: abort.signal, httpBudget: { requests: 1024, bytes: 64 * 1024 * 1024, abort } });
    const hash = await source.node.call<unknown>("chain_getFinalizedHead");
    if (typeof hash !== "string" || !/^0x[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid checkpoint head hint");
    const header = headerFromRpc(await source.node.call<RpcHeader>("chain_getHeader", [hash]));
    if (Buffer.from(headerHash(header)).toString("hex") !== hash.slice(2)) throw new Error("Checkpoint head header differs");
    const prior = verified.tips.filter(tip => tip.checkpoint.startsAfter.height < header.number).sort((a, b) => b.checkpoint.startsAfter.height - a.checkpoint.startsAfter.height)[0];
    if (!prior) throw new Error("No pinned predecessor lies below the checkpoint target");
    const artifact = await deriveCheckpointAdvance({ network, predecessor: prior.checkpoint, rpc: finalityRpc(source), block: { height: header.number, hash: hash.slice(2) }, sequence: prior.sequence + 1, previousDigest: prior.digest, rootId: prior.rootId });
    const effects = await verifyBlockEffects(source.node, { blockHash: hash.slice(2), header });
    const now = (dependencies.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0 || now - effects.timestamp > 120_000 || effects.timestamp - now > 30_000) throw new Error("Checkpoint maintenance target is not fresh");
    const next = [...verified.artifacts, artifact];
    await verifyCheckpointAdvanceHistory({ expectedNetwork: network, checkpoints: originals, artifacts: next });
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writePrivateFile(output, JSON.stringify(next));
    return { network, artifacts: next.length, rootId: artifact.rootId, sequence: artifact.sequence, checkpointId: checkpointId(checkpointFromJson(artifact.successor)), targetHeight: header.number, targetTime: effects.timestamp };
  } finally { clearTimeout(timer); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  checkpointMaintenance(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), () => { console.error("Checkpoint maintenance failed; input, continuity, source and resource checks are required"); process.exitCode = 1; });
}
