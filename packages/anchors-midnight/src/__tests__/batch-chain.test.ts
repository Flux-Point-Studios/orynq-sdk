import { expect, it } from "vitest";
import { createServer } from "node:http";
import { rpcOnlySource } from "../rpc-source.js";
import { verifyBatchProof } from "../batch-proof.js";
import { batchChain } from "./batch-chain.js";

it("authenticates a kind-3 receipt through real HTTP, storage proofs, runtime pins and GRANDPA", async () => {
  const fixture = await batchChain();
  let proofs = 0;
  const server = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      const incoming = JSON.parse(body);
      const answer = async (call: { id: number; method: string; params: unknown[] }) => {
        if (call.method === "state_getReadProof") proofs++;
        return { jsonrpc: "2.0", id: call.id, result: await fixture.chain.source.node.call(call.method, call.params) };
      };
      try { res.end(JSON.stringify(Array.isArray(incoming) ? await Promise.all(incoming.map(answer)) : await answer(incoming))); }
      catch (error) { res.writeHead(500).end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown test RPC error" })); }
    });
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const source = rpcOnlySource({ network: "mainnet", node: `http://127.0.0.1:${(server.address() as { port: number }).port}`, registries: [fixture.chain.registry], hints: [fixture.set.midnight] });
    const result = await verifyBatchProof({ proof: fixture.proof, network: "mainnet", materiosGenesis: fixture.batch.genesis, contentHash: fixture.proof.receipt.contentHash }, { source, registries: [fixture.chain.registry], knownAuthors: fixture.authors });
    expect(result.status, JSON.stringify({ reason: result.status === "valid" ? null : result.reason, failedChecks: result.anchor?.checks.filter(check => !check.ok) })).toBe("valid");
    expect(result.anchor?.assurance).toBe("consensus-verified");
    expect(proofs).toBeGreaterThanOrEqual(4);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
