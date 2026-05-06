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
 * Deterministically synthesize an anchorId from (rootHash, manifestHash).
 *
 * Pre-image: rootHash raw bytes ++ manifestHash raw bytes (each parsed from
 * its hex representation, any leading 0x stripped). SHA-256 over those raw
 * bytes, 0x-prefixed digest hex.
 *
 * MUST stay byte-identical to the cert-daemon implementation in
 * `daemon/checkpoint.py::compute_anchor_id`. The gateway's
 * `/batches/:anchorId` reverse-lookup index is keyed on the same id, so a
 * drift between daemon and worker would silently leak 404s for every anchor
 * the cert-daemon didn't pre-compute the id for. Pinned by:
 *   - tests/anchor-id.test.ts (TS side)
 *   - tests/test_checkpoint_anchor_id.py (Python side)
 *
 * Exported so tests can pin the algorithm directly.
 */
export function deriveAnchorId(rootHashHex: string, manifestHashHex: string): string {
  const root = rootHashHex.replace(/^0[xX]/, "");
  const manifest = manifestHashHex.replace(/^0[xX]/, "");
  return "0x" + sha256Hex(root + manifest);
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

  // Anchor-id contract (task #117): if the caller supplied one, preserve it
  // verbatim — it's what the cert-daemon will use to PUT the leaf-list to
  // the blob gateway, and what external auditors will look up. If absent
  // (back-compat path), derive deterministically using the SAME algorithm
  // the daemon uses (`deriveAnchorId`), so an upgrade migration where one
  // side runs new-code and the other old-code still converges on the same
  // id. A daemon-supplied id that disagrees with our derivation is logged
  // (would indicate algorithm drift — should never happen in steady state).
  const derived = deriveAnchorId(rootHashHex, manifestHashHex);
  let anchorId: string;
  if (req.anchorId) {
    anchorId = ensureHexPrefix(req.anchorId);
    if (anchorId.toLowerCase() !== derived.toLowerCase()) {
      console.warn(
        `[materios-anchor] anchorId drift: caller=${anchorId} derived=${derived} ` +
          `— preserving caller's value. Investigate algorithm divergence.`,
      );
    }
  } else {
    anchorId = derived;
  }

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
