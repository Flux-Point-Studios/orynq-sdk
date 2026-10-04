import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as L from "@midnight-ntwrk/ledger-v8";
import { addEvent, addSpan, closeSpan, createManifest, createTrace, finalizeTrace, type TraceBundle } from "@fluxpointstudios/orynq-sdk-process-trace";
import { deriveSalt, hash32, hiddenDigest } from "../commitment.js";
import { registryInitialState } from "../registry.js";
import { toHex } from "../scale.js";
import type { MidnightSource } from "../source.js";
import { anchorChain, fixture } from "./anchor-chain.js";
import { finalBytes, pad32, unprovenRegistryCall } from "./registry-call.js";

// What the CLI and MCP suites verify: a real trace bundle, anchored with a user's own key, on
// the synthetic chain, read over HTTP the way a Midnight indexer and node answer.

export const USER_HEIGHTS = { public: 2030, hidden: 2031 } as const;

// A finalized bundle with a pinned model manifest and the storage manifest whose hash anchors
// commit to.
export async function traceBundle(): Promise<TraceBundle> {
  const run = await createTrace({ agentId: "surface-test", manifest: { modelHash: `sha256:${"4d".repeat(32)}`, framework: "anthropic", modelId: "test-model" } });
  const span = addSpan(run, { name: "work" });
  await addEvent<"observation">(run, span.id, { kind: "observation", observation: "anchored on Midnight", visibility: "public" });
  await closeSpan(run, span.id);
  const bundle = await finalizeTrace(run);
  const { manifest } = await createManifest(bundle);
  if (!manifest.manifestHash) throw new Error("createManifest returned a manifest without its hash");
  return { ...bundle, manifestHash: manifest.manifestHash };
}

export interface UserKeyBytes {
  authorSecret: Uint8Array;
  saltKey: Uint8Array;
}

// The bundle's kind-1 and kind-2 anchors by the holder of `key`, as the final bytes a submitter
// sends. The kind-2 commitment is the circuit's own, from a salt derived from the key's salt key.
export async function userAnchors(bundle: TraceBundle, key: UserKeyBytes) {
  const entry = { rootHash: hash32(bundle.rootHash, "rootHash"), manifestHash: hash32(bundle.manifestHash!, "manifestHash"), merkleRoot: hash32(bundle.merkleRoot, "merkleRoot") };
  const attribute = hash32(bundle.modelManifestHash!, "modelManifestHash");
  const salt = deriveSalt(key.saltKey, hiddenDigest(entry, attribute));
  const final = async (tx: L.UnprovenTransaction) => {
    const bytes = await finalBytes(tx);
    return { tx: toHex(bytes), txHash: L.Transaction.deserialize("signature", "proof", "binding", bytes).transactionHash() };
  };
  const at = { address: fixture.registry.address, state: registryInitialState() };
  const kind1 = unprovenRegistryCall({ ...at, call: { circuit: "anchor", args: [entryDigest(entry), 1n] }, witnesses: { authorSecret: key.authorSecret } });
  const kind2 = unprovenRegistryCall({
    ...at,
    call: { circuit: "anchor_hiding", args: [attribute] },
    witnesses: { authorSecret: key.authorSecret, hiddenEntry: { root_hash: entry.rootHash, manifest_hash: entry.manifestHash, merkle_root: entry.merkleRoot, salt } },
  });
  return {
    public: { ...(await final(kind1.tx)), commitment: toHex(kind1.after.last_commitment) },
    hidden: { ...(await final(kind2.tx)), commitment: toHex(kind2.after.last_commitment), attribute: toHex(attribute) },
  };
}

// entry_digest(root, manifest, merkle) = SHA-256(pad32("orynq:anchor-entry:v1") ‖ root ‖ manifest ‖ merkle),
// computed here with plain SHA-256 rather than through the library.
function entryDigest(entry: { rootHash: Uint8Array; manifestHash: Uint8Array; merkleRoot: Uint8Array }): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.concat([pad32("orynq:anchor-entry:v1"), entry.rootHash, entry.manifestHash, entry.merkleRoot])).digest());
}

// anchorChain with the bundle's user anchors placed at USER_HEIGHTS.
export async function userChain(bundle: TraceBundle, key: UserKeyBytes) {
  const anchors = await userAnchors(bundle, key);
  const chain = anchorChain({
    place: [
      [USER_HEIGHTS.public, "anchor", anchors.public.tx, anchors.public.txHash],
      [USER_HEIGHTS.hidden, "anchor", anchors.hidden.tx, anchors.hidden.txHash],
    ],
  });
  return { chain, anchors };
}

// `source` answering over HTTP as a Midnight indexer's GraphQL endpoint and a node's JSON-RPC
// endpoint, so a surface under test reaches it through its own flags or environment.
export async function serveSource(source: MidnightSource) {
  const graphql = async (body: { query: string; variables: Record<string, unknown> }) => {
    if (body.query.startsWith("query Transactions")) {
      const found = await source.indexer.transactions(String(body.variables.hash));
      return {
        data: {
          transactions: found.map((t) => ({
            __typename: "RegularTransaction",
            hash: t.hash,
            raw: t.raw,
            block: t.block,
            transactionResult: { status: t.status },
            contractActions: t.contractActions.map(({ kind, ...a }) => ({ __typename: kind, ...a })),
          })),
        },
      };
    }
    if (body.query.startsWith("query Head")) return { data: { block: await source.indexer.head() } };
    return { errors: [{ message: "the test indexer answers Transactions and Head only" }] };
  };
  const rpc = async (r: { id: number; method: string; params: unknown[] }) => {
    try {
      return { jsonrpc: "2.0", id: r.id, result: await source.node.call(r.method, r.params) };
    } catch (error) {
      return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (error as Error).message } };
    }
  };
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", async () => {
      requests.push(req.url ?? "");
      const body = JSON.parse(data);
      const out = req.url === "/graphql" ? await graphql(body) : Array.isArray(body) ? await Promise.all(body.map(rpc)) : await rpc(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { indexer: `${base}/graphql`, node: `${base}/rpc`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
