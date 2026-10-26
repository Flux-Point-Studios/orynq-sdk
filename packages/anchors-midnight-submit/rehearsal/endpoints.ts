import { blockfrostEndpoints, midnightSource, type SourceEndpoints } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

// Every broadcast and every read goes through Blockfrost preprod, the path a mainnet submitter takes.

// Wallet sync only: the saved wallet state indexes Midnight's hosted indexer's event ids, which Blockfrost's do not match, so Blockfrost would mean a resync from genesis.
export const WALLET_SYNC: SourceEndpoints = {
  operator: "midnight",
  indexer: "https://indexer.preprod.midnight.network/api/v3/graphql",
  indexerWs: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
  node: "https://rpc.preprod.midnight.network",
  headers: {},
};

// Opt-in only, for large preprod writes without a project id. Independent pack verification
// still uses Blockfrost; never relabel a hosted-node refusal as a Blockfrost-node observation.
import { submitPublicPreprod } from "./public-preprod.js";
const publicWrites = process.env.REHEARSAL_PUBLIC_PREPROD_WS;
if (publicWrites !== undefined && publicWrites !== "1") throw new Error("REHEARSAL_PUBLIC_PREPROD_WS must be 1 when configured");
const reads = midnightSource(publicWrites ? WALLET_SYNC : blockfrostEndpoints("preprod", `${process.env.HOME}/.secrets/blockfrost-midnight-preprod.project_id`));
export const source = publicWrites ? {
  ...reads,
  node: { ...reads.node, call: async <T>(method: string, params: unknown[] = []): Promise<T> => method === "author_submitExtrinsic" ? await submitPublicPreprod(params[0]) as T : reads.node.call<T>(method, params) },
} : reads;
