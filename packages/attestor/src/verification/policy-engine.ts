/**
 * Policy Engine for attestation verification.
 * Evaluates measurements against configured policies.
 */

import type {
  VerifierPolicy,
  Measurements,
  TeeType,
} from "../types.js";

/**
 * Result of policy evaluation.
 */
export interface PolicyEvaluationResult {
  passed: boolean;
  measurementsMatch: boolean;
  signerKeysMatch: boolean;
  firmwareVersionOk: boolean;
  svnOk: boolean;
  notRevoked: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Evaluate measurements against a policy.
 */
export function evaluatePolicy(
  measurements: Measurements,
  policy: VerifierPolicy,
  teeType: TeeType
): PolicyEvaluationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Check measurements
  let measurementsMatch = true;
  if (policy.expectedMeasurements && policy.expectedMeasurements.length > 0) {
    const actualMeasurement = getMeasurementString(measurements, teeType);
    if (actualMeasurement) {
      measurementsMatch = policy.expectedMeasurements.includes(actualMeasurement);
      if (!measurementsMatch) {
        errors.push(`Measurement mismatch: ${actualMeasurement} not in expected list`);
      }
    } else {
      measurementsMatch = false;
      errors.push("Could not extract measurement for comparison");
    }
  }

  // Check signer keys (placeholder - would need actual key comparison)
  const signerKeysMatch = true; // TODO: Implement signer key verification

  // Check firmware version
  let firmwareVersionOk = true;
  if (policy.minFirmwareVersion && measurements.firmwareVersion) {
    firmwareVersionOk = compareVersions(
      measurements.firmwareVersion,
      policy.minFirmwareVersion
    ) >= 0;
    if (!firmwareVersionOk) {
      errors.push(
        `Firmware version ${measurements.firmwareVersion} is below minimum ${policy.minFirmwareVersion}`
      );
    }
  }

  // Check SVN (Security Version Number)
  let svnOk = true;
  if (policy.minSvn !== undefined) {
    const actualSvn = getSvn(measurements, teeType);
    if (actualSvn !== undefined) {
      svnOk = actualSvn >= policy.minSvn;
      if (!svnOk) {
        errors.push(`SVN ${actualSvn} is below minimum ${policy.minSvn}`);
      }
    }
  }

  // Check revocation (placeholder - would need revocation list lookup)
  let notRevoked = true;
  if (policy.checkRevocation && policy.revocationListUri) {
    // TODO: Implement revocation checking
    warnings.push("Revocation checking not implemented");
  }

  const passed =
    measurementsMatch &&
    signerKeysMatch &&
    firmwareVersionOk &&
    svnOk &&
    notRevoked;

  return {
    passed,
    measurementsMatch,
    signerKeysMatch,
    firmwareVersionOk,
    svnOk,
    notRevoked,
    warnings,
    errors,
  };
}

/**
 * Get the primary measurement string for a TEE type.
 */
function getMeasurementString(
  measurements: Measurements,
  teeType: TeeType
): string | undefined {
  switch (teeType) {
    case "sev-snp":
      return measurements.sevSnp?.launchMeasurement;

    case "tdx":
      return measurements.tdx?.mrTd;

    case "sgx":
      return measurements.sgx?.mrEnclave;

    case "nitro":
      // For Nitro, concatenate key PCRs
      if (measurements.nitro?.pcrs) {
        const pcrs = measurements.nitro.pcrs;
        const pcr0 = pcrs[0];
        const pcr1 = pcrs[1];
        const pcr2 = pcrs[2];
        if (pcr0 && pcr1 && pcr2) {
          return `${pcr0}:${pcr1}:${pcr2}`;
        }
      }
      return undefined;

    case "gpu-cc":
      // For GPU-CC, use the CPU attestation measurement
      return measurements.sevSnp?.launchMeasurement ?? measurements.tdx?.mrTd;

    default:
      return undefined;
  }
}

/**
 * Get the SVN (Security Version Number) for a TEE type.
 */
function getSvn(measurements: Measurements, teeType: TeeType): number | undefined {
  switch (teeType) {
    case "sgx":
      return measurements.sgx?.isvSvn;

    case "sev-snp":
    case "tdx":
    case "nitro":
    case "gpu-cc":
      // These TEE types don't have a simple SVN concept
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Compare two version strings.
 * Returns: negative if v1 < v2, 0 if equal, positive if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(p => parseInt(p, 10));
  const parts2 = v2.split(".").map(p => parseInt(p, 10));

  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] ?? 0;
    const p2 = parts2[i] ?? 0;

    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }

  return 0;
}

/**
 * Create a default permissive policy.
 */
export function createPermissivePolicy(): VerifierPolicy {
  return {
    expectedMeasurements: undefined,
    allowedSignerKeys: undefined,
    minFirmwareVersion: undefined,
    minSvn: undefined,
    checkRevocation: false,
    revocationListUri: undefined,
  };
}

/**
 * Create a strict policy requiring specific measurements.
 */
export function createStrictPolicy(
  expectedMeasurements: string[],
  options?: {
    minFirmwareVersion?: string;
    minSvn?: number;
    checkRevocation?: boolean;
    revocationListUri?: string;
  }
): VerifierPolicy {
  return {
    expectedMeasurements,
    allowedSignerKeys: undefined,
    minFirmwareVersion: options?.minFirmwareVersion,
    minSvn: options?.minSvn,
    checkRevocation: options?.checkRevocation ?? true,
    revocationListUri: options?.revocationListUri,
  };
}
