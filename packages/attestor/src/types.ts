/**
 * Core types for the PoI Attestor package.
 * Provides TEE attestation backends for hardware-rooted trust.
 */

// === TEE Types ===

export type TeeType = "sev-snp" | "tdx" | "sgx" | "nitro" | "gpu-cc";

// === Attestation Bundle ===

export interface AttestationBundle {
  // TEE identification
  teeType: TeeType;
  teeVersion: string;

  // Raw evidence (or reference)
  evidence: AttestationEvidence;

  // What was attested
  binding: AttestationBinding;

  // Verifier configuration
  verifierPolicy: VerifierPolicy;

  // Attestor identity
  attestorId: string;
  attestorPubkey: string | undefined;

  // Timestamps
  createdAt: string;
}

export interface AttestationEvidence {
  format: "raw" | "base64" | "cbor";
  data: string | undefined;        // Inline if small enough
  hash: string | undefined;        // Hash if stored externally
  storageUri: string | undefined;  // Where to fetch full evidence
}

export interface AttestationBinding {
  hash: string;                    // The hash that was bound
  hashType: "rootHash" | "manifestHash" | "merkleRoot";
  timestamp: string;
  nonce: string | undefined;       // Optional nonce for freshness
}

// === Verifier Policy ===

export interface VerifierPolicy {
  // Expected measurements (at least one must match)
  expectedMeasurements: string[] | undefined;

  // Allowed signing keys
  allowedSignerKeys: string[] | undefined;

  // Minimum versions
  minFirmwareVersion: string | undefined;
  minSvn: number | undefined;

  // Revocation
  checkRevocation: boolean | undefined;
  revocationListUri: string | undefined;
}

// === Measurements ===

export interface Measurements {
  // Common fields
  firmwareVersion: string | undefined;

  // Platform-specific
  sevSnp: SevSnpMeasurements | undefined;
  tdx: TdxMeasurements | undefined;
  sgx: SgxMeasurements | undefined;
  nitro: NitroMeasurements | undefined;
}

export interface SevSnpMeasurements {
  launchMeasurement: string;
  guestPolicy: string;
  vmpl: number | undefined;
}

export interface TdxMeasurements {
  mrTd: string;
  mrConfigId: string;
  tdAttributes: string;
}

export interface SgxMeasurements {
  mrEnclave: string;
  mrSigner: string;
  isvProdId: number;
  isvSvn: number;
}

export interface NitroMeasurements {
  pcrs: Record<number, string>;
  moduleId: string;
}

// === Backend-Specific Attestation Types ===

export interface SevSnpAttestation extends AttestationBundle {
  teeType: "sev-snp";

  sevSnp: {
    launchMeasurement: string;
    reportData: string;        // Contains bound hash
    vcek: string;              // Versioned chip endorsement key
    certChain: string[];       // AMD root -> VCEK
  };
}

export interface TdxAttestation extends AttestationBundle {
  teeType: "tdx";

  tdx: {
    dcapQuote: string;
    mrTd: string;              // TD measurement register
    mrConfigId: string;
    reportData: string;        // REPORTDATA field with bound hash
    pckCert: string;
  };
}

export interface SgxAttestation extends AttestationBundle {
  teeType: "sgx";

  sgx: {
    quote: string;
    mrEnclave: string;
    mrSigner: string;
    isvProdId: number;
    isvSvn: number;
    reportData: string;
    enclaveHeldPubkey: string;
  };
}

export interface NitroAttestation extends AttestationBundle {
  teeType: "nitro";

  nitro: {
    attestationDocument: string;    // COSE-signed
    pcrs: Record<number, string>;   // PCR values
    userData: string;               // Contains bound hash
    nonce: string;
    publicKey: string | undefined;
    certificate: string;
  };
}

export interface GpuCcAttestation extends AttestationBundle {
  teeType: "gpu-cc";

  gpuCc: {
    // CPU TEE attestation
    cpuAttestation: SevSnpAttestation | TdxAttestation;

    // GPU attestation
    gpuAttestation: {
      driverVersion: string;
      gpuModel: string;
      ccMode: "on" | "devtools";
      measurements: {
        firmwareHash: string;
        vbiosHash: string;
      };
      certificate: string;
    };
  };
}

// === Verification ===

export interface VerificationResult {
  valid: boolean;
  teeType: TeeType;

  checks: VerificationChecks;

  warnings: string[];
  errors: string[];

  // Extracted measurements for policy checking
  measurements: Measurements | undefined;
}

export interface VerificationChecks {
  signatureValid: boolean;
  measurementsMatch: boolean;
  certChainValid: boolean;
  notRevoked: boolean;
  hashBindingValid: boolean;
}

// === Attestor Configuration ===

export interface AttestorConfig {
  // Attestor identity
  attestorId: string;

  // Key management
  keyConfig: AttestorKeyConfig | undefined;

  // Logging
  debug: boolean | undefined;
}

export interface AttestorKeyConfig {
  // For Nitro: KMS key for sealing
  kmsKeyId: string | undefined;

  // Sealing policy
  sealingPolicy: "instance" | "signer" | "product" | undefined;
}

// === Nitro-specific Configuration ===

export interface NitroAttestorConfig extends AttestorConfig {
  // AWS KMS integration
  kmsKeyId: string | undefined;
  kmsRegion: string | undefined;

  // Sealing policy
  sealingPolicy: "instance" | "signer" | "product";

  // PCR values to include
  includePcrs: number[] | undefined;
}

// === SEV-SNP-specific Configuration ===

export interface SevSnpAttestorConfig extends AttestorConfig {
  // VCEK fetching
  vcekCacheDir: string | undefined;

  // AMD root certificate
  amdRootCert: string | undefined;
}

// === Errors ===

export enum AttestorError {
  // General errors (3000)
  NOT_IN_TEE = 3000,
  TEE_NOT_SUPPORTED = 3001,
  ATTESTATION_FAILED = 3002,

  // Nitro errors (3100)
  NITRO_VSOCK_FAILED = 3100,
  NITRO_NSM_FAILED = 3101,
  NITRO_KMS_FAILED = 3102,
  NITRO_DOCUMENT_INVALID = 3103,

  // SEV-SNP errors (3200)
  SEV_REPORT_FAILED = 3200,
  SEV_VCEK_FETCH_FAILED = 3201,
  SEV_CERT_CHAIN_INVALID = 3202,

  // TDX errors (3300)
  TDX_QUOTE_FAILED = 3300,
  TDX_PCK_FETCH_FAILED = 3301,

  // SGX errors (3400)
  SGX_QUOTE_FAILED = 3400,
  SGX_REMOTE_ATTESTATION_FAILED = 3401,

  // Verification errors (3500)
  VERIFICATION_FAILED = 3500,
  SIGNATURE_INVALID = 3501,
  MEASUREMENT_MISMATCH = 3502,
  CERT_CHAIN_INVALID = 3503,
  HASH_BINDING_INVALID = 3504,
  REVOKED = 3505,
}

export class AttestorException extends Error {
  constructor(
    public readonly code: AttestorError,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "AttestorException";
  }
}
