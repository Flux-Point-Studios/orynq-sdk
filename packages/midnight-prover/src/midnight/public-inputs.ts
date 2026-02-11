/**
 * @fileoverview Public inputs builder for ZK proofs.
 *
 * Location: packages/midnight-prover/src/midnight/public-inputs.ts
 *
 * Summary:
 * This module handles the construction and serialization of public inputs
 * for various ZK proof types. Public inputs are values that are visible
 * to verifiers and form part of the proof statement.
 *
 * Usage:
 * Used by proof generators to construct the public component of proofs.
 * Public inputs are included in the proof and can be verified on-chain.
 *
 * Related files:
 * - hash-chain-proof.ts: Uses buildPublicInputs for hash-chain proofs
 * - witness-builder.ts: Builds the corresponding private witness
 * - types.ts: Type definitions for public inputs
 */

import type {
  ProofType,
  HashChainPublicInputs,
  PolicyPublicInputs,
  AttestationPublicInputs,
  DisclosurePublicInputs,
  InferencePublicInputs,
  AnyPublicInputs,
} from "../types.js";

import type { TeeType } from "@fluxpointstudios/poi-sdk-attestor";

import {
  hexToBytes,
  bytesToHex,
} from "@fluxpointstudios/poi-sdk-core/utils";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Input data for building hash-chain public inputs.
 */
export interface HashChainPublicInputData {
  rootHash: string;
  eventCount: number;
  cardanoAnchorTxHash: string;
}

/**
 * Input data for building policy compliance public inputs.
 */
export interface PolicyPublicInputData {
  promptHash: string;
  policyId: string;
  policyVersion: string;
  compliant: boolean;
  cardanoAnchorTxHash: string;
}

/**
 * Input data for building attestation public inputs.
 */
export interface AttestationPublicInputData {
  teeType: TeeType;
  measurementMatch: boolean;
  boundHash: string;
  cardanoAnchorTxHash: string;
}

/**
 * Input data for building disclosure public inputs.
 */
export interface DisclosurePublicInputData {
  spanHash: string;
  merkleRoot: string;
  cardanoAnchorTxHash: string;
}

/**
 * Input data for building inference public inputs.
 */
export interface InferencePublicInputData {
  modelWeightDigest: string;
  inputHash: string;
  outputHash: string;
  paramsHash: string;
  cardanoAnchorTxHash: string;
}

/**
 * Union type for all public input data types.
 */
export type AnyPublicInputData =
  | { type: "hash-chain"; data: HashChainPublicInputData }
  | { type: "policy-compliance"; data: PolicyPublicInputData }
  | { type: "attestation-valid"; data: AttestationPublicInputData }
  | { type: "selective-disclosure"; data: DisclosurePublicInputData }
  | { type: "zkml-inference"; data: InferencePublicInputData };

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Build public inputs for a ZK proof.
 *
 * This function constructs the public input structure for a given proof type.
 * Public inputs are the values that verifiers can see and check against
 * on-chain commitments (e.g., the Cardano anchor transaction).
 *
 * @param type - The type of proof to build public inputs for
 * @param data - The input data for constructing public inputs
 * @returns The constructed public inputs
 * @throws Error if the data is invalid for the proof type
 *
 * @example
 * ```typescript
 * const publicInputs = buildPublicInputs("hash-chain", {
 *   rootHash: "abc123...",
 *   eventCount: 42,
 *   cardanoAnchorTxHash: "def456...",
 * });
 * ```
 */
export function buildPublicInputs(
  type: "hash-chain",
  data: HashChainPublicInputData
): HashChainPublicInputs;
export function buildPublicInputs(
  type: "policy-compliance",
  data: PolicyPublicInputData
): PolicyPublicInputs;
export function buildPublicInputs(
  type: "attestation-valid",
  data: AttestationPublicInputData
): AttestationPublicInputs;
export function buildPublicInputs(
  type: "selective-disclosure",
  data: DisclosurePublicInputData
): DisclosurePublicInputs;
export function buildPublicInputs(
  type: "zkml-inference",
  data: InferencePublicInputData
): InferencePublicInputs;
export function buildPublicInputs(
  type: ProofType,
  data: unknown
): AnyPublicInputs;
export function buildPublicInputs(
  type: ProofType,
  data: unknown
): AnyPublicInputs {
  switch (type) {
    case "hash-chain":
      return buildHashChainPublicInputs(data as HashChainPublicInputData);

    case "policy-compliance":
      return buildPolicyPublicInputs(data as PolicyPublicInputData);

    case "attestation-valid":
      return buildAttestationPublicInputs(data as AttestationPublicInputData);

    case "selective-disclosure":
      return buildDisclosurePublicInputs(data as DisclosurePublicInputData);

    case "zkml-inference":
      return buildInferencePublicInputs(data as InferencePublicInputData);

    default:
      throw new Error(`Unknown proof type: ${type}`);
  }
}

// =============================================================================
// TYPE-SPECIFIC BUILDERS
// =============================================================================

/**
 * Build public inputs for hash-chain proof.
 */
function buildHashChainPublicInputs(
  data: HashChainPublicInputData
): HashChainPublicInputs {
  validateHexHash(data.rootHash, "rootHash");
  validateHexHash(data.cardanoAnchorTxHash, "cardanoAnchorTxHash");
  validatePositiveInteger(data.eventCount, "eventCount");

  return {
    rootHash: normalizeHash(data.rootHash),
    eventCount: data.eventCount,
    cardanoAnchorTxHash: normalizeHash(data.cardanoAnchorTxHash),
  };
}

/**
 * Build public inputs for policy compliance proof.
 */
function buildPolicyPublicInputs(
  data: PolicyPublicInputData
): PolicyPublicInputs {
  validateHexHash(data.promptHash, "promptHash");
  validateHexHash(data.cardanoAnchorTxHash, "cardanoAnchorTxHash");
  validateNonEmptyString(data.policyId, "policyId");
  validateNonEmptyString(data.policyVersion, "policyVersion");

  return {
    promptHash: normalizeHash(data.promptHash),
    policyId: data.policyId,
    policyVersion: data.policyVersion,
    compliant: Boolean(data.compliant),
    cardanoAnchorTxHash: normalizeHash(data.cardanoAnchorTxHash),
  };
}

/**
 * Build public inputs for attestation validity proof.
 */
function buildAttestationPublicInputs(
  data: AttestationPublicInputData
): AttestationPublicInputs {
  validateHexHash(data.boundHash, "boundHash");
  validateHexHash(data.cardanoAnchorTxHash, "cardanoAnchorTxHash");
  validateTeeType(data.teeType);

  return {
    teeType: data.teeType,
    measurementMatch: Boolean(data.measurementMatch),
    boundHash: normalizeHash(data.boundHash),
    cardanoAnchorTxHash: normalizeHash(data.cardanoAnchorTxHash),
  };
}

/**
 * Build public inputs for selective disclosure proof.
 */
function buildDisclosurePublicInputs(
  data: DisclosurePublicInputData
): DisclosurePublicInputs {
  validateHexHash(data.spanHash, "spanHash");
  validateHexHash(data.merkleRoot, "merkleRoot");
  validateHexHash(data.cardanoAnchorTxHash, "cardanoAnchorTxHash");

  return {
    spanHash: normalizeHash(data.spanHash),
    merkleRoot: normalizeHash(data.merkleRoot),
    cardanoAnchorTxHash: normalizeHash(data.cardanoAnchorTxHash),
  };
}

/**
 * Build public inputs for zkML inference proof.
 */
function buildInferencePublicInputs(
  data: InferencePublicInputData
): InferencePublicInputs {
  validateHexHash(data.modelWeightDigest, "modelWeightDigest");
  validateHexHash(data.inputHash, "inputHash");
  validateHexHash(data.outputHash, "outputHash");
  validateHexHash(data.paramsHash, "paramsHash");
  validateHexHash(data.cardanoAnchorTxHash, "cardanoAnchorTxHash");

  return {
    modelWeightDigest: normalizeHash(data.modelWeightDigest),
    inputHash: normalizeHash(data.inputHash),
    outputHash: normalizeHash(data.outputHash),
    paramsHash: normalizeHash(data.paramsHash),
    cardanoAnchorTxHash: normalizeHash(data.cardanoAnchorTxHash),
  };
}

// =============================================================================
// SERIALIZATION
// =============================================================================

/**
 * Serialize public inputs to a binary format for circuit consumption.
 *
 * The binary format is:
 * - 1 byte: proof type ID
 * - N bytes: type-specific fields (fixed-size binary encoding)
 *
 * @param type - Proof type
 * @param publicInputs - Public inputs to serialize
 * @returns Serialized public inputs as Uint8Array
 */
export function serializePublicInputs(
  type: ProofType,
  publicInputs: AnyPublicInputs
): Uint8Array {
  const typeId = getProofTypeId(type);

  switch (type) {
    case "hash-chain":
      return serializeHashChainInputs(
        typeId,
        publicInputs as HashChainPublicInputs
      );

    case "policy-compliance":
      return serializePolicyInputs(typeId, publicInputs as PolicyPublicInputs);

    case "attestation-valid":
      return serializeAttestationInputs(
        typeId,
        publicInputs as AttestationPublicInputs
      );

    case "selective-disclosure":
      return serializeDisclosureInputs(
        typeId,
        publicInputs as DisclosurePublicInputs
      );

    case "zkml-inference":
      return serializeInferenceInputs(
        typeId,
        publicInputs as InferencePublicInputs
      );

    default:
      throw new Error(`Cannot serialize unknown proof type: ${type}`);
  }
}

/**
 * Get a numeric ID for a proof type.
 */
function getProofTypeId(type: ProofType): number {
  const typeIds: Record<ProofType, number> = {
    "hash-chain": 1,
    "policy-compliance": 2,
    "attestation-valid": 3,
    "selective-disclosure": 4,
    "zkml-inference": 5,
    "eval-awareness": 6,
    "covert-channel": 7,
    "monitor-compliance": 8,
  };
  return typeIds[type];
}

/**
 * Serialize hash-chain public inputs.
 * Format: 1 byte type + 32 bytes rootHash + 4 bytes eventCount + 32 bytes anchorTx
 */
function serializeHashChainInputs(
  typeId: number,
  inputs: HashChainPublicInputs
): Uint8Array {
  const buffer = new Uint8Array(1 + 32 + 4 + 32);
  const view = new DataView(buffer.buffer);

  let offset = 0;
  buffer[offset++] = typeId;

  const rootHashBytes = hexToBytes(inputs.rootHash);
  buffer.set(rootHashBytes, offset);
  offset += 32;

  view.setUint32(offset, inputs.eventCount, false);
  offset += 4;

  const anchorBytes = hexToBytes(inputs.cardanoAnchorTxHash);
  buffer.set(anchorBytes, offset);

  return buffer;
}

/**
 * Serialize policy compliance public inputs.
 */
function serializePolicyInputs(
  typeId: number,
  inputs: PolicyPublicInputs
): Uint8Array {
  // Variable length due to policyId and policyVersion strings
  const policyIdBytes = new TextEncoder().encode(inputs.policyId);
  const policyVersionBytes = new TextEncoder().encode(inputs.policyVersion);

  const buffer = new Uint8Array(
    1 + 32 + 2 + policyIdBytes.length + 2 + policyVersionBytes.length + 1 + 32
  );
  const view = new DataView(buffer.buffer);

  let offset = 0;
  buffer[offset++] = typeId;

  const promptHashBytes = hexToBytes(inputs.promptHash);
  buffer.set(promptHashBytes, offset);
  offset += 32;

  view.setUint16(offset, policyIdBytes.length, false);
  offset += 2;
  buffer.set(policyIdBytes, offset);
  offset += policyIdBytes.length;

  view.setUint16(offset, policyVersionBytes.length, false);
  offset += 2;
  buffer.set(policyVersionBytes, offset);
  offset += policyVersionBytes.length;

  buffer[offset++] = inputs.compliant ? 1 : 0;

  const anchorBytes = hexToBytes(inputs.cardanoAnchorTxHash);
  buffer.set(anchorBytes, offset);

  return buffer;
}

/**
 * Serialize attestation public inputs.
 */
function serializeAttestationInputs(
  typeId: number,
  inputs: AttestationPublicInputs
): Uint8Array {
  const teeTypeId = getTeeTypeId(inputs.teeType);
  const buffer = new Uint8Array(1 + 1 + 1 + 32 + 32);

  let offset = 0;
  buffer[offset++] = typeId;
  buffer[offset++] = teeTypeId;
  buffer[offset++] = inputs.measurementMatch ? 1 : 0;

  const boundHashBytes = hexToBytes(inputs.boundHash);
  buffer.set(boundHashBytes, offset);
  offset += 32;

  const anchorBytes = hexToBytes(inputs.cardanoAnchorTxHash);
  buffer.set(anchorBytes, offset);

  return buffer;
}

/**
 * Serialize disclosure public inputs.
 */
function serializeDisclosureInputs(
  typeId: number,
  inputs: DisclosurePublicInputs
): Uint8Array {
  const buffer = new Uint8Array(1 + 32 + 32 + 32);

  let offset = 0;
  buffer[offset++] = typeId;

  const spanHashBytes = hexToBytes(inputs.spanHash);
  buffer.set(spanHashBytes, offset);
  offset += 32;

  const merkleRootBytes = hexToBytes(inputs.merkleRoot);
  buffer.set(merkleRootBytes, offset);
  offset += 32;

  const anchorBytes = hexToBytes(inputs.cardanoAnchorTxHash);
  buffer.set(anchorBytes, offset);

  return buffer;
}

/**
 * Serialize inference public inputs.
 */
function serializeInferenceInputs(
  typeId: number,
  inputs: InferencePublicInputs
): Uint8Array {
  const buffer = new Uint8Array(1 + 32 + 32 + 32 + 32 + 32);

  let offset = 0;
  buffer[offset++] = typeId;

  const modelBytes = hexToBytes(inputs.modelWeightDigest);
  buffer.set(modelBytes, offset);
  offset += 32;

  const inputBytes = hexToBytes(inputs.inputHash);
  buffer.set(inputBytes, offset);
  offset += 32;

  const outputBytes = hexToBytes(inputs.outputHash);
  buffer.set(outputBytes, offset);
  offset += 32;

  const paramsBytes = hexToBytes(inputs.paramsHash);
  buffer.set(paramsBytes, offset);
  offset += 32;

  const anchorBytes = hexToBytes(inputs.cardanoAnchorTxHash);
  buffer.set(anchorBytes, offset);

  return buffer;
}

/**
 * Get numeric ID for TEE type.
 * TeeType values: "sev-snp" | "tdx" | "sgx" | "nitro" | "gpu-cc"
 */
function getTeeTypeId(teeType: TeeType): number {
  const teeTypeIds: Record<TeeType, number> = {
    "sev-snp": 1,
    "tdx": 2,
    "sgx": 3,
    "nitro": 4,
    "gpu-cc": 5,
  };
  return teeTypeIds[teeType] ?? 0;
}

// =============================================================================
// HASHING
// =============================================================================

/**
 * Compute a hash commitment to public inputs.
 * This can be used to create a compact reference to the full public inputs.
 *
 * @param type - Proof type
 * @param publicInputs - Public inputs to hash
 * @returns Promise resolving to the hash as a hex string
 */
export async function hashPublicInputs(
  type: ProofType,
  publicInputs: AnyPublicInputs
): Promise<string> {
  const serialized = serializePublicInputs(type, publicInputs);
  // Copy to a fresh ArrayBuffer to ensure compatibility with crypto.subtle.digest
  const buffer = new ArrayBuffer(serialized.byteLength);
  new Uint8Array(buffer).set(serialized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validate a hex hash string.
 */
function validateHexHash(value: string, fieldName: string): void {
  // Remove 0x prefix if present
  const cleanHex = value.startsWith("0x") ? value.slice(2) : value;

  if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
    throw new Error(
      `Invalid ${fieldName}: expected 64-character hex string, got "${value}"`
    );
  }
}

/**
 * Validate a positive integer.
 */
function validatePositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${fieldName}: expected non-negative integer, got ${value}`
    );
  }
}

/**
 * Validate a non-empty string.
 */
function validateNonEmptyString(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Invalid ${fieldName}: expected non-empty string, got "${value}"`
    );
  }
}

/**
 * Validate TEE type.
 * TeeType values: "sev-snp" | "tdx" | "sgx" | "nitro" | "gpu-cc"
 */
function validateTeeType(teeType: TeeType): void {
  const validTypes: TeeType[] = ["sev-snp", "tdx", "sgx", "nitro", "gpu-cc"];
  if (!validTypes.includes(teeType)) {
    throw new Error(`Invalid teeType: "${teeType}"`);
  }
}

/**
 * Normalize a hash to lowercase without 0x prefix.
 */
function normalizeHash(hash: string): string {
  const cleanHex = hash.startsWith("0x") ? hash.slice(2) : hash;
  return cleanHex.toLowerCase();
}
