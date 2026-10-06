import { blockfrostEndpoints, type MidnightNetwork, type SourceEndpoints } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

const WHY_BLOCKFROST: Record<MidnightNetwork, string> = {
  mainnet: "Midnight's hosted mainnet endpoints were retired on 2026-09-30",
  preprod: "Midnight's hosted preprod node refuses JSON-RPC request bodies over about 7 KB, smaller than any deploy or anchor",
};

// Where a submitter reads and writes on `network`: Blockfrost, authenticated by the project id
// in an owner-only file, on mainnet and preprod alike.
export function networkEndpoints(network: MidnightNetwork, { blockfrostProjectIdFile }: { blockfrostProjectIdFile?: string } = {}): SourceEndpoints {
  if (!blockfrostProjectIdFile) throw new Error(`${network} needs a Blockfrost project id file: ${WHY_BLOCKFROST[network]}`);
  return blockfrostEndpoints(network, blockfrostProjectIdFile);
}
