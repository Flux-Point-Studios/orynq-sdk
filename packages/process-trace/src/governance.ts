/**
 * @fileoverview Governance attestations (issue #58).
 *
 * Location: packages/process-trace/src/governance.ts
 *
 * A `governance-attestation` event records a verifiable, role-scoped sign-off
 * inside a trace (compliance review, release approval, data-steward sign-off),
 * so an auditor can answer "who governed this decision?" without trusting the
 * wrapper that recorded it.
 *
 * Signing model:
 * - The signature covers a canonical, domain-separated preimage of
 *   `(role || policyRef || decisionRef || signedAt)` — see
 *   {@link governanceAttestationPreimage}.
 * - `sr25519` and `ed25519` are verified in-package via the OPTIONAL peer
 *   dependencies `@polkadot/util-crypto` + `@polkadot/util` (loaded with a
 *   dynamic `import()` so base installs stay lean).
 * - `eip712` is verified via a pluggable {@link GovernanceVerifier} so this
 *   package never needs a hard dependency on viem. See
 *   {@link createEip712GovernanceVerifier}.
 *
 * @example
 * ```typescript
 * const signer = await createSr25519GovernanceSigner({ seed: "0x" + "11".repeat(32) });
 * await addGovernanceAttestation(run, span.id, {
 *   role: "compliance",
 *   policyRef: "sha256:...",
 *   decisionRef: eventId,
 *   signer,
 * });
 * // ...later, during audit:
 * const summary = await verifyGovernanceAttestations(bundle);
 * // [{ role: "compliance", attestor: "5...", scheme: "sr25519", verified: true }]
 * ```
 */

import type {
  TraceRun,
  TraceEvent,
  TraceBundle,
  Visibility,
  GovernanceAttestationEvent,
  GovernanceSignatureScheme,
  GovernanceEip712Binding,
} from "./types.js";
import { HASH_DOMAIN_PREFIXES } from "./types.js";
import { addEvent } from "./trace-builder.js";

// =============================================================================
// PREIMAGE
// =============================================================================

/** The fields that are bound by a governance signature. */
export interface GovernanceAttestationFields {
  role: string;
  policyRef: string;
  decisionRef: string;
  signedAt: string;
}

/**
 * Build the canonical, domain-separated preimage signed by sr25519/ed25519
 * governance signers. Deterministic — a verifier reconstructs identical bytes
 * from the recorded event fields.
 *
 * Layout: `"poi-trace:governance:v1|" + role "\n" policyRef "\n" decisionRef "\n" signedAt`
 */
export function governanceAttestationPreimage(fields: GovernanceAttestationFields): Uint8Array {
  const s =
    HASH_DOMAIN_PREFIXES.governance +
    fields.role +
    "\n" +
    fields.policyRef +
    "\n" +
    fields.decisionRef +
    "\n" +
    fields.signedAt;
  return new TextEncoder().encode(s);
}

// =============================================================================
// SIGNER CONTRACT
// =============================================================================

/** Context passed to a {@link GovernanceSigner}. */
export interface GovernanceSignContext {
  /** Canonical preimage bytes (sr25519/ed25519 signers sign these). */
  preimage: Uint8Array;
  /** The raw fields, for signers (e.g. eip712) that build their own payload. */
  fields: GovernanceAttestationFields;
  /** Present iff the caller supplied an eip712 binding. */
  eip712?: GovernanceEip712Binding;
}

/**
 * A governance signer. Consumers provide an implementation (HSM, KMS, wallet,
 * or one of the built-in {@link createSr25519GovernanceSigner} /
 * {@link createEd25519GovernanceSigner} factories).
 */
export interface GovernanceSigner {
  /** Verifier-resolvable identity (SS58 address for substrate, 0x-address for evm). */
  address: string;
  signatureScheme: GovernanceSignatureScheme;
  /** Return the signature as a hex string (with or without `0x`). */
  sign(ctx: GovernanceSignContext): Promise<string> | string;
}

// =============================================================================
// HELPER: addGovernanceAttestation
// =============================================================================

export interface AddGovernanceAttestationOptions {
  role: GovernanceAttestationEvent["role"];
  policyRef: string;
  decisionRef: string;
  signer: GovernanceSigner;
  /** ISO 8601 timestamp; defaults to now. Included in the signed preimage. */
  signedAt?: string;
  /** Event visibility; defaults to "public" (governance is auditable). */
  visibility?: Visibility;
  /** EIP-712 binding — required when the signer scheme is "eip712". */
  eip712?: GovernanceEip712Binding;
}

/**
 * Sign and append a `governance-attestation` event to a span.
 *
 * @returns the recorded {@link GovernanceAttestationEvent} (with runtime fields).
 */
export async function addGovernanceAttestation(
  run: TraceRun,
  spanId: string,
  opts: AddGovernanceAttestationOptions
): Promise<GovernanceAttestationEvent> {
  if (!opts.role) throw new Error("addGovernanceAttestation: role is required");
  if (!opts.policyRef) throw new Error("addGovernanceAttestation: policyRef is required");
  if (!opts.decisionRef) throw new Error("addGovernanceAttestation: decisionRef is required");
  if (!opts.signer) throw new Error("addGovernanceAttestation: signer is required");

  if (opts.signer.signatureScheme === "eip712" && opts.eip712 === undefined) {
    throw new Error(
      "addGovernanceAttestation: an `eip712` binding is required for eip712 signers"
    );
  }

  const signedAt = opts.signedAt ?? new Date().toISOString();
  const fields: GovernanceAttestationFields = {
    role: opts.role,
    policyRef: opts.policyRef,
    decisionRef: opts.decisionRef,
    signedAt,
  };
  const preimage = governanceAttestationPreimage(fields);

  const ctx: GovernanceSignContext = opts.eip712
    ? { preimage, fields, eip712: opts.eip712 }
    : { preimage, fields };
  const signature = await opts.signer.sign(ctx);

  const event: Omit<GovernanceAttestationEvent, "id" | "seq" | "timestamp" | "hash"> = {
    kind: "governance-attestation",
    visibility: opts.visibility ?? "public",
    role: opts.role,
    policyRef: opts.policyRef,
    decisionRef: opts.decisionRef,
    attestor: {
      address: opts.signer.address,
      signatureScheme: opts.signer.signatureScheme,
    },
    signature,
    signedAt,
    ...(opts.eip712 ? { eip712: opts.eip712 } : {}),
  };

  const recorded = await addEvent(run, spanId, event);
  return recorded as GovernanceAttestationEvent;
}

// =============================================================================
// BUILT-IN SUBSTRATE SIGNERS (optional @polkadot peer dep)
// =============================================================================

interface PolkadotCrypto {
  cryptoWaitReady: () => Promise<boolean>;
  sr25519PairFromSeed: (seed: Uint8Array) => { publicKey: Uint8Array; secretKey: Uint8Array };
  sr25519Sign: (
    message: Uint8Array,
    pair: { publicKey: Uint8Array; secretKey: Uint8Array }
  ) => Uint8Array;
  sr25519Verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean;
  ed25519PairFromSeed: (seed: Uint8Array) => { publicKey: Uint8Array; secretKey: Uint8Array };
  ed25519Sign: (
    message: Uint8Array,
    pair: { publicKey: Uint8Array; secretKey: Uint8Array }
  ) => Uint8Array;
  ed25519Verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean;
  encodeAddress: (key: Uint8Array, ss58Format?: number) => string;
  decodeAddress: (address: string) => Uint8Array;
}

interface PolkadotUtil {
  u8aToHex: (value: Uint8Array) => string;
  hexToU8a: (value: string) => Uint8Array;
}

let polkadotPromise: Promise<{ crypto: PolkadotCrypto; util: PolkadotUtil }> | null = null;

async function loadPolkadot(): Promise<{ crypto: PolkadotCrypto; util: PolkadotUtil }> {
  if (!polkadotPromise) {
    polkadotPromise = (async () => {
      let crypto: PolkadotCrypto;
      let util: PolkadotUtil;
      try {
        crypto = (await import("@polkadot/util-crypto")) as unknown as PolkadotCrypto;
        util = (await import("@polkadot/util")) as unknown as PolkadotUtil;
      } catch {
        throw new Error(
          "Built-in sr25519/ed25519 governance support requires the optional peer " +
            "dependencies '@polkadot/util-crypto' and '@polkadot/util'. Install them, " +
            "or pass a custom GovernanceSigner / verifier."
        );
      }
      await crypto.cryptoWaitReady();
      return { crypto, util };
    })();
  }
  return polkadotPromise;
}

/** Default SS58 prefix used across the Orynq/Materios ecosystem. */
export const SS58_PREFIX = 42;

export interface SubstrateGovernanceSignerOptions {
  /** 32-byte seed as bytes or 0x-hex. Provide this OR (secretKey + publicKey). */
  seed?: Uint8Array | string;
  /** Expanded secret key (with publicKey). */
  secretKey?: Uint8Array;
  publicKey?: Uint8Array;
  /** Override the derived SS58 address. */
  address?: string;
  /** SS58 format for the derived address (default 42). */
  ss58Format?: number;
}

function resolveSeed(seed: Uint8Array | string, util: PolkadotUtil): Uint8Array {
  if (typeof seed === "string") {
    return util.hexToU8a(seed.startsWith("0x") ? seed : "0x" + seed);
  }
  return seed;
}

/**
 * Create an sr25519 governance signer backed by `@polkadot/util-crypto`.
 * Pass a 32-byte `seed` (bytes or 0x-hex) or an explicit `secretKey`+`publicKey`.
 */
export async function createSr25519GovernanceSigner(
  opts: SubstrateGovernanceSignerOptions
): Promise<GovernanceSigner> {
  const { crypto, util } = await loadPolkadot();
  let publicKey: Uint8Array;
  let secretKey: Uint8Array;
  if (opts.secretKey && opts.publicKey) {
    publicKey = opts.publicKey;
    secretKey = opts.secretKey;
  } else if (opts.seed !== undefined) {
    const pair = crypto.sr25519PairFromSeed(resolveSeed(opts.seed, util));
    publicKey = pair.publicKey;
    secretKey = pair.secretKey;
  } else {
    throw new Error("createSr25519GovernanceSigner: provide `seed` or `secretKey`+`publicKey`");
  }
  const address = opts.address ?? crypto.encodeAddress(publicKey, opts.ss58Format ?? SS58_PREFIX);
  return {
    address,
    signatureScheme: "sr25519",
    sign(ctx) {
      return util.u8aToHex(crypto.sr25519Sign(ctx.preimage, { publicKey, secretKey }));
    },
  };
}

/**
 * Create an ed25519 governance signer backed by `@polkadot/util-crypto`.
 * Pass a 32-byte `seed` (bytes or 0x-hex) or an explicit `secretKey`+`publicKey`.
 */
export async function createEd25519GovernanceSigner(
  opts: SubstrateGovernanceSignerOptions
): Promise<GovernanceSigner> {
  const { crypto, util } = await loadPolkadot();
  let publicKey: Uint8Array;
  let secretKey: Uint8Array;
  if (opts.secretKey && opts.publicKey) {
    publicKey = opts.publicKey;
    secretKey = opts.secretKey;
  } else if (opts.seed !== undefined) {
    const pair = crypto.ed25519PairFromSeed(resolveSeed(opts.seed, util));
    publicKey = pair.publicKey;
    secretKey = pair.secretKey;
  } else {
    throw new Error("createEd25519GovernanceSigner: provide `seed` or `secretKey`+`publicKey`");
  }
  const address = opts.address ?? crypto.encodeAddress(publicKey, opts.ss58Format ?? SS58_PREFIX);
  return {
    address,
    signatureScheme: "ed25519",
    sign(ctx) {
      return util.u8aToHex(crypto.ed25519Sign(ctx.preimage, { publicKey, secretKey }));
    },
  };
}

// =============================================================================
// VERIFICATION
// =============================================================================

/** A pluggable verifier for a single governance signature scheme. */
export type GovernanceVerifier = (
  event: GovernanceAttestationEvent,
  preimage: Uint8Array
) => Promise<boolean> | boolean;

export interface VerifyGovernanceOptions {
  /**
   * Per-scheme verifier overrides. An `eip712` verifier MUST be supplied here
   * (e.g. via {@link createEip712GovernanceVerifier}); sr25519/ed25519 fall back
   * to the built-in @polkadot verifiers when not overridden.
   */
  verifiers?: Partial<Record<GovernanceSignatureScheme, GovernanceVerifier>>;
}

/** Per-attestation verification result. */
export interface GovernanceAttestationSummary {
  eventId: string;
  role: string;
  attestor: string;
  scheme: GovernanceSignatureScheme;
  policyRef: string;
  decisionRef: string;
  verified: boolean;
  error?: string;
}

/**
 * Verify every `governance-attestation` event in a bundle and return a summary
 * tuple per attestation. Auditors get governance provenance "for free" — this
 * is also invoked by `verifyBundle(bundle, { governance: true })`.
 */
export async function verifyGovernanceAttestations(
  bundle: TraceBundle,
  opts: VerifyGovernanceOptions = {}
): Promise<GovernanceAttestationSummary[]> {
  const events = bundle.privateRun.events.filter(
    (e): e is GovernanceAttestationEvent & TraceEvent => e.kind === "governance-attestation"
  );

  const summaries: GovernanceAttestationSummary[] = [];
  for (const event of events) {
    const scheme = event.attestor.signatureScheme;
    const preimage = governanceAttestationPreimage({
      role: event.role,
      policyRef: event.policyRef,
      decisionRef: event.decisionRef,
      signedAt: event.signedAt,
    });

    const base = {
      eventId: event.id,
      role: event.role,
      attestor: event.attestor.address,
      scheme,
      policyRef: event.policyRef,
      decisionRef: event.decisionRef,
    };

    try {
      const override = opts.verifiers?.[scheme];
      let verified: boolean;
      if (override) {
        verified = await override(event, preimage);
      } else if (scheme === "sr25519" || scheme === "ed25519") {
        verified = await verifySubstrateSignature(scheme, event, preimage);
      } else {
        summaries.push({
          ...base,
          verified: false,
          error: `no verifier registered for scheme "${scheme}" (pass one via verifiers)`,
        });
        continue;
      }
      summaries.push({ ...base, verified });
    } catch (error) {
      summaries.push({
        ...base,
        verified: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summaries;
}

async function verifySubstrateSignature(
  scheme: "sr25519" | "ed25519",
  event: GovernanceAttestationEvent,
  preimage: Uint8Array
): Promise<boolean> {
  const { crypto, util } = await loadPolkadot();
  const publicKey = crypto.decodeAddress(event.attestor.address);
  const sig = util.hexToU8a(
    event.signature.startsWith("0x") ? event.signature : "0x" + event.signature
  );
  return scheme === "sr25519"
    ? crypto.sr25519Verify(preimage, sig, publicKey)
    : crypto.ed25519Verify(preimage, sig, publicKey);
}

/**
 * Build an `eip712` {@link GovernanceVerifier} from an injected
 * `verifyTypedData` (e.g. viem's). Keeps viem out of this package's deps.
 *
 * @example
 * ```typescript
 * import { verifyTypedData } from "viem";
 * const summary = await verifyGovernanceAttestations(bundle, {
 *   verifiers: { eip712: createEip712GovernanceVerifier({ verifyTypedData }) },
 * });
 * ```
 */
export function createEip712GovernanceVerifier(deps: {
  verifyTypedData: (args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  }) => Promise<boolean> | boolean;
}): GovernanceVerifier {
  return async (event) => {
    if (!event.eip712) {
      throw new Error("eip712 governance attestation is missing its `eip712` binding");
    }
    const signature = (
      event.signature.startsWith("0x") ? event.signature : "0x" + event.signature
    ) as `0x${string}`;
    return deps.verifyTypedData({
      address: event.attestor.address as `0x${string}`,
      domain: event.eip712.domain,
      types: event.eip712.types,
      primaryType: event.eip712.primaryType,
      message: event.eip712.message ?? {},
      signature,
    });
  };
}
