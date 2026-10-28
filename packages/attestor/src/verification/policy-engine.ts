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
 *
 * A requested check that cannot run fails: signer keys and revocation status
 * are never available to this function, a minimum firmware version needs a
 * reported dotted-numeric version, and a minimum SVN needs a TEE that reports
 * one.
 */
export function evaluatePolicy(
  measurements: Measurements,
  policy: VerifierPolicy,
  teeType: TeeType
): PolicyEvaluationResult {
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

  // Measurements carry no signing key to compare
  const signerKeysMatch = !policy.allowedSignerKeys?.length;
  if (!signerKeysMatch) {
    errors.push("Signer key verification is unavailable");
  }

  // Check firmware version
  let firmwareVersionOk = true;
  if (policy.minFirmwareVersion) {
    const order = measurements.firmwareVersion === undefined
      ? undefined
      : compareVersions(measurements.firmwareVersion, policy.minFirmwareVersion);
    firmwareVersionOk = order !== undefined && order >= 0;
    if (order === undefined) {
      errors.push(
        `Firmware version ${measurements.firmwareVersion ?? "(not reported)"} cannot be compared with minimum ${policy.minFirmwareVersion}`
      );
    } else if (!firmwareVersionOk) {
      errors.push(
        `Firmware version ${measurements.firmwareVersion} is below minimum ${policy.minFirmwareVersion}`
      );
    }
  }

  // Check SVN (Security Version Number)
  let svnOk = true;
  if (policy.minSvn !== undefined) {
    const actualSvn = getSvn(measurements, teeType);
    svnOk = actualSvn !== undefined && actualSvn >= policy.minSvn;
    if (actualSvn === undefined) {
      errors.push(`No SVN is reported for ${teeType}, so minimum ${policy.minSvn} cannot be checked`);
    } else if (!svnOk) {
      errors.push(`SVN ${actualSvn} is below minimum ${policy.minSvn}`);
    }
  }

  // Revocation status is never looked up
  const notRevoked = !policy.checkRevocation;
  if (!notRevoked) {
    errors.push("Revocation checking is unavailable");
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
    warnings: [],
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
 * Compare two dotted-numeric version strings.
 * Returns: negative if v1 < v2, 0 if equal, positive if v1 > v2, or undefined
 * when either is not dotted-numeric.
 */
function compareVersions(v1: string, v2: string): number | undefined {
  const parse = (version: string) =>
    version.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  const parts1 = parse(v1);
  const parts2 = parse(v2);
  if ([...parts1, ...parts2].some(Number.isNaN)) {
    return undefined;
  }

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
