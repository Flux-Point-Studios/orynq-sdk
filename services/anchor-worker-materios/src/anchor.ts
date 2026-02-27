/**
 * Anchor submission logic for Materios blockchain.
 *
 * Submits anchors via OrinqReceipts.submit_anchor extrinsic.
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import type { KeyringPair } from "@polkadot/keyring/types";
import { createHash } from "crypto";
import { MATERIOS_RPC_URL, SIGNER_URI, TX_TIMEOUT } from "./config.js";

let apiInstance: ApiPromise | null = null;
let keypairInstance: KeyringPair | null = null;

/**
 * Get or create API + keypair singleton.
 */
export async function getApi(): Promise<{ api: ApiPromise; keypair: KeyringPair }> {
  if (apiInstance && keypairInstance) {
    return { api: apiInstance, keypair: keypairInstance };
  }

  const provider = new WsProvider(MATERIOS_RPC_URL);
  apiInstance = await ApiPromise.create({ provider });
  const keyring = new Keyring({ type: "sr25519" });
  keypairInstance = keyring.addFromUri(SIGNER_URI);

  return { api: apiInstance, keypair: keypairInstance };
}

export interface AnchorRequest {
  anchorId?: string;
  contentHash: string;
  rootHash: string;
  manifestHash: string;
}

export interface AnchorResult {
  blockHash: string;
  anchorId: string;
  contentHash: string;
  rootHash: string;
  manifestHash: string;
}

function sha256Hex(hex: string): string {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  return createHash("sha256").update(bytes).digest("hex");
}

function ensureHexPrefix(s: string): string {
  if (s.startsWith("sha256:")) s = s.slice(7);
  if (s.startsWith("0x") || s.startsWith("0X")) return s;
  return "0x" + s;
}

/**
 * Submit an anchor to the Materios chain.
 *
 * Idempotent: if the anchor already exists on-chain, returns success
 * without submitting a new transaction.
 */
export async function submitAnchor(req: AnchorRequest): Promise<AnchorResult> {
  const { api, keypair } = await getApi();

  const rootHashHex = ensureHexPrefix(req.rootHash);
  const manifestHashHex = ensureHexPrefix(req.manifestHash);
  const contentHashHex = ensureHexPrefix(req.contentHash);

  // Compute anchor ID if not provided
  const anchorId = req.anchorId
    ? ensureHexPrefix(req.anchorId)
    : "0x" + sha256Hex(rootHashHex.slice(2) + manifestHashHex.slice(2));

  // Idempotency check: if anchor already exists on-chain, return success
  const existing = await api.query.orinqReceipts.anchors(anchorId);
  if (existing && !existing.isEmpty) {
    console.log(`[materios-anchor] Anchor ${anchorId} already exists on-chain — returning success`);
    return {
      blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      anchorId,
      contentHash: contentHashHex,
      rootHash: req.rootHash,
      manifestHash: req.manifestHash,
    };
  }

  const tx = api.tx.orinqReceipts.submitAnchor(
    anchorId,
    contentHashHex,
    rootHashHex,
    manifestHashHex,
  );

  return new Promise<AnchorResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Anchor submission timed out after ${TX_TIMEOUT}ms`));
    }, TX_TIMEOUT);

    tx.signAndSend(keypair, ({ status, dispatchError }) => {
      if (dispatchError) {
        clearTimeout(timeout);
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          // Treat AnchorAlreadyExists as success (race condition)
          if (decoded.name === "AnchorAlreadyExists") {
            resolve({
              blockHash: status.isInBlock ? status.asInBlock.toHex() : "0x",
              anchorId,
              contentHash: contentHashHex,
              rootHash: req.rootHash,
              manifestHash: req.manifestHash,
            });
            return;
          }
          reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`));
        } else {
          reject(new Error(dispatchError.toString()));
        }
        return;
      }
      if (status.isInBlock) {
        clearTimeout(timeout);
        resolve({
          blockHash: status.asInBlock.toHex(),
          anchorId,
          contentHash: contentHashHex,
          rootHash: req.rootHash,
          manifestHash: req.manifestHash,
        });
      }
    }).catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
