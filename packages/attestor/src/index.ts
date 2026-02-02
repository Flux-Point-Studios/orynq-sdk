/**
 * PoI Attestor Package
 *
 * TEE attestation backends for hardware-rooted trust.
 * Supports AWS Nitro Enclaves, AMD SEV-SNP, and more.
 *
 * @example
 * ```typescript
 * import { createNitroAttestor, verifyBundle } from '@fluxpointstudios/poi-sdk-attestor';
 *
 * // In a Nitro Enclave
 * const attestor = createNitroAttestor('my-agent');
 *
 * if (attestor.isAttested()) {
 *   const bundle = await attestor.attest(rootHash, 'rootHash');
 *   console.log('Attestation created:', bundle.attestorId);
 * }
 *
 * // Verifying an attestation
 * const result = await verifyBundle(bundle);
 * console.log('Valid:', result.valid);
 * ```
 *
 * @packageDocumentation
 */

// === Core Types ===
export type {
  TeeType,
  AttestationBundle,
  AttestationEvidence,
  AttestationBinding,
  VerifierPolicy,
  Measurements,
  SevSnpMeasurements,
  TdxMeasurements,
  SgxMeasurements,
  NitroMeasurements,
  SevSnpAttestation,
  TdxAttestation,
  SgxAttestation,
  NitroAttestation,
  GpuCcAttestation,
  VerificationResult,
  VerificationChecks,
  AttestorConfig,
  AttestorKeyConfig,
  NitroAttestorConfig,
  SevSnpAttestorConfig,
} from "./types.js";

export { AttestorError, AttestorException } from "./types.js";

// === Attestor Interface ===
export type { Attestor, AttestorFactory } from "./attestor-interface.js";
export {
  type AttestorRegistry,
  DefaultAttestorRegistry,
  attestorRegistry,
} from "./attestor-interface.js";

// === Attestation Bundle Utilities ===
export {
  AttestationBundleBuilder,
  serializeBundle,
  deserializeBundle,
  hashBundle,
  validateBinding,
  hasInlineEvidence,
  getEvidenceUri,
} from "./attestation-bundle.js";

// === Verification ===
export type { AttestationVerifier, VerifierFactory } from "./verification/verifier-interface.js";
export {
  VerifierRegistry,
  verifierRegistry,
  verifyBundle,
} from "./verification/verifier-interface.js";

export type { PolicyEvaluationResult } from "./verification/policy-engine.js";
export {
  evaluatePolicy,
  createPermissivePolicy,
  createStrictPolicy,
} from "./verification/policy-engine.js";

// === Nitro Backend ===
export {
  NitroAttestor,
  createNitroAttestor,
} from "./backends/nitro/nitro-attestor.js";

export {
  NitroVerifier,
  createNitroVerifier,
} from "./backends/nitro/nitro-verifier.js";

// === SEV-SNP Backend ===
export {
  SevSnpAttestor,
  createSevSnpAttestor,
} from "./backends/sev-snp/sev-snp-attestor.js";

export {
  SevSnpVerifier,
  createSevSnpVerifier,
} from "./backends/sev-snp/sev-snp-verifier.js";

// === Backend Registration ===
import { attestorRegistry } from "./attestor-interface.js";
import { verifierRegistry } from "./verification/verifier-interface.js";
import { createNitroAttestor } from "./backends/nitro/nitro-attestor.js";
import { createNitroVerifier } from "./backends/nitro/nitro-verifier.js";
import { createSevSnpAttestor } from "./backends/sev-snp/sev-snp-attestor.js";
import { createSevSnpVerifier } from "./backends/sev-snp/sev-snp-verifier.js";

// Register Nitro backend
attestorRegistry.register("nitro", (config) => createNitroAttestor(config.attestorId, config));
verifierRegistry.register("nitro", () => createNitroVerifier());

// Register SEV-SNP backend
attestorRegistry.register("sev-snp", (config) => createSevSnpAttestor(config.attestorId, config));
verifierRegistry.register("sev-snp", () => createSevSnpVerifier());
