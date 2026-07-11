/**
 * @fileoverview Signing-proxy helper — the "anti-lie" pattern (issue #60).
 *
 * Tools that do not sign their responses natively can be wrapped in a TEE/HSM-
 * signed envelope so the wrapper's claim ("the tool returned X") becomes
 * independently verifiable. This helper produces a JWS-signed
 * {@link ToolReceiptEvent.receipt} from a tool response; pair it with
 * `addToolReceipt` to record the receipt, and `verifyToolReceipts` to check it.
 *
 * @example
 * ```typescript
 * import { generateKeyPairSync } from "node:crypto";
 * const { privateKey, publicKey } = generateKeyPairSync("ed25519");
 * const proxy = createSigningProxy({
 *   signer: "tee://pricing-proxy",
 *   alg: "EdDSA",
 *   privateKey,
 *   publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
 * });
 * const receipt = proxy.sign({ price: 4200, currency: "usd" });
 * await addToolReceipt(run, span.id, { toolId, request, response, receipt });
 * ```
 */

import {
  createHmac,
  createPrivateKey,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import type { ToolReceiptEvent } from "@fluxpointstudios/orynq-sdk-process-trace";

/** JWS algorithms supported by the signing proxy. */
export type JwsAlg =
  | "EdDSA"
  | "ES256"
  | "ES384"
  | "RS256"
  | "RS512"
  | "PS256"
  | "PS512"
  | "HS256";

export interface SigningProxyOptions {
  /** Verifier-resolvable identity recorded as `receipt.signer` (URL / DID / keyId). */
  signer: string;
  alg: JwsAlg;
  /** Private key (PEM or KeyObject) for asymmetric algorithms. */
  privateKey?: string | KeyObject;
  /** Shared secret for HS256. */
  secret?: string;
  /**
   * Public key (PEM or JWK string) to embed in `receipt.params.publicKey` so a
   * verifier can resolve it without out-of-band material. Safe to embed
   * (public keys only).
   */
  publicKey?: string;
  /**
   * Call-binding context signed into the receipt header so a genuine receipt
   * cannot be lifted into a different trace/request. When set, the verifier
   * requires the enclosing trace's runId (and the recorded request hash) to
   * equal these signed values, marking the receipt `callBound`.
   */
  binding?: { runId: string; requestHash?: string };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function signJws(opts: SigningProxyOptions, signingInput: string): Buffer {
  const data = Buffer.from(signingInput, "utf8");

  if (opts.alg === "HS256") {
    if (!opts.secret) throw new Error("createSigningProxy(HS256): `secret` is required");
    return createHmac("sha256", opts.secret).update(data).digest();
  }

  if (!opts.privateKey) {
    throw new Error(`createSigningProxy(${opts.alg}): \`privateKey\` is required`);
  }
  const key =
    typeof opts.privateKey === "string" ? createPrivateKey(opts.privateKey) : opts.privateKey;

  if (opts.alg === "EdDSA") return cryptoSign(null, data, key);
  if (opts.alg.startsWith("ES")) {
    return cryptoSign(`sha${opts.alg.slice(2)}`, data, { key, dsaEncoding: "ieee-p1363" });
  }
  if (opts.alg.startsWith("PS")) {
    return cryptoSign(`sha${opts.alg.slice(2)}`, data, {
      key,
      padding: 6 /* RSA_PKCS1_PSS_PADDING */,
      saltLength: Number(opts.alg.slice(2)) / 8,
    });
  }
  if (opts.alg.startsWith("RS")) {
    return cryptoSign(`sha${opts.alg.slice(2)}`, data, key);
  }
  throw new Error(`createSigningProxy: unsupported alg "${opts.alg}"`);
}

export interface SigningProxy {
  /** Wrap a tool response in a JWS-signed receipt ready for `addToolReceipt`. */
  sign(payload: unknown): ToolReceiptEvent["receipt"];
}

/**
 * Create a signing proxy that turns unsigned tool responses into verifiable
 * JWS receipts. Use a TEE/HSM-held key in production.
 */
export function createSigningProxy(opts: SigningProxyOptions): SigningProxy {
  if (!opts.signer) throw new Error("createSigningProxy: `signer` is required");
  return {
    sign(payload: unknown): ToolReceiptEvent["receipt"] {
      // The call-binding lives in the (signed) header so the payload segment
      // stays the canonical response body the response-hash commitment covers.
      const header: Record<string, unknown> = { alg: opts.alg, typ: "JWT", kid: opts.signer };
      if (opts.binding) {
        header.orynqBinding = {
          runId: opts.binding.runId,
          ...(opts.binding.requestHash !== undefined
            ? { requestHash: opts.binding.requestHash }
            : {}),
        };
      }
      const h = b64url(JSON.stringify(header));
      const body = typeof payload === "string" ? payload : canonicalize(payload);
      const p = b64url(body);
      const signingInput = `${h}.${p}`;
      const sigB64 = b64url(signJws(opts, signingInput));
      return {
        // signedPayload is the JWS *signing input* (the bytes actually signed);
        // the signature is carried separately so it is independently checkable.
        scheme: "jws",
        signer: opts.signer,
        signature: sigB64,
        signedPayload: signingInput,
        ...(opts.publicKey ? { params: { publicKey: opts.publicKey } } : {}),
      };
    },
  };
}
