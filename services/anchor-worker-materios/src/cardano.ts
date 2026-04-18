/**
 * Cardano L1 settlement for Materios checkpoint anchors.
 *
 * Builds a metadata transaction under label 8746 carrying the
 * materios-anchor-v2 payload (see `@fluxpointstudios/orynq-sdk-anchors-cardano`
 * `buildMateriosAnchorV2`), signs it with the configured wallet, and submits
 * via Kupo+Ogmios (no Blockfrost dependency).
 *
 * This path is distinct from the direct-to-Cardano POI anchor flow (label
 * 2222, `packages/anchors-cardano/anchor-builder.ts`). Don't conflate them.
 */

import { readFileSync } from "node:fs";
import { Lucid, Kupmios, type TxHash } from "lucid-cardano";
import { ApiPromise, WsProvider } from "@polkadot/api";
import {
  MATERIOS_ANCHOR_LABEL,
  buildMateriosAnchorV2,
  scanForSeedPhrase,
} from "@fluxpointstudios/orynq-sdk-anchors-cardano";

import {
  CARDANO_L1_ENABLED,
  CARDANO_KUPO_URL,
  CARDANO_OGMIOS_URL,
  CARDANO_MNEMONIC_PATH,
  CARDANO_NETWORK,
  MATERIOS_RPC_URL,
} from "./config.js";

let lucid: Awaited<ReturnType<typeof Lucid.new>> | null = null;
let materiosGenesisHex = "";

/**
 * Load mnemonic from disk — NEVER from env — and initialise Lucid once.
 * Also queries the configured Materios RPC for the chain's genesis hash so
 * we can tag each anchor with `chain` (v2 schema requires it).
 */
async function getLucid(): Promise<Awaited<ReturnType<typeof Lucid.new>>> {
  if (lucid) return lucid;

  const mnemonic = readFileSync(CARDANO_MNEMONIC_PATH, "utf-8").trim();
  if (!mnemonic || mnemonic.split(/\s+/).length < 12) {
    throw new Error(
      `Invalid Cardano mnemonic at ${CARDANO_MNEMONIC_PATH} — expected a BIP39 phrase`,
    );
  }

  const provider = new Kupmios(CARDANO_KUPO_URL, CARDANO_OGMIOS_URL);
  const instance = await Lucid.new(provider, CARDANO_NETWORK);
  instance.selectWalletFromSeed(mnemonic);
  lucid = instance;
  const address = await instance.wallet.address();
  console.log(`[cardano-l1] wallet: ${address}`);

  // Resolve Materios chain genesis — used as the "chain" tag in v2 metadata.
  try {
    const mat = await ApiPromise.create({
      provider: new WsProvider(MATERIOS_RPC_URL),
    });
    const genesis = await mat.rpc.chain.getBlockHash(0);
    materiosGenesisHex = genesis.toHex().replace(/^0x/, "");
    await mat.disconnect();
    console.log(`[cardano-l1] materios genesis: 0x${materiosGenesisHex}`);
  } catch (e) {
    console.warn(
      `[cardano-l1] could not resolve Materios genesis: ${(e as Error).message}; "chain" field will be empty`,
    );
  }

  return lucid;
}

export interface CardanoAnchorRequest {
  rootHash: string;
  manifestHash?: string;
  batchMetadata?: {
    blockRangeStart?: number;
    blockRangeEnd?: number;
    leafCount?: number;
    [k: string]: unknown;
  };
  /** Full request body — used for recursive BIP39 scan. */
  rawBody?: unknown;
}

export interface CardanoAnchorResult {
  txHash: TxHash;
  label: number;
}

/**
 * Submit a Materios checkpoint to Cardano L1 under label 8746 with v2 schema.
 *
 * Throws if the request body contains any BIP39-shaped string (prevents seed
 * phrase leakage into permanent on-chain metadata).
 */
export async function submitToCardano(
  req: CardanoAnchorRequest,
): Promise<CardanoAnchorResult> {
  if (!CARDANO_L1_ENABLED) {
    throw new Error("Cardano L1 settlement is disabled (CARDANO_L1_ENABLED=false)");
  }

  // Defence-in-depth: refuse any payload that looks like it contains a
  // seed phrase. Even with a clean upstream, this guard protects the signing
  // wallet from a malformed caller.
  const seedHit = scanForSeedPhrase(req.rawBody ?? req);
  if (seedHit) {
    throw new Error(
      `Refusing to anchor: payload at ${seedHit} looks like a BIP39 seed phrase`,
    );
  }

  const lucidInstance = await getLucid();
  const address = await lucidInstance.wallet.address();

  const from = req.batchMetadata?.blockRangeStart ?? 0;
  const to = req.batchMetadata?.blockRangeEnd ?? from;
  const leaves = req.batchMetadata?.leafCount ?? 1;

  const metadata = buildMateriosAnchorV2({
    chain: materiosGenesisHex,
    blocks: [from, to],
    leaves,
    root: req.rootHash,
    manifest: req.manifestHash ?? req.rootHash,
  });

  console.log(
    `[cardano-l1] v2 entry label=${MATERIOS_ANCHOR_LABEL} ${JSON.stringify(metadata)}`,
  );

  const tx = await lucidInstance
    .newTx()
    .payToAddress(address, { lovelace: 1_500_000n })
    .attachMetadata(MATERIOS_ANCHOR_LABEL, metadata)
    .complete();
  const signed = await tx.sign().complete();
  const txHash = await signed.submit();

  console.log(`[cardano-l1] anchored root=${metadata.root.slice(0, 20)}... as tx ${txHash}`);
  return { txHash, label: MATERIOS_ANCHOR_LABEL };
}
