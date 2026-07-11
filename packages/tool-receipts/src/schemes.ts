/**
 * @fileoverview Signature-scheme verifiers for tool-call receipts (issue #60).
 *
 * Each verifier checks that `receipt.signature` is a valid signature over
 * `receipt.signedPayload` for `receipt.signer`, per its scheme:
 *
 * - `http-message-signatures` — RFC 9421 (signature base provided as signedPayload)
 * - `stripe-webhook` — Stripe `Stripe-Signature` HMAC-SHA256
 * - `github-webhook` — GitHub `X-Hub-Signature-256` HMAC-SHA256
 * - `jws` — compact JWS / JWT (HS*, RS*, PS*, ES*, EdDSA)
 *
 * Symmetric secrets (webhooks, HS*) MUST be supplied out-of-band via the
 * {@link ToolReceiptVerifyContext} — never embedded in the trace. Asymmetric
 * *public* keys may be embedded in `receipt.params.publicKey`.
 */

import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { ToolReceiptEvent } from "@fluxpointstudios/orynq-sdk-process-trace";
import { sha256StringHex } from "@fluxpointstudios/orynq-sdk-core/utils";

type MaybePromise<T> = T | Promise<T>;

/** Key/secret resolution + policy context for receipt verification. */
export interface ToolReceiptVerifyContext {
  /** Verification keys/secrets keyed by `receipt.signer`. */
  keys?: Record<string, string>;
  /** Dynamic key/secret resolver (takes precedence over `keys`). */
  resolveKey?: (event: ToolReceiptEvent) => MaybePromise<string | Uint8Array | undefined>;
  /** Max age (seconds) for replay-protected schemes (Stripe). Default 300. */
  toleranceSec?: number;
  /** Epoch-seconds clock override (testing). */
  nowSec?: number;
  /**
   * Accept a public key embedded in `receipt.params.publicKey` when no
   * out-of-band key is configured. This is a CONVENIENCE for internal
   * consistency checks only — it is NOT an authenticity guarantee, because the
   * trace (and therefore the embedded key) is attacker-controlled. Default
   * false; supply the signer's key via `keys`/`resolveKey` for a trustworthy
   * verdict.
   */
  trustEmbeddedKeys?: boolean;
}

const textEncoder = new TextEncoder();

function utf8(s: string): Buffer {
  return Buffer.from(textEncoder.encode(s));
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.toLowerCase(), "hex");
  const bb = Buffer.from(b.toLowerCase(), "hex");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

async function resolveKey(
  event: ToolReceiptEvent,
  ctx: ToolReceiptVerifyContext | undefined,
  { allowEmbedded }: { allowEmbedded: boolean }
): Promise<string | Uint8Array | undefined> {
  if (ctx?.resolveKey) {
    const k = await ctx.resolveKey(event);
    if (k !== undefined) return k;
  }
  if (ctx?.keys && Object.prototype.hasOwnProperty.call(ctx.keys, event.receipt.signer)) {
    return ctx.keys[event.receipt.signer];
  }
  // An embedded public key lives in the untrusted trace, so it is NOT trusted
  // for a passing verdict unless the caller explicitly opts in. Prefer an
  // out-of-band key via keys/resolveKey.
  if (allowEmbedded && ctx?.trustEmbeddedKeys === true) {
    const p = event.receipt.params;
    if (p && typeof p.publicKey === "string") return p.publicKey;
  }
  return undefined;
}

function keyToString(key: string | Uint8Array): string {
  return typeof key === "string" ? key : Buffer.from(key).toString("utf8");
}

// =============================================================================
// Stripe webhook (HMAC-SHA256 over `${t}.${payload}`)
// =============================================================================

/** Parse a `t=...,v1=...` Stripe-Signature header (or fall back to a bare hex sig). */
function parseStripeSignature(
  raw: string,
  params: Record<string, unknown> | undefined
): { t?: string; v1: string[] } {
  if (raw.includes("v1=") || raw.includes("t=")) {
    const parts = raw.split(",").map((p) => p.trim());
    let t: string | undefined;
    const v1: string[] = [];
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (k === "t") t = v;
      else if (k === "v1") v1.push(v);
    }
    return t !== undefined ? { t, v1 } : { v1 };
  }
  // Bare signature: timestamp must come from params.
  const t = typeof params?.timestamp === "string" ? (params.timestamp as string) : undefined;
  return t !== undefined ? { t, v1: [raw] } : { v1: [raw] };
}

export async function verifyStripeReceipt(
  event: ToolReceiptEvent,
  ctx?: ToolReceiptVerifyContext
): Promise<boolean> {
  const secret = await resolveKey(event, ctx, { allowEmbedded: false });
  if (secret === undefined) {
    throw new Error(
      "stripe-webhook: signing secret not found — provide it via verify context (keys/resolveKey), not the trace"
    );
  }
  const { t, v1 } = parseStripeSignature(event.receipt.signature, event.receipt.params);
  if (t === undefined) throw new Error("stripe-webhook: missing timestamp (t)");
  if (v1.length === 0) throw new Error("stripe-webhook: missing v1 signature");

  const toleranceSec = ctx?.toleranceSec ?? 300;
  const now = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const ts = Number(t);
  if (!Number.isFinite(ts)) throw new Error("stripe-webhook: invalid timestamp");
  if (Math.abs(now - ts) > toleranceSec) {
    throw new Error(`stripe-webhook: timestamp outside tolerance (${toleranceSec}s)`);
  }

  const signedBase = `${t}.${event.receipt.signedPayload}`;
  const expected = createHmac("sha256", keyToString(secret)).update(signedBase).digest("hex");
  return v1.some((candidate) => constantTimeEqualHex(expected, candidate));
}

// =============================================================================
// GitHub webhook (HMAC-SHA256, `sha256=...`)
// =============================================================================

export async function verifyGitHubReceipt(
  event: ToolReceiptEvent,
  ctx?: ToolReceiptVerifyContext
): Promise<boolean> {
  const secret = await resolveKey(event, ctx, { allowEmbedded: false });
  if (secret === undefined) {
    throw new Error(
      "github-webhook: signing secret not found — provide it via verify context (keys/resolveKey)"
    );
  }
  const provided = event.receipt.signature.startsWith("sha256=")
    ? event.receipt.signature.slice("sha256=".length)
    : event.receipt.signature;
  const expected = createHmac("sha256", keyToString(secret))
    .update(event.receipt.signedPayload)
    .digest("hex");
  return constantTimeEqualHex(expected, provided);
}

// =============================================================================
// JWS / JWT (compact)
// =============================================================================

interface JwsParts {
  signingInput: string;
  signature: Buffer;
  header: { alg?: string; [k: string]: unknown };
}

function parseJws(event: ToolReceiptEvent): JwsParts {
  const sp = event.receipt.signedPayload;
  const segments = sp.split(".");
  let signingInput: string;
  let sigB64: string;
  if (segments.length === 3) {
    // signedPayload is the full compact JWS.
    signingInput = `${segments[0]}.${segments[1]}`;
    sigB64 = segments[2]!;
  } else if (segments.length === 2) {
    // signedPayload is the signing input; signature carried separately.
    signingInput = sp;
    sigB64 = event.receipt.signature;
  } else {
    throw new Error("jws: signedPayload must be a compact JWS (h.p.s) or signing input (h.p)");
  }
  const headerJson = Buffer.from(segments[0]!, "base64url").toString("utf8");
  const header = JSON.parse(headerJson) as { alg?: string };
  return { signingInput, signature: Buffer.from(sigB64, "base64url"), header };
}

export async function verifyJwsReceipt(
  event: ToolReceiptEvent,
  ctx?: ToolReceiptVerifyContext
): Promise<boolean> {
  const { signingInput, signature, header } = parseJws(event);
  const alg = header.alg;
  if (!alg || alg === "none") throw new Error(`jws: unsupported alg "${alg}"`);
  const data = utf8(signingInput);

  if (alg.startsWith("HS")) {
    const secret = await resolveKey(event, ctx, { allowEmbedded: false });
    if (secret === undefined) throw new Error(`jws(${alg}): HMAC secret not found in verify context`);
    const hashAlg = `sha${alg.slice(2)}`;
    const expected = createHmac(hashAlg, keyToString(secret)).update(data).digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  }

  // Asymmetric — public key may be embedded.
  const keyMaterial = await resolveKey(event, ctx, { allowEmbedded: true });
  if (keyMaterial === undefined) throw new Error(`jws(${alg}): public key not found`);
  const publicKey = toPublicKey(keyMaterial);

  if (alg.startsWith("RS")) {
    return cryptoVerify(`sha${alg.slice(2)}`, data, publicKey, signature);
  }
  if (alg.startsWith("PS")) {
    const bits = alg.slice(2);
    return cryptoVerify(
      `sha${bits}`,
      data,
      { key: publicKey, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: Number(bits) / 8 },
      signature
    );
  }
  if (alg.startsWith("ES")) {
    // JWS ECDSA signatures are raw r||s (IEEE-P1363).
    return cryptoVerify(
      `sha${alg.slice(2)}`,
      data,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature
    );
  }
  if (alg === "EdDSA") {
    return cryptoVerify(null, data, publicKey, signature);
  }
  throw new Error(`jws: unsupported alg "${alg}"`);
}

// =============================================================================
// RFC 9421 — HTTP Message Signatures
// =============================================================================

/** RFC 9421 algorithm registry names we support. */
const RFC9421_HASH: Record<string, string> = {
  "rsa-pss-sha512": "sha512",
  "rsa-v1_5-sha256": "sha256",
  "ecdsa-p256-sha256": "sha256",
  "ecdsa-p384-sha384": "sha384",
};

export async function verifyHttpMessageReceipt(
  event: ToolReceiptEvent,
  ctx?: ToolReceiptVerifyContext
): Promise<boolean> {
  const params = event.receipt.params ?? {};
  const alg = typeof params.alg === "string" ? (params.alg as string) : undefined;
  if (!alg) {
    throw new Error("http-message-signatures: receipt.params.alg is required (RFC 9421 alg id)");
  }
  // The signature base is the canonical signed bytes.
  const data = utf8(event.receipt.signedPayload);
  const signature = decodeSignature(event.receipt.signature);

  if (alg === "ed25519") {
    const keyMaterial = await resolveKey(event, ctx, { allowEmbedded: true });
    if (keyMaterial === undefined) throw new Error("http-message-signatures(ed25519): public key not found");
    return cryptoVerify(null, data, toPublicKey(keyMaterial), signature);
  }

  if (alg === "hmac-sha256") {
    const secret = await resolveKey(event, ctx, { allowEmbedded: false });
    if (secret === undefined) throw new Error("http-message-signatures(hmac-sha256): secret not found");
    const expected = createHmac("sha256", keyToString(secret)).update(data).digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  }

  const hash = RFC9421_HASH[alg];
  if (!hash) throw new Error(`http-message-signatures: unsupported alg "${alg}"`);
  const keyMaterial = await resolveKey(event, ctx, { allowEmbedded: true });
  if (keyMaterial === undefined) throw new Error(`http-message-signatures(${alg}): public key not found`);
  const publicKey = toPublicKey(keyMaterial);

  if (alg === "rsa-pss-sha512") {
    return cryptoVerify(hash, data, { key: publicKey, padding: 6, saltLength: 64 }, signature);
  }
  if (alg === "rsa-v1_5-sha256") {
    return cryptoVerify(hash, data, publicKey, signature);
  }
  // ECDSA — RFC 9421 uses raw (IEEE-P1363) signatures.
  return cryptoVerify(hash, data, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
}

// =============================================================================
// Helpers
// =============================================================================

function toPublicKey(material: string | Uint8Array): KeyObject {
  if (typeof material === "string") {
    const trimmed = material.trim();
    if (trimmed.startsWith("{")) {
      return createPublicKey({ key: JSON.parse(trimmed), format: "jwk" });
    }
    return createPublicKey(material);
  }
  return createPublicKey(Buffer.from(material));
}

/**
 * Decode a signature string that may be 0x-hex, base64url, or standard base64
 * (the encodings used by RFC 9421 / JWS receipts in the wild).
 */
function decodeSignature(sig: string): Buffer {
  if (sig.startsWith("0x")) return Buffer.from(sig.slice(2), "hex");
  if (/[-_]/.test(sig)) return Buffer.from(sig, "base64url");
  return Buffer.from(sig, "base64");
}

// =============================================================================
// Response binding — the signed content must commit to the recorded response
// =============================================================================

/**
 * The sha-256 hex the signed material commits to, or `null` when the scheme's
 * signed bytes structurally cannot bind the response (e.g. an RFC 9421
 * signature base with no `content-digest` component). A `null` MUST cause
 * verification to fail: a valid signature that does not cover the recorded
 * response proves nothing about it.
 */
export async function responseCommitmentHash(event: ToolReceiptEvent): Promise<string | null> {
  const { scheme, signedPayload } = event.receipt;
  switch (scheme) {
    case "jws": {
      // signedPayload is the JWS signing input `h.p[.s]`; the payload segment
      // is the exact bytes the tool signed (canonical response body).
      const segs = signedPayload.split(".");
      if (segs.length < 2 || !segs[1]) return null;
      const body = Buffer.from(segs[1], "base64url").toString("utf8");
      return sha256StringHex(body);
    }
    case "stripe-webhook":
    case "github-webhook":
      // The signed webhook body IS the tool response.
      return sha256StringHex(signedPayload);
    case "http-message-signatures":
      // RFC 9421 signs a signature base, not the body; the body is bound only
      // via a `content-digest` component inside that base.
      return contentDigestSha256Hex(signedPayload);
    default:
      return null;
  }
}

/** Extract the sha-256 content-digest (hex) from an RFC 9421 signature base. */
function contentDigestSha256Hex(signatureBase: string): string | null {
  for (const line of signatureBase.split("\n")) {
    const m = /^"content-digest":\s*(.+)$/i.exec(line.trim());
    if (!m) continue;
    const d = /sha-256=:([A-Za-z0-9+/=]+):/.exec(m[1]!);
    if (!d || !d[1]) return null;
    return Buffer.from(d[1], "base64").toString("hex");
  }
  return null;
}
