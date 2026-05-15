/**
 * @summary Compose the user-facing URLs that close the loop on "first trace".
 *
 * The DX requirement (#175) is: after submission, the SDK MUST print a URL
 * the developer can click and see something. Materios doesn't yet ship a
 * native trace-detail explorer page, so we compose three known-good URLs:
 *
 *   1. `blobStatus`     — `${gateway}/blobs/<contentHash>/status` — gateway-
 *                          side status of the receipt (HTTP 200 + JSON,
 *                          browser-renderable).
 *   2. `explorer`       — Polkadot.js apps explorer pre-pointed at the
 *                          submission block. Shows the on-chain extrinsic
 *                          with full SCALE-decoded args.
 *   3. `chainInfo`      — `${gateway}/chain-info` — JSON with the live
 *                          genesis hash + best block, useful as a sanity
 *                          check that the gateway is the chain you think
 *                          it is.
 *   4. `gatewayHealth`  — `${gateway}/health` — cluster-health summary
 *                          (cert-daemon, anchor-worker, storage usage).
 *
 * A follow-up will replace `explorer` with a first-party
 * `https://materios.fluxpointstudios.com/trace/<contentHash>` page (filed
 * separately) — at which point the field swaps and the rest of the SDK
 * surface keeps working.
 */

export interface BuildExplorerUrlsInput {
  /**
   * Hex content hash, with or without `0x` prefix. Used to build the
   * gateway status URL.
   */
  contentHash: string;
  /**
   * Hex block hash from the on-chain submission, with or without `0x`.
   * Used to build the Polkadot.js apps query URL.
   */
  blockHash: string;
  /**
   * Gateway base URL. Accepts either `https://host` or `https://host/blobs`
   * — the function normalises so callers don't have to remember which
   * variant the env exports.
   */
  gatewayBaseUrl: string;
  /**
   * Substrate websocket RPC URL. Used to build the Polkadot.js apps
   * pre-pointed-at-this-chain URL.
   */
  rpcUrl: string;
}

export interface ExplorerUrls {
  /** Gateway blob status JSON. */
  blobStatus: string;
  /** Polkadot.js apps pre-pointed at this chain's submission block. */
  explorer: string;
  /** Gateway chain-info endpoint (genesis + best block). */
  chainInfo: string;
  /** Gateway top-level health roll-up. */
  gatewayHealth: string;
}

/**
 * Strip an optional `0x` prefix from a hex string. Returns the cleaned
 * hex if present, otherwise the original string unchanged.
 */
function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * Normalise the gateway base URL.
 *
 * The blob-gateway's express routes are mounted at `/blobs/:contentHash/...`,
 * and the gateway is exposed both directly AND via an nginx reverse-proxy
 * that also prefixes `/blobs`. In production, the SDK is configured with
 * `baseUrl="https://host/blobs"`, and constructs upload URLs like
 * `${baseUrl}/blobs/<hash>/manifest` — i.e. the **upload path keeps both
 * "/blobs" segments**. To produce a working *human-facing* status URL
 * here, we must preserve the same shape.
 *
 * Accepts:
 *   - `https://host`        — `originBase = host`
 *   - `https://host/blobs`  — `originBase = host` (the /blobs is the
 *                              nginx prefix; we keep it for blob URLs but
 *                              strip it for the top-level /chain-info,
 *                              /health endpoints which mount on the
 *                              gateway's root express app, not the blobs
 *                              router).
 *
 * Returns both the normalised forms callers need:
 *   - `blobsBase`   the URL prefix the SDK already uses for /blobs/<h>/...
 *                   uploads. Status URLs share this prefix.
 *   - `rootBase`    the bare origin for /chain-info, /health.
 */
function normaliseGatewayBase(base: string): { blobsBase: string; rootBase: string } {
  let s = base.trim();
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (s.endsWith("/blobs")) {
    const rootBase = s.slice(0, -"/blobs".length);
    return { blobsBase: s, rootBase };
  }
  // No /blobs in baseUrl — assume nginx mounts gateway at the root.
  // Blob URLs and root URLs share the same origin.
  return { blobsBase: s, rootBase: s };
}

export function buildExplorerUrls(input: BuildExplorerUrlsInput): ExplorerUrls {
  const contentHash = strip0x(input.contentHash);
  const blockHash = strip0x(input.blockHash);
  const { blobsBase, rootBase } = normaliseGatewayBase(input.gatewayBaseUrl);

  // Polkadot.js apps URL format:
  //   https://polkadot.js.org/apps/?rpc=<encoded-ws-url>#/explorer/query/<blockHash>
  // The leading `?rpc=` lives BEFORE the hash because the apps router
  // reads the query string ahead of the hash route.
  const encodedRpc = encodeURIComponent(input.rpcUrl);
  const explorer = `https://polkadot.js.org/apps/?rpc=${encodedRpc}#/explorer/query/0x${blockHash}`;

  // Match the upload-side path shape: ${blobsBase}/blobs/<hash>/...
  // (The SDK's `uploadBlobs()` does `${baseUrl}/blobs/<hash>/manifest`.)
  return {
    blobStatus: `${blobsBase}/blobs/${contentHash}/status`,
    explorer,
    chainInfo: `${rootBase}/chain-info`,
    gatewayHealth: `${rootBase}/health`,
  };
}
