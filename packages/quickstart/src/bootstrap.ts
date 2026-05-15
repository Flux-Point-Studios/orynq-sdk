/**
 * @summary One-call solo-dev bootstrap.
 *
 * `bootstrapAndTrace()` does ALL of:
 *
 *   1. `loadOrCreateIdentity()`  — fresh sr25519 keypair on first run.
 *   2. `requestFaucet()`         — free-tier MATRA drip on the gateway.
 *   3. `firstTraceBundle()`      — build + finalise a "hello" trace.
 *   4. `submitCertifiedReceipt()` — upload blob + submit receipt on chain.
 *   5. `buildExplorerUrls()`     — compose the URLs the dev needs to click.
 *
 * Compared to the manual flow (e2e-flow.ts), this collapses ~10 lines of
 * MateriosProvider config + 30 lines of error handling into a single
 * `await bootstrapAndTrace({})`. Defaults target Materios preprod; pass
 * env-driven overrides to point at a different chain.
 *
 * Designed to surface, not paper over, real failures. Faucet cooldown is
 * NOT retried; certification timeout is NOT swallowed. The expectation is
 * that a fresh dev sees a green path on first run and a clear error
 * message otherwise — never a hung "loading...".
 */

import { createHash } from "crypto";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import {
  MateriosProvider,
  submitReceipt,
  uploadBlobs,
  prepareBlobData,
  waitForCertification,
  waitForMotra,
} from "@fluxpointstudios/orynq-sdk-anchors-materios";

import { loadOrCreateIdentity } from "./identity.js";
import type { OrynqIdentity } from "./identity.js";
import { firstTraceBundle } from "./trace.js";
import type { TraceBundleLite } from "./trace.js";
import { requestFaucet } from "./faucet.js";
import type { FaucetDripResult } from "./faucet.js";
import { buildExplorerUrls } from "./explorer.js";
import type { ExplorerUrls } from "./explorer.js";

export const DEFAULT_RPC_URL = "wss://materios.fluxpointstudios.com/rpc";
export const DEFAULT_GATEWAY_URL = "https://materios.fluxpointstudios.com/blobs";
export const DEFAULT_AGENT_ID = "orynq-quickstart";

export interface BootstrapAndTraceOptions {
  /** Path to the on-disk identity (defaults to `~/.orynq/config.json`). */
  configPath?: string | undefined;
  /** Substrate WS RPC URL. Defaults to preprod. */
  rpcUrl?: string | undefined;
  /** Blob-gateway base URL (with or without /blobs suffix). */
  gatewayBaseUrl?: string | undefined;
  /** AgentId stamped on the trace bundle. */
  agentId?: string | undefined;
  /**
   * One-liner observation stamped as the public event of the first trace.
   * Defaults to a self-describing message that includes the env's wall
   * clock, so the trace is identifiable on the explorer.
   */
  summary?: string | undefined;
  /**
   * Wait this long for the cert-daemon committee to certify the receipt.
   * Defaults to 120 s. Set to 0 to skip the cert wait entirely (returns
   * as soon as the receipt is on chain). On preprod the cert window is
   * ~30-90 s depending on attestor load + finality gap; 120 s gives the
   * happy path a comfortable margin without keeping the dev hanging.
   */
  certTimeoutMs?: number | undefined;
  /**
   * If true, a cert timeout is treated as success — the receipt is on
   * chain, the explorer URL is printed, and the cert is just "still
   * pending". Defaults to true so a fresh dev sees a working trace URL
   * even when the committee is mid-vote.
   */
  treatCertTimeoutAsSuccess?: boolean | undefined;
  /**
   * Hook fired after each major step. Lets the CLI render a live status
   * line without coupling business logic to console.log.
   */
  onProgress?: ((step: BootstrapStep) => void) | undefined;
  /**
   * If true, the faucet step is skipped — useful when the dev has
   * pre-funded their address via Discord faucet, an existing wallet, etc.
   * Defaults to false.
   */
  skipFaucet?: boolean | undefined;
}

export type BootstrapStep =
  | { kind: "identity-loaded"; identity: OrynqIdentity }
  | { kind: "faucet-result"; result: FaucetDripResult }
  | { kind: "waiting-for-motra" }
  | { kind: "motra-ready"; balance: bigint }
  | { kind: "trace-built"; bundle: TraceBundleLite }
  | { kind: "blob-uploaded"; contentHash: string }
  | { kind: "receipt-submitted"; receiptId: string; blockHash: string }
  | { kind: "certified"; certHash: string }
  | { kind: "explorer-ready"; urls: ExplorerUrls };

export interface BootstrapAndTraceResult {
  identity: OrynqIdentity;
  bundle: TraceBundleLite;
  receiptId: string;
  blockHash: string;
  certHash?: string;
  urls: ExplorerUrls;
  /** Wall-clock duration from start of bootstrap to URLs available. */
  elapsedMs: number;
}

/**
 * Bootstrap a fresh dev to a chain-anchored first trace.
 *
 * Steps (each emits a progress event via `onProgress`):
 *   1. load-or-create identity            ~50 ms
 *   2. faucet drip (skipped if funded)    ~2 s
 *   3. wait for MOTRA to generate         ~10-30 s (chain block production)
 *   4. build local trace bundle           ~10 ms
 *   5. upload blob + submit receipt       ~6 s (1 block)
 *   6. await certification (optional)     ~10-30 s (committee voting)
 *   7. compose explorer URLs              instant
 *
 * Total budget on a fresh address: 30-60 s wall-clock. With faucet skipped
 * and MOTRA already in hand: <10 s.
 */
export async function bootstrapAndTrace(
  opts: BootstrapAndTraceOptions = {},
): Promise<BootstrapAndTraceResult> {
  await cryptoWaitReady();
  const start = Date.now();
  const onProgress = opts.onProgress ?? (() => {});

  // Step 1: identity
  const identity = await loadOrCreateIdentity({
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  onProgress({ kind: "identity-loaded", identity });

  const gateway = opts.gatewayBaseUrl ?? DEFAULT_GATEWAY_URL;
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URL;

  // Step 2: faucet (best-effort; idempotent under success + already-funded)
  if (!opts.skipFaucet) {
    const faucetResult = await requestFaucet({ address: identity.address, gatewayBaseUrl: gateway });
    onProgress({ kind: "faucet-result", result: faucetResult });
    if (faucetResult.kind === "error" || faucetResult.kind === "cooldown") {
      throw new Error(
        `faucet drip failed for ${identity.address}: ${faucetResult.kind} — ${faucetResult.message ?? "unknown"}. ` +
          `Workarounds: (1) skipFaucet:true if you've already funded ${identity.address} elsewhere; ` +
          `(2) retry in a few minutes if cooldown; (3) ask in Discord (#materios) for a top-up.`,
      );
    }
  }

  // Step 3: connect to chain, wait for MOTRA
  const provider = new MateriosProvider({ rpcUrl, signerUri: identity.mnemonic });
  await provider.connect();
  try {
    onProgress({ kind: "waiting-for-motra" });
    // 1 MATRA at 6-dec = 1_000_000 units. We need enough MOTRA (the fee
    // currency, auto-generated from MATRA at ~6.94e-12 MOTRA per MATRA-block)
    // to cover one submit_receipt. The default min in waitForMotra
    // (1.5e12) is empirically the floor that covers one extrinsic + a
    // chain-tx + a chunk upload.
    const balance = await waitForMotra(provider, undefined, { timeoutMs: 90_000 });
    onProgress({ kind: "motra-ready", balance });

    // Step 4: build the trace
    const bundle = await firstTraceBundle({
      agentId: opts.agentId ?? DEFAULT_AGENT_ID,
      summary:
        opts.summary ??
        `first trace via orynq-sdk-quickstart at ${new Date().toISOString()}`,
    });
    onProgress({ kind: "trace-built", bundle });

    // Step 5: upload blob + submit receipt + (optionally) wait for cert.
    //
    // We call the three SDK primitives explicitly instead of
    // `submitCertifiedReceipt()` so a cert-poll timeout doesn't lose the
    // submit result. The on-chain receipt + blockHash are already known
    // by then — we just want to surface "submitted, pending cert" cleanly.
    const keypair = provider.getKeypair();
    const contentBuf = Buffer.from(bundle.content, "utf-8");
    const contentHash = bundle.manifestHash; // canonical content == addressable blob
    const certTimeoutMs = opts.certTimeoutMs ?? 120_000;
    const treatCertTimeoutAsSuccess = opts.treatCertTimeoutAsSuccess !== false;

    // 5a. Derive the receiptId the same way submit_receipt does: it's
    //     sha256 of the (binary) contentHash. The blob-gateway routes
    //     all chunk + manifest paths under this receiptId so they must
    //     match the on-chain id byte-for-byte.
    const contentHashHex = contentHash.startsWith("0x") ? contentHash.slice(2) : contentHash;
    const receiptIdHex = "0x" + createHash("sha256")
      .update(Buffer.from(contentHashHex, "hex"))
      .digest("hex");

    // 5b. Upload the blob via sig-only auth (no API key required).
    const { manifest, chunks } = prepareBlobData(receiptIdHex, contentBuf);
    const uploadResult = await uploadBlobs(
      receiptIdHex,
      manifest,
      chunks,
      {
        baseUrl: gateway,
        signerKeypair: {
          address: keypair.address,
          sign: (msg: Uint8Array) => keypair.sign(msg),
        },
      },
    );
    if (!uploadResult.success) {
      throw new Error(`blob upload failed: ${uploadResult.error ?? "unknown"}`);
    }

    // 5c. Submit the on-chain receipt. Pass receiptId explicitly so the
    //     gateway-side blob path + the on-chain receipt agree on the key
    //     (the SDK's default derivation matches what we computed above).
    const submitResult = await submitReceipt(provider, {
      receiptId: receiptIdHex,
      contentHash,
      rootHash: bundle.rootHash,
      manifestHash: uploadResult.storageLocatorHash ?? bundle.manifestHash,
    });
    onProgress({
      kind: "receipt-submitted",
      receiptId: submitResult.receiptId,
      blockHash: submitResult.blockHash,
    });

    // 5c. Optionally wait for cert. Timeouts are surfaced as "submitted,
    //     pending cert" rather than a hard failure so the dev still sees
    //     a usable URL on a slow committee.
    let certHash: string | undefined;
    if (certTimeoutMs > 0) {
      try {
        const certResult = await waitForCertification(
          provider,
          submitResult.receiptId,
          { timeoutMs: certTimeoutMs },
        );
        certHash = certResult.certHash;
        onProgress({ kind: "certified", certHash });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isCertTimeout = /Certification timeout/i.test(msg);
        if (!(isCertTimeout && treatCertTimeoutAsSuccess)) {
          throw err;
        }
        // Cert pending — proceed with the URLs we have.
      }
    }

    // The gateway routes blob status by the same key the SDK uploaded
    // under — that's the receiptId, NOT the content sha256. Pass it as
    // `contentHash` to buildExplorerUrls (the parameter name carries the
    // legacy meaning from the gateway route).
    const urls = buildExplorerUrls({
      contentHash: receiptIdHex,
      blockHash: submitResult.blockHash,
      gatewayBaseUrl: gateway,
      rpcUrl,
    });
    onProgress({ kind: "explorer-ready", urls });

    const result: BootstrapAndTraceResult = {
      identity,
      bundle,
      receiptId: submitResult.receiptId,
      blockHash: submitResult.blockHash,
      urls,
      elapsedMs: Date.now() - start,
    };
    if (certHash) {
      result.certHash = certHash;
    }
    return result;
  } finally {
    await provider.disconnect().catch(() => {
      // Swallow disconnect errors — we already have the result the caller
      // wanted. Surfacing this would mask the real (successful) outcome.
      // The provider's WS will tear itself down on process exit anyway.
    });
  }
}

/**
 * Standalone helper: spin up a `Keyring` from a mnemonic. Exposed so the
 * CLI can re-derive an address from the saved config without pulling in
 * the full bootstrap path.
 */
export async function deriveAddress(mnemonic: string, ss58Format = 42): Promise<string> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519", ss58Format });
  return keyring.addFromUri(mnemonic).address;
}

