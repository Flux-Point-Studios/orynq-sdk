/**
 * AMD SEV-SNP Attestor.
 * Provides attestation using AMD Secure Encrypted Virtualization with
 * Secure Nested Paging (SEV-SNP).
 */

import type { Attestor } from "../../attestor-interface.js";
import type {
  AttestationBundle,
  Measurements,
  SevSnpAttestorConfig,
  SevSnpAttestation,
} from "../../types.js";
import { AttestorError, AttestorException } from "../../types.js";
import { AttestationBundleBuilder } from "../../attestation-bundle.js";

/**
 * AMD SEV-SNP attestor implementation.
 *
 * SEV-SNP provides hardware-based memory encryption and attestation
 * for confidential VMs running on AMD EPYC processors.
 */
export class SevSnpAttestor implements Attestor {
  readonly teeType = "sev-snp" as const;
  readonly attestorId: string;

  private config: SevSnpAttestorConfig;
  private isInSevVm: boolean | null = null;

  constructor(config: SevSnpAttestorConfig) {
    this.config = config;
    this.attestorId = config.attestorId;
  }

  /**
   * Generate an attestation binding a hash value.
   */
  async attest(
    hashToSign: string,
    hashType: "rootHash" | "manifestHash" | "merkleRoot"
  ): Promise<AttestationBundle> {
    if (!this.isAttested()) {
      throw new AttestorException(
        AttestorError.NOT_IN_TEE,
        "Not running in a SEV-SNP protected VM"
      );
    }

    // Get attestation report from the AMD Secure Processor
    const report = await this.getAttestationReport(hashToSign);

    // Fetch the VCEK certificate
    const { vcek, certChain } = await this.fetchVcekCertificate(report);

    // Extract launch measurement from report
    const launchMeasurement = this.extractLaunchMeasurement(report);

    // Build the attestation bundle
    const builder = new AttestationBundleBuilder();

    const bundle = builder
      .setTee("sev-snp", "1.0")
      .setInlineEvidence(report, "base64")
      .setBinding(hashToSign, hashType)
      .setAttestor(this.attestorId)
      .setVerifierPolicy({
        expectedMeasurements: undefined,
        allowedSignerKeys: undefined,
        minFirmwareVersion: undefined,
        minSvn: undefined,
        checkRevocation: undefined,
        revocationListUri: undefined,
      })
      .build();

    // Add SEV-SNP-specific fields
    const sevSnpAttestation: SevSnpAttestation = {
      ...bundle,
      teeType: "sev-snp",
      sevSnp: {
        launchMeasurement,
        reportData: hashToSign,
        vcek,
        certChain,
      },
    };

    return sevSnpAttestation;
  }

  /**
   * Get the current measurements from the VM.
   */
  async getMeasurements(): Promise<Measurements> {
    if (!this.isAttested()) {
      throw new AttestorException(
        AttestorError.NOT_IN_TEE,
        "Not running in a SEV-SNP protected VM"
      );
    }

    // Get a basic attestation report to extract measurements
    const report = await this.getAttestationReport("measurement-query");
    const launchMeasurement = this.extractLaunchMeasurement(report);
    const guestPolicy = this.extractGuestPolicy(report);

    return {
      firmwareVersion: undefined,
      sevSnp: {
        launchMeasurement,
        guestPolicy,
        vmpl: this.extractVmpl(report),
      },
      tdx: undefined,
      sgx: undefined,
      nitro: undefined,
    };
  }

  /**
   * Check if running in a SEV-SNP protected VM.
   */
  isAttested(): boolean {
    if (this.isInSevVm !== null) {
      return this.isInSevVm;
    }

    // Check for SEV-SNP guest device
    try {
      // In a real implementation, we'd check for /dev/sev-guest
      // and read from /sys/kernel/mm/sev/snp_enabled
      this.isInSevVm = process.env.AMD_SEV_SNP === "1";
    } catch {
      this.isInSevVm = false;
    }

    return this.isInSevVm;
  }

  /**
   * Get the VM's public key (if available).
   */
  async getPublicKey(): Promise<string | undefined> {
    // SEV-SNP can derive keys sealed to the VM
    // This would use the VMPCK (VM Platform Communication Key)
    return undefined;
  }

  // === Private Methods ===

  /**
   * Get attestation report from the AMD Secure Processor.
   *
   * In a real implementation, this would:
   * 1. Open /dev/sev-guest
   * 2. Send SNP_GET_REPORT ioctl with report data
   * 3. Receive the signed attestation report
   */
  private async getAttestationReport(reportData: string): Promise<string> {
    if (!this.isAttested()) {
      throw new AttestorException(
        AttestorError.SEV_REPORT_FAILED,
        "SEV-SNP device not available"
      );
    }

    // Mock attestation report structure
    // Real reports are binary structures defined by AMD
    const mockReport = {
      version: 2,
      guest_svn: 0,
      policy: "0x30000",
      family_id: "00000000000000000000000000000000",
      image_id: "00000000000000000000000000000000",
      vmpl: 0,
      signature_algo: 1,
      platform_version: "00000000000000000000000000000000",
      platform_info: 0,
      flags: 0,
      report_data: Buffer.from(reportData).toString("hex").padEnd(128, "0"),
      measurement: "0".repeat(96), // 384-bit measurement (96 hex chars)
      host_data: "0".repeat(64),
      id_key_digest: "0".repeat(96),
      author_key_digest: "0".repeat(96),
      report_id: "0".repeat(64),
      report_id_ma: "0".repeat(64),
      reported_tcb: "0".repeat(16),
      chip_id: "0".repeat(128),
      signature: "0".repeat(1024),
    };

    return Buffer.from(JSON.stringify(mockReport)).toString("base64");
  }

  /**
   * Fetch the VCEK certificate from AMD KDS.
   *
   * The VCEK (Versioned Chip Endorsement Key) is specific to each
   * CPU and TCB version. It's fetched from AMD's Key Distribution Service.
   */
  private async fetchVcekCertificate(
    _report: string
  ): Promise<{ vcek: string; certChain: string[] }> {
    // In a real implementation, we would:
    // 1. Extract the chip_id and reported_tcb from the report
    // 2. Query AMD KDS: https://kdsintf.amd.com/vcek/v1/{product_name}/{chip_id}
    // 3. Cache the certificate locally

    this.debug("Would fetch VCEK certificate from AMD KDS");

    // Return mock certificates
    return {
      vcek: "mock-vcek-certificate",
      certChain: [
        "mock-vcek-certificate",
        "mock-ask-certificate", // AMD SEV Key
        "mock-ark-certificate", // AMD Root Key
      ],
    };
  }

  /**
   * Extract launch measurement from report.
   */
  private extractLaunchMeasurement(report: string): string {
    try {
      const decoded = JSON.parse(
        Buffer.from(report, "base64").toString("utf-8")
      ) as { measurement?: string };
      return decoded.measurement ?? "0".repeat(96);
    } catch {
      return "0".repeat(96);
    }
  }

  /**
   * Extract guest policy from report.
   */
  private extractGuestPolicy(report: string): string {
    try {
      const decoded = JSON.parse(
        Buffer.from(report, "base64").toString("utf-8")
      ) as { policy?: string };
      return decoded.policy ?? "0x0";
    } catch {
      return "0x0";
    }
  }

  /**
   * Extract VMPL (Virtual Machine Privilege Level) from report.
   */
  private extractVmpl(report: string): number | undefined {
    try {
      const decoded = JSON.parse(
        Buffer.from(report, "base64").toString("utf-8")
      ) as { vmpl?: number };
      return decoded.vmpl;
    } catch {
      return undefined;
    }
  }

  private debug(message: string): void {
    if (this.config.debug) {
      console.log(`[SevSnpAttestor] ${message}`);
    }
  }
}

/**
 * Create a SEV-SNP attestor with default configuration.
 */
export function createSevSnpAttestor(
  attestorId: string,
  options?: Partial<SevSnpAttestorConfig>
): SevSnpAttestor {
  return new SevSnpAttestor({
    attestorId,
    keyConfig: undefined,
    debug: options?.debug,
    vcekCacheDir: options?.vcekCacheDir,
    amdRootCert: options?.amdRootCert,
  });
}
