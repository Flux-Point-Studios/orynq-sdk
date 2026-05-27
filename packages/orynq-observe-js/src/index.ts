/**
 * @fluxpointstudios/orynq-observe — SDK for attested AI model observations.
 *
 *     import { Observation, ObserverKeypair } from "@fluxpointstudios/orynq-observe";
 *
 *     const obs = new Observation({
 *       modelName: "claude-opus-4-7",
 *       modelVersion: "20260201",
 *       taxonomyId: "AUTO-MONEY-001",
 *       severity: "high",
 *       observerContext: "independent red-team session, internal docs",
 *     });
 *     obs.addEvidence({ prompt, response });
 *     obs.addArtifact("/path/to/transcript.json");
 *     obs.attestTee({ tier: "Acurast", evidence: "..." });
 *
 *     const receipt = await obs.submit({
 *       wallet: "path/to/observer.json",
 *       network: "preprod",
 *       apiKey: process.env.OBSERVE_API_KEY,
 *     });
 *     console.log(receipt.materiosTx, receipt.cardanoAnchorTx);
 */

export {
  // Schema constants
  SCHEMA_VERSION,
  SCHEMA_HASH_HEX,
  SEVERITIES,
  type Severity,
  // Canonical encoder (advanced verifiers)
  canonicalCbor,
  canonicalContentHash,
  type AiCapabilityObservationRecord,
} from "./canonical.js";

export {
  ObserverKeypair,
  InvalidKeyfileError,
  InvalidSeedError,
  SS58_PREFIX,
} from "./keypair.js";

export {
  Observation,
  ObservationError,
  type ObservationConstructorOptions,
  type AddEvidenceOptions,
  type AddEvidenceHashesOptions,
  type AddArtifactOptions,
  type AttestTeeOptions,
  type SubmitOptions,
} from "./observation.js";

export {
  submitObservation,
  SubmissionReceipt,
  type SubmissionReceiptInit,
  type SubmitObservationOptions,
  SubmitError,
  GatewayError,
  DEFAULT_GATEWAY_URLS,
} from "./submit.js";

export const VERSION = "0.1.0";
