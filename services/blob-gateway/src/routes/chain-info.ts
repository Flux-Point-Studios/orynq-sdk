/**
 * Chain Info endpoint — returns current chain metadata for operator
 * auto-discovery and explorer `chain-info` proxy.
 *
 * External callers:
 *   - Operator auto-discovery (cert-daemon) polls this to detect chain forks
 *     and surface the current chain-spec URL.
 *   - The flux1 explorer's `/api/materios/explorer/chain-info` is a direct
 *     proxy to this route — breaking this endpoint takes the entire
 *     explorer Overview tab offline ("Chain Unreachable").
 *
 * Cached for 30s so we don't hammer substrate on every explorer hit.
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";

const router = Router();

interface ChainInfo {
  genesis: string;
  spec_version: number;
  best_block: number;
  finalized_block: number;
  bootnodes: string[];
  chain_spec_url: string;
  updated_at: string;
}

let cached: ChainInfo | null = null;
let lastPoll = 0;
const POLL_INTERVAL_MS = 30_000;

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex : "0x" + hex;
}

async function pollChain(): Promise<void> {
  const rpcUrl = config.materiosRpcUrl
    ?.replace("ws://", "http://")
    .replace("wss://", "https://");
  if (!rpcUrl) return;
  try {
    const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
      const resp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const data = (await resp.json()) as { result?: unknown };
      return data.result;
    };
    const genesis = (await rpc("chain_getBlockHash", [0])) as string | undefined;
    const version = (await rpc("state_getRuntimeVersion")) as { specVersion?: number } | undefined;
    const header = (await rpc("chain_getHeader")) as { number?: string } | undefined;
    const finHash = (await rpc("chain_getFinalizedHead")) as string | undefined;
    const finHeader = (await rpc("chain_getHeader", [finHash])) as { number?: string } | undefined;
    cached = {
      genesis: stripHexPrefix(genesis || ""),
      spec_version: version?.specVersion || 0,
      best_block: parseInt(header?.number || "0x0", 16),
      finalized_block: parseInt(finHeader?.number || "0x0", 16),
      bootnodes: [
        "/ip4/5.78.94.109/tcp/30333/p2p/12D3KooWEyoppNCUx8Yx66oV9fJnriXwCcXwDDUA2kj6vnc6iDEp",
      ],
      chain_spec_url:
        process.env.CHAIN_SPEC_URL ||
        "https://materios.fluxpointstudios.com/blobs/chain-spec-raw.json",
      updated_at: new Date().toISOString(),
    };
    lastPoll = Date.now();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chain-info] Poll error: ${msg}`);
  }
}

router.get("/chain-info", async (_req: Request, res: Response) => {
  if (!cached || Date.now() - lastPoll > POLL_INTERVAL_MS) {
    await pollChain();
  }
  if (cached) {
    res.json(cached);
  } else {
    res.status(503).json({ error: "Chain info not available yet" });
  }
});

export { router as chainInfoRouter };
export { pollChain as initChainInfoPoller };
