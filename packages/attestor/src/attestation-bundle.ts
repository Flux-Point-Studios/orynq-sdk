/**
 * Attestation Bundle utilities.
 * Provides helpers for creating and serializing attestation bundles.
 */

import type {
  TeeType,
  AttestationBundle,
  AttestationEvidence,
  AttestationBinding,
  VerifierPolicy,
} from "./types.js";

/**
 * Builder for creating attestation bundles.
 */
export class AttestationBundleBuilder {
  private teeType: TeeType | undefined;
  private teeVersion: string | undefined;
  private evidence: AttestationEvidence | undefined;
  private binding: AttestationBinding | undefined;
  private verifierPolicy: VerifierPolicy | undefined;
  private attestorId: string | undefined;
  private attestorPubkey: string | undefined;

  /**
   * Set the TEE type and version.
   */
  setTee(teeType: TeeType, version: string): this {
    this.teeType = teeType;
    this.teeVersion = version;
    return this;
  }

  /**
   * Set the attestation evidence.
   */
  setEvidence(evidence: AttestationEvidence): this {
    this.evidence = evidence;
    return this;
  }

  /**
   * Set inline evidence data.
   */
  setInlineEvidence(data: string, format: "raw" | "base64" | "cbor" = "base64"): this {
    this.evidence = {
      format,
      data,
      hash: undefined,
      storageUri: undefined,
    };
    return this;
  }

  /**
   * Set external evidence reference.
   */
  setExternalEvidence(hash: string, storageUri: string): this {
    this.evidence = {
      format: "base64",
      data: undefined,
      hash,
      storageUri,
    };
    return this;
  }

  /**
   * Set the hash binding.
   */
  setBinding(
    hash: string,
    hashType: "rootHash" | "manifestHash" | "merkleRoot",
    nonce?: string
  ): this {
    this.binding = {
      hash,
      hashType,
      timestamp: new Date().toISOString(),
      nonce,
    };
    return this;
  }

  /**
   * Set the verifier policy.
   */
  setVerifierPolicy(policy: VerifierPolicy): this {
    this.verifierPolicy = policy;
    return this;
  }

  /**
   * Set the attestor identity.
   */
  setAttestor(attestorId: string, pubkey?: string): this {
    this.attestorId = attestorId;
    this.attestorPubkey = pubkey;
    return this;
  }

  /**
   * Build the attestation bundle.
   */
  build(): AttestationBundle {
    if (!this.teeType) {
      throw new Error("TEE type is required");
    }
    if (!this.teeVersion) {
      throw new Error("TEE version is required");
    }
    if (!this.evidence) {
      throw new Error("Evidence is required");
    }
    if (!this.binding) {
      throw new Error("Binding is required");
    }
    if (!this.attestorId) {
      throw new Error("Attestor ID is required");
    }

    return {
      teeType: this.teeType,
      teeVersion: this.teeVersion,
      evidence: this.evidence,
      binding: this.binding,
      verifierPolicy: this.verifierPolicy ?? {
        expectedMeasurements: undefined,
        allowedSignerKeys: undefined,
        minFirmwareVersion: undefined,
        minSvn: undefined,
        checkRevocation: undefined,
        revocationListUri: undefined,
      },
      attestorId: this.attestorId,
      attestorPubkey: this.attestorPubkey,
      createdAt: new Date().toISOString(),
    };
  }
}

/**
 * Serialize an attestation bundle to JSON.
 */
export function serializeBundle(bundle: AttestationBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Deserialize an attestation bundle from JSON.
 */
export function deserializeBundle(json: string): AttestationBundle {
  const parsed = JSON.parse(json) as AttestationBundle;

  // Validate required fields
  if (!parsed.teeType) {
    throw new Error("Invalid bundle: missing teeType");
  }
  if (!parsed.evidence) {
    throw new Error("Invalid bundle: missing evidence");
  }
  if (!parsed.binding) {
    throw new Error("Invalid bundle: missing binding");
  }

  return parsed;
}

/**
 * Compute the canonical hash of an attestation bundle.
 */
export async function hashBundle(bundle: AttestationBundle): Promise<string> {
  // Create canonical representation (sorted keys, no whitespace)
  const canonical = JSON.stringify({
    teeType: bundle.teeType,
    teeVersion: bundle.teeVersion,
    evidence: bundle.evidence,
    binding: bundle.binding,
    verifierPolicy: bundle.verifierPolicy,
    attestorId: bundle.attestorId,
    attestorPubkey: bundle.attestorPubkey,
    createdAt: bundle.createdAt,
  });

  // Hash using SHA-256
  const crypto = globalThis.crypto ?? (await import("node:crypto")).webcrypto;
  const data = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Validate that a bundle's binding matches an expected hash.
 */
export function validateBinding(
  bundle: AttestationBundle,
  expectedHash: string,
  expectedHashType: "rootHash" | "manifestHash" | "merkleRoot"
): boolean {
  return (
    bundle.binding.hash === expectedHash &&
    bundle.binding.hashType === expectedHashType
  );
}

/**
 * Check if a bundle has inline evidence or external reference.
 */
export function hasInlineEvidence(bundle: AttestationBundle): boolean {
  return bundle.evidence.data !== undefined;
}

/**
 * Get the storage URI for external evidence.
 */
export function getEvidenceUri(bundle: AttestationBundle): string | undefined {
  return bundle.evidence.storageUri;
}
