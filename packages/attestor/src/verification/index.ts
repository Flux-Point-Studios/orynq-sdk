/**
 * Verification module exports.
 */

export {
  type AttestationVerifier,
  type VerifierFactory,
  VerifierRegistry,
  verifierRegistry,
  verifyBundle,
} from "./verifier-interface.js";

export {
  type PolicyEvaluationResult,
  evaluatePolicy,
  createPermissivePolicy,
  createStrictPolicy,
} from "./policy-engine.js";
