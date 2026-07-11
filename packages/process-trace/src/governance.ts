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
 * // ...later, during audit: the attestor identity comes from the untrusted
 * // trace, so the caller MUST allow-list the authorized signer(s) — a valid
 * // self-signed attestation from an arbitrary key is not a real sign-off.
 * const summary = await verifyGovernanceAttestations(bundle, {
 *   authorizedAttestors: [signer.address],
 * });
 * // [{ role: "compliance", attestor: "5...", scheme: "sr25519", verified: true, authorized: true }]
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
  /**
   * Trace run id this attestation is scoped to. Binding it prevents replaying a
   * genuine attestation from trace X into an unrelated trace Y (#58).
   */
  runId: string;
}

/**
 * Build the canonical, domain-separated preimage signed by sr25519/ed25519
 * governance signers. Deterministic — a verifier reconstructs identical bytes
 * from the recorded event fields plus the enclosing run id.
 *
 * Layout: `"poi-trace:governance:v1|" + runId "\n" role "\n" policyRef "\n" decisionRef "\n" signedAt`
 */
export function governanceAttestationPreimage(fields: GovernanceAttestationFields): Uint8Array {
  const s =
    HASH_DOMAIN_PREFIXES.governance +
    fields.runId +
    "\n" +
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
    runId: run.id,
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

/** Context passed to a {@link GovernanceVerifier} alongside the event. */
export interface GovernanceVerifyContext {
  /** Canonical preimage bytes bound to this trace's run id (#58). */
  preimage: Uint8Array;
  /** The enclosing trace run id — verifiers MUST bind signatures to it. */
  runId: string;
}

/** A pluggable verifier for a single governance signature scheme. */
export type GovernanceVerifier = (
  event: GovernanceAttestationEvent,
  context: GovernanceVerifyContext
) => Promise<boolean> | boolean;

export interface VerifyGovernanceOptions {
  /**
   * Per-scheme verifier overrides. An `eip712` verifier MUST be supplied here
   * (e.g. via {@link createEip712GovernanceVerifier}); sr25519/ed25519 fall back
   * to the built-in @polkadot verifiers when not overridden.
   */
  verifiers?: Partial<Record<GovernanceSignatureScheme, GovernanceVerifier>>;
  /**
   * The set of attestor identities (SS58 / 0x-address, case-insensitive) that
   * are authorized to sign governance attestations. The attestor identity comes
   * from the untrusted trace, so a cryptographically valid self-signed
   * attestation from an arbitrary key is NOT a real sign-off — only a key on
   * this list counts. When OMITTED, governance verification FAILS CLOSED: every
   * attestation is `authorized: false` / `verified: false`, so an
   * "anyone can sign" attestation can never fold into a passing bundle verdict.
   * Optionally scope keys to a role via {@link authorizedAttestorsByRole}.
   */
  authorizedAttestors?: string[];
  /**
   * Per-role authorized attestors (case-insensitive). When present for an
   * attestation's role, the signer must be listed under THAT role — a
   * data-steward key cannot pass off a release-authority sign-off. Falls back to
   * {@link authorizedAttestors} for roles not present here.
   */
  authorizedAttestorsByRole?: Record<string, string[]>;
}

/** Per-attestation verification result. */
export interface GovernanceAttestationSummary {
  eventId: string;
  role: string;
  attestor: string;
  scheme: GovernanceSignatureScheme;
  policyRef: string;
  decisionRef: string;
  /** The signature cryptographically verifies AND the signer is authorized. */
  verified: boolean;
  /** The attestor is on the caller-supplied authorized-signer allow-list. */
  authorized: boolean;
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

  const runId = bundle.privateRun.id;
  const summaries: GovernanceAttestationSummary[] = [];
  for (const event of events) {
    const scheme = event.attestor.signatureScheme;
    // Reconstruct the preimage bound to THIS trace's run id (#58) — a genuine
    // attestation from another trace produces a different preimage and fails.
    const preimage = governanceAttestationPreimage({
      role: event.role,
      policyRef: event.policyRef,
      decisionRef: event.decisionRef,
      signedAt: event.signedAt,
      runId,
    });

    const base = {
      eventId: event.id,
      role: event.role,
      attestor: event.attestor.address,
      scheme,
      policyRef: event.policyRef,
      decisionRef: event.decisionRef,
    };

    // The attestor identity is attacker-controlled (it rides in the trace), so a
    // valid self-signed attestation from an arbitrary key is not a real sign-off.
    // Fail closed unless the caller allow-lists the signer for this role (#58).
    const authorized = attestorAuthorized(event.attestor.address, event.role, opts);
    if (!authorized) {
      summaries.push({
        ...base,
        authorized: false,
        verified: false,
        error:
          opts.authorizedAttestors === undefined && opts.authorizedAttestorsByRole === undefined
            ? "no authorized-attestor allow-list supplied — governance verification fails closed (pass authorizedAttestors)"
            : `attestor ${event.attestor.address} is not authorized for role "${event.role}"`,
      });
      continue;
    }

    try {
      const override = opts.verifiers?.[scheme];
      let signatureValid: boolean;
      if (override) {
        signatureValid = await override(event, { preimage, runId });
      } else if (scheme === "sr25519" || scheme === "ed25519") {
        signatureValid = await verifySubstrateSignature(scheme, event, preimage);
      } else {
        summaries.push({
          ...base,
          authorized: true,
          verified: false,
          error: `no verifier registered for scheme "${scheme}" (pass one via verifiers)`,
        });
        continue;
      }
      summaries.push({ ...base, authorized: true, verified: signatureValid });
    } catch (error) {
      summaries.push({
        ...base,
        authorized: true,
        verified: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summaries;
}

/**
 * True when `address` is on the caller-supplied authorized-attestor allow-list
 * for `role` (case-insensitive). A per-role list takes precedence for its role;
 * otherwise the flat list applies. With NEITHER list configured this returns
 * false — governance verification fails closed.
 */
function attestorAuthorized(
  address: string,
  role: string,
  opts: VerifyGovernanceOptions
): boolean {
  const norm = (s: string) => s.toLowerCase();
  const roleList = opts.authorizedAttestorsByRole?.[role];
  if (roleList !== undefined) {
    return roleList.map(norm).includes(norm(address));
  }
  if (opts.authorizedAttestors !== undefined) {
    return opts.authorizedAttestors.map(norm).includes(norm(address));
  }
  return false;
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

/** The message fields an eip712 attestation's signature MUST provably commit to. */
const REQUIRED_EIP712_FIELDS = ["role", "policyRef", "decisionRef", "runId"] as const;

/**
 * Build an `eip712` {@link GovernanceVerifier} from an injected
 * `verifyTypedData` (e.g. viem's). Keeps viem out of this package's deps.
 *
 * The schema pins (`expectedDomain`/`expectedPrimaryType`/`expectedTypes`) are
 * MANDATORY: the event's `eip712.{domain,primaryType,types}` are attacker-
 * controlled, so without pins an attacker signs an EMPTY struct
 * (`types:{Attestation:[]}`) with their own key and smuggles the claim fields as
 * untyped message extras the signature never commits to. The pinned primaryType
 * must also declare `role`, `policyRef`, `decisionRef`, and `runId` so the
 * signature provably binds them.
 *
 * @example
 * ```typescript
 * import { verifyTypedData } from "viem";
 * const summary = await verifyGovernanceAttestations(bundle, {
 *   verifiers: {
 *     eip712: createEip712GovernanceVerifier({
 *       verifyTypedData,
 *       expectedDomain: { name: "Orynq", version: "1" },
 *       expectedPrimaryType: "Attestation",
 *       expectedTypes: {
 *         Attestation: [
 *           { name: "role", type: "string" },
 *           { name: "policyRef", type: "string" },
 *           { name: "decisionRef", type: "string" },
 *           { name: "runId", type: "string" },
 *         ],
 *       },
 *     }),
 *   },
 *   authorizedAttestors: ["0x<release-authority>"],
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
  /**
   * Expected EIP-712 domain (name/version/chainId/verifyingContract). The
   * event's `eip712.domain` is attacker-controlled, so the verifier requires an
   * EXACT match on every field — a swapped verifyingContract/chainId/name is
   * rejected before the signature is trusted.
   */
  expectedDomain: Record<string, unknown>;
  /** Expected `primaryType`; a mismatch is rejected. */
  expectedPrimaryType: string;
  /** Expected `types` map; the event's must deep-equal it. */
  expectedTypes: Record<string, Array<{ name: string; type: string }>>;
}): GovernanceVerifier {
  if (
    deps.expectedDomain === undefined ||
    deps.expectedPrimaryType === undefined ||
    deps.expectedTypes === undefined
  ) {
    throw new Error(
      "createEip712GovernanceVerifier: expectedDomain, expectedPrimaryType, and expectedTypes are required — " +
        "an unpinned verifier accepts an empty attacker-signed struct (forgery)"
    );
  }
  const declared = deps.expectedTypes[deps.expectedPrimaryType];
  if (!declared) {
    throw new Error(
      `createEip712GovernanceVerifier: expectedTypes has no entry for primaryType "${deps.expectedPrimaryType}"`
    );
  }
  const declaredNames = new Set(declared.map((f) => f.name));
  const missing = REQUIRED_EIP712_FIELDS.filter((f) => !declaredNames.has(f));
  if (missing.length > 0) {
    throw new Error(
      `createEip712GovernanceVerifier: the pinned "${deps.expectedPrimaryType}" type must include ` +
        `${missing.join(", ")} so the signature commits to them`
    );
  }

  return async (event, context) => {
    if (!event.eip712) {
      throw new Error("eip712 governance attestation is missing its `eip712` binding");
    }

    // Pin the attacker-controlled typed-data schema BEFORE trusting the
    // signature. A signature over an unexpected domain/type proves nothing about
    // an Orynq governance attestation.
    if (event.eip712.primaryType !== deps.expectedPrimaryType) {
      return false;
    }
    if (!domainMatches(deps.expectedDomain, event.eip712.domain)) {
      return false;
    }
    if (!typesMatch(deps.expectedTypes, event.eip712.types)) {
      return false;
    }

    const signature = (
      event.signature.startsWith("0x") ? event.signature : "0x" + event.signature
    ) as `0x${string}`;
    const message = event.eip712.message ?? {};

    const sigValid = await deps.verifyTypedData({
      address: event.attestor.address as `0x${string}`,
      domain: event.eip712.domain,
      types: event.eip712.types,
      primaryType: event.eip712.primaryType,
      message,
      signature,
    });
    if (!sigValid) return false;

    // A valid signature over an attacker-chosen message is not enough (#58): the
    // signed message MUST correspond to the recorded claim (role/policyRef/
    // decisionRef) and be scoped to THIS trace's run id. Otherwise any valid
    // signature over any message forges an attestation for this event.
    return (
      message.role === event.role &&
      message.policyRef === event.policyRef &&
      message.decisionRef === event.decisionRef &&
      message.runId === context.runId
    );
  };
}

/**
 * True when every field of the EXPECTED domain is present and strictly equal in
 * the ACTUAL (event-supplied) domain. The actual domain may carry no extra
 * fields beyond the expected ones — extra fields (e.g. an injected
 * verifyingContract) are rejected, closing the domain-substitution vector.
 */
function domainMatches(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>
): boolean {
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (actualKeys.length !== expectedKeys.length) return false;
  for (const key of expectedKeys) {
    if (actual[key] !== expected[key]) return false;
  }
  return true;
}

/** Deep-equal for an EIP-712 `types` map (order-insensitive per type). */
function typesMatch(
  expected: Record<string, Array<{ name: string; type: string }>>,
  actual: Record<string, Array<{ name: string; type: string }>>
): boolean {
  const norm = (t: Record<string, Array<{ name: string; type: string }>>): string =>
    JSON.stringify(
      Object.fromEntries(
        Object.keys(t)
          .sort()
          .map((k) => [
            k,
            [...t[k]!].sort((a, b) => a.name.localeCompare(b.name)).map((f) => `${f.name}:${f.type}`),
          ])
      )
    );
  return norm(expected) === norm(actual);
}
