/**
 * HTTPS submit pipeline for signed ai_capability_observation_v1 records.
 *
 * Mirrors the Python `submit_observation` flow. The SDK:
 *   1. Recomputes content_hash locally.
 *   2. Signs the canonical CBOR pre-image with the observer's sr25519 key.
 *   3. POSTs to the Materios blob gateway.
 *   4. Refuses any server-substituted content_hash that doesn't match.
 */

import {
  type AiCapabilityObservationRecord,
  SCHEMA_HASH_HEX,
  SCHEMA_VERSION,
  canonicalCbor,
  canonicalContentHash,
} from "./canonical.js";
import { ObserverKeypair } from "./keypair.js";

export const DEFAULT_GATEWAY_URLS: Record<string, string> = {
  preprod: "https://materios.fluxpointstudios.com/preprod-blobs",
  mainnet: "https://materios.fluxpointstudios.com/mainnet-blobs",
};

const DEFAULT_TIMEOUT_SECONDS = 15.0;
const DEFAULT_RETRY_BACKOFF_SECONDS = 2.0;

export class SubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmitError";
  }
}

export class GatewayError extends Error {
  status: number;
  body: unknown;

  constructor(opts: { status: number; message: string; body?: unknown }) {
    super(`gateway HTTP ${opts.status}: ${opts.message}`);
    this.name = "GatewayError";
    this.status = opts.status;
    this.body = opts.body;
  }
}

export interface SubmissionReceiptInit {
  contentHash: string;
  gatewayStatus: number;
  acceptedAt: unknown;
  materiosTx?: string | null;
  cardanoAnchorTx?: string | null;
  observerSs58: string;
  body: Record<string, unknown>;
}

export class SubmissionReceipt {
  readonly contentHash: string;
  readonly gatewayStatus: number;
  readonly acceptedAt: unknown;
  materiosTx: string | null;
  cardanoAnchorTx: string | null;
  readonly observerSs58: string;
  body: Record<string, unknown>;

  constructor(init: SubmissionReceiptInit) {
    this.contentHash = init.contentHash;
    this.gatewayStatus = init.gatewayStatus;
    this.acceptedAt = init.acceptedAt;
    this.materiosTx = init.materiosTx ?? null;
    this.cardanoAnchorTx = init.cardanoAnchorTx ?? null;
    this.observerSs58 = init.observerSs58;
    this.body = init.body;
  }

  /** Python-style snake_case aliases for cross-language ergonomics. */
  get materios_tx(): string | null {
    return this.materiosTx;
  }
  get cardano_anchor_tx(): string | null {
    return this.cardanoAnchorTx;
  }
  get content_hash(): string {
    return this.contentHash;
  }
  get observer_ss58(): string {
    return this.observerSs58;
  }

  async refresh(opts: {
    gatewayUrl: string;
    apiKey?: string;
    timeoutSeconds?: number;
    /** Internal — injection point for tests. */
    fetchImpl?: typeof fetch;
  }): Promise<SubmissionReceipt> {
    const base = opts.gatewayUrl.replace(/\/+$/, "");
    const url = `${base}/receipts/${this.contentHash}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "orynq-observe-js/0.1.0",
    };
    if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`;
    const f = opts.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const timeout = setTimeout(
      () => ctrl.abort(),
      (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    );
    let r: Response;
    try {
      r = await f(url, { method: "GET", headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (r.status === 404) return this;
    if (!(r.status >= 200 && r.status < 300)) {
      const text = await r.text();
      throw new GatewayError({
        status: r.status,
        message: text.slice(0, 200),
        body: null,
      });
    }
    let body: Record<string, unknown>;
    try {
      body = (await r.json()) as Record<string, unknown>;
    } catch (e) {
      throw new SubmitError(
        `receipt lookup returned non-JSON body: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (body && typeof body === "object") {
      const mtx = body.materios_tx ?? body.materiosTx;
      const ctx = body.cardano_anchor_tx ?? body.cardanoAnchorTx;
      if (typeof mtx === "string") this.materiosTx = mtx;
      if (typeof ctx === "string") this.cardanoAnchorTx = ctx;
      this.body = body;
    }
    return this;
  }
}

export interface SubmitObservationOptions {
  record: AiCapabilityObservationRecord;
  keypair: ObserverKeypair;
  network?: "preprod" | "mainnet";
  gatewayUrl?: string;
  apiKey?: string;
  timeoutSeconds?: number;
  /** Internal — test injection point. */
  fetchImpl?: typeof fetch;
  /** Internal — retry backoff (seconds). 0 disables. */
  retryBackoffSeconds?: number;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += b[i].toString(16).padStart(2, "0");
  }
  return s;
}

async function postWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  retryBackoffSeconds: number,
  timeoutSeconds: number,
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1 && retryBackoffSeconds > 0) {
      await new Promise((res) => setTimeout(res, retryBackoffSeconds * 1000));
    }
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutSeconds * 1000);
    let r: Response;
    try {
      r = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      lastErr = e;
      clearTimeout(timeout);
      if (attempt === 1) {
        throw new SubmitError(
          `network error reaching gateway at ${url}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      continue;
    } finally {
      clearTimeout(timeout);
    }
    if (r.status >= 500 && r.status < 600) {
      if (attempt === 0) continue;
      return r;
    }
    return r;
  }
  throw new SubmitError(`unreachable retry exit; lastErr=${String(lastErr)}`);
}

function resolveGatewayUrl(
  network: string,
  override: string | undefined,
): string {
  if (override) return override;
  if (!(network in DEFAULT_GATEWAY_URLS)) {
    throw new SubmitError(
      `unknown network "${network}"; supply gatewayUrl= explicitly or use one of ${Object.keys(DEFAULT_GATEWAY_URLS).join(",")}`,
    );
  }
  return DEFAULT_GATEWAY_URLS[network];
}

export async function submitObservation(
  opts: SubmitObservationOptions,
): Promise<SubmissionReceipt> {
  if (!opts.apiKey) {
    throw new SubmitError(
      "apiKey is required — observation submission is sponsored. " +
        "Request a token from the gateway operator and pass apiKey=...",
    );
  }
  const network = opts.network ?? "preprod";
  const resolved = resolveGatewayUrl(network, opts.gatewayUrl);

  const expectedHash = canonicalContentHash(opts.record);
  const preimage = canonicalCbor(opts.record);
  const signature = opts.keypair.signBytes(preimage);

  const wire = {
    schema_version: SCHEMA_VERSION,
    schema_hash: SCHEMA_HASH_HEX,
    record: opts.record,
    content_hash: expectedHash,
    observer_pubkey: opts.keypair.publicHex,
    observer_signature: bytesToHex(signature),
  };

  const base = resolved.replace(/\/+$/, "");
  const url = `${base}/observations/submit`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.apiKey}`,
    "content-type": "application/json",
    "user-agent": "orynq-observe-js/0.1.0",
    "x-schema-version": SCHEMA_VERSION,
  };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const r = await postWithRetry(
    fetchImpl,
    url,
    headers,
    wire,
    opts.retryBackoffSeconds ?? DEFAULT_RETRY_BACKOFF_SECONDS,
    opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
  );

  if (!(r.status >= 200 && r.status < 300)) {
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      body = await r.text();
    }
    let errMsg: string | null = null;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (b.code && b.message) errMsg = `${b.code}: ${b.message}`;
      else if (b.error) errMsg = String(b.error);
      else if (b.message) errMsg = String(b.message);
    }
    if (!errMsg) errMsg = `HTTP ${r.status}`;
    throw new GatewayError({
      status: r.status,
      message: errMsg.slice(0, 500),
      body,
    });
  }

  let decoded: Record<string, unknown>;
  try {
    decoded = (await r.json()) as Record<string, unknown>;
  } catch (e) {
    throw new SubmitError(
      `gateway returned non-JSON 2xx body: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!decoded || typeof decoded !== "object") {
    throw new SubmitError("gateway 2xx body is not a JSON object");
  }
  const serverHash =
    (decoded.content_hash as string | undefined) ??
    (decoded.contentHash as string | undefined);
  if (typeof serverHash !== "string") {
    throw new SubmitError("gateway response missing content_hash");
  }
  if (serverHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new SubmitError(
      `gateway returned a content_hash that does not match the SDK-computed canonical digest (SDK=${expectedHash}, server=${serverHash}). Refusing to trust the response.`,
    );
  }

  return new SubmissionReceipt({
    contentHash: expectedHash,
    gatewayStatus: r.status,
    acceptedAt: decoded.accepted_at ?? decoded.acceptedAt ?? null,
    materiosTx:
      (decoded.materios_tx as string | undefined) ??
      (decoded.materiosTx as string | undefined) ??
      null,
    cardanoAnchorTx:
      (decoded.cardano_anchor_tx as string | undefined) ??
      (decoded.cardanoAnchorTx as string | undefined) ??
      null,
    observerSs58: opts.keypair.ss58Address,
    body: decoded,
  });
}
