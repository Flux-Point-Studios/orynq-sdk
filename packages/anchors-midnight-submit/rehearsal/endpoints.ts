import { blockfrostEndpoints, midnightSource, type SourceEndpoints } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

// Every broadcast and every read goes through Blockfrost preprod, the path a mainnet submitter takes.
export const source = midnightSource(blockfrostEndpoints("preprod", `${process.env.HOME}/.secrets/blockfrost-midnight-preprod.project_id`));

// Wallet sync only: the saved wallet state indexes Midnight's hosted indexer's event ids, which Blockfrost's do not match, so Blockfrost would mean a resync from genesis.
export const WALLET_SYNC: SourceEndpoints = {
  operator: "midnight",
  indexer: "https://indexer.preprod.midnight.network/api/v3/graphql",
  indexerWs: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
  node: "https://rpc.preprod.midnight.network",
  headers: {},
};
