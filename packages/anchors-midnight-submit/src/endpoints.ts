import { blockfrostEndpoints, type MidnightNetwork, type SourceEndpoints } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

// Midnight's own preprod indexer and node, which need no credential.
export const MIDNIGHT_HOSTED_PREPROD: SourceEndpoints = {
  operator: "midnight",
  indexer: "https://indexer.preprod.midnight.network/api/v3/graphql",
  indexerWs: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
  node: "https://rpc.preprod.midnight.network",
  headers: {},
};

// Where a submitter reads and writes on `network`: Blockfrost for mainnet, whose hosted
// endpoints Midnight retired, and for preprod Midnight's own endpoints unless a Blockfrost
// project id file is given.
export function networkEndpoints(network: MidnightNetwork, { blockfrostProjectIdFile }: { blockfrostProjectIdFile?: string } = {}): SourceEndpoints {
  if (blockfrostProjectIdFile) return blockfrostEndpoints(network, blockfrostProjectIdFile);
  if (network === "mainnet") throw new Error("mainnet needs a Blockfrost project id file: Midnight's hosted mainnet endpoints were retired on 2026-09-30");
  return MIDNIGHT_HOSTED_PREPROD;
}
