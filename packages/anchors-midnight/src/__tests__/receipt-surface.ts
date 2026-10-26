import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { certHash } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { batchChain } from "./batch-chain.js";
import { serveSource } from "./surface-chain.js";

export async function receiptSurface() {
  const fixture = await batchChain(), rpc = await serveSource(fixture.chain.source);
  const sha = (body: string) => createHash("sha256").update(body).digest("hex");
  const set = JSON.stringify(fixture.set), memberSha = sha(fixture.snapshot), setSha = sha(set);
  let corrupt = false, requests = 0;
  const server = createServer((req, res) => {
    requests++; res.setHeader("Content-Type", "application/json");
    if (req.url!.includes("/members/by-leaf/")) res.end(JSON.stringify({ candidates: [{ sha256: memberSha, anchorId: fixture.batch.anchorId.slice(2) }], unreadableCandidates: [], nextCursor: null }));
    else if (req.url!.includes("/sets/by-anchor/")) res.end(JSON.stringify({ candidates: [{ sha256: setSha }], unreadableCandidates: [], nextCursor: null }));
    else if (req.url!.endsWith(memberSha)) res.end(fixture.snapshot + (corrupt ? " " : ""));
    else if (req.url!.endsWith(setSha)) res.end(set);
    else res.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  return { fixture, gateway: `http://127.0.0.1:${(server.address() as { port: number }).port}`, node: rpc.node,
    query: { network: "mainnet" as const, materiosGenesis: fixture.batch.genesis, receiptId: fixture.proof.receipt.receiptId, contentHash: fixture.proof.receipt.contentHash,
      certificateHash: certHash(fixture.batch.receipts[0]!.certFormat, fixture.batch.genesis, fixture.proof.receipt.receiptId, fixture.batch.receipts[0]!).slice(2) },
    corrupt: (value = true) => { corrupt = value; }, requests: () => requests, chainRequests: () => rpc.requests.length,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rpc.close(); } };
}
