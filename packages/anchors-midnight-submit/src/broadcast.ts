import { homedir } from "node:os";
import { midnightExtrinsic, readPrivateFile, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export interface NodeRefusal {
  code: number;
  message: string;
  data?: unknown;
}

const REFUSAL = /^\S+ node: author_submitExtrinsic failed: (\{.*\})$/s;

// The node's own JSON-RPC answer refusing a submission, as the source reports it. Anything else
// (a transport failure, an HTTP error, a timeout) is null: those bytes may have been delivered.
export function nodeRefusal(error: unknown): NodeRefusal | null {
  const json = error instanceof Error ? REFUSAL.exec(error.message)?.[1] : undefined;
  if (json === undefined) return null;
  const { code, message, data } = JSON.parse(json) as Record<string, unknown>;
  if (!Number.isSafeInteger(code) || typeof message !== "string") return null;
  return { code: code as number, message, ...(data === undefined ? {} : { data }) };
}

// Substrate's "Transaction Already Imported": the node already holds these exact bytes, so a
// second broadcast after a lost answer has nothing left to deliver.
const DUPLICATE_CODES = [1012, 1013];

// Hands the exact final bytes to the node as the bare extrinsic Midnight.send_mn_transaction,
// over the source's JSON-RPC endpoint and its credential headers. Inclusion is learned from the
// indexer by transaction hash, never from this call.
export async function broadcast(source: MidnightSource, bytes: Uint8Array): Promise<void> {
  try {
    await source.node.call<string>("author_submitExtrinsic", [`0x${Buffer.from(midnightExtrinsic(bytes)).toString("hex")}`]);
  } catch (error) {
    if (!DUPLICATE_CODES.includes(nodeRefusal(error)?.code ?? 0)) throw error;
  }
}

export async function broadcastPaths(bytes: Uint8Array, paths: Array<{ name: string; send(bytes: Uint8Array): Promise<void> }>, log: (line: string) => void, expiresAt = Infinity): Promise<void> {
  let accepted = false;
  for (const path of paths) {
    if (Date.now() >= expiresAt) break;
    try {
      await path.send(bytes);
      accepted = true;
      log(`${path.name}: broadcast accepted (inclusion unproven)`);
    } catch {
      // Provider errors can contain authentication headers or response bodies.
      log(`${path.name}: broadcast failed`);
    }
  }
  // Any timed-out path may have accepted the bytes: no single-node refusal can release DUST.
  if (!accepted) throw new Error("all broadcast paths failed; delivery is uncertain and DUST stays reserved");
}

function rpcResult(reply: { result?: unknown; error?: { code?: number } }): void {
  if (reply.error && DUPLICATE_CODES.includes(reply.error.code ?? 0)) return;
  if (reply.error || typeof reply.result !== "string" || !/^0x[0-9a-f]{64}$/i.test(reply.result)) throw new Error("broadcast RPC refused or returned no extrinsic hash");
}

export async function mainnetBroadcast(bytes: Uint8Array, primary: (bytes: Uint8Array) => Promise<void>, expiresAt: number): Promise<void> {
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "author_submitExtrinsic", params: [`0x${Buffer.from(midnightExtrinsic(bytes)).toString("hex")}`] });
  await broadcastPaths(bytes, [
    { name: "primary", send: primary },
    { name: "Foundation", send: async () => new Promise<void>((resolve, reject) => {
      const ws = new WebSocket("wss://rpc.mainnet.midnight.network");
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ws.close();
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error("broadcast timeout")), 10_000);
      ws.addEventListener("open", () => ws.send(request));
      ws.addEventListener("error", () => finish(new Error("broadcast transport failed")));
      ws.addEventListener("close", () => finish(new Error("broadcast connection closed")));
      ws.addEventListener("message", (event) => {
        try {
          const reply = JSON.parse(String(event.data));
          if (reply.id !== 1) return;
          rpcResult(reply);
          finish();
        } catch { finish(new Error("broadcast RPC failed")); }
      });
    }) },
    { name: "1AM", send: async () => {
      const token = readPrivateFile(`${homedir()}/.secrets/oneam-midnight.session`).trim();
      if (!token || /\s/.test(token)) throw new Error("invalid 1AM session");
      const response = await fetch("https://api.1am.xyz/rpc/midnight", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": token },
        body: request, signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      if (!response.ok) throw new Error("broadcast HTTP failed");
      const reply = await response.json() as { id?: number; result?: unknown; error?: { code?: number } };
      if (reply.id !== 1) throw new Error("broadcast RPC id mismatch");
      rpcResult(reply);
    } },
  ], (line) => process.stdout.write(`${line}\n`), expiresAt);
}
