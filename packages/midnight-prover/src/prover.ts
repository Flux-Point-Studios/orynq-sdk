/**
 * @fileoverview Default implementation of the MidnightProver interface.
 *
 * Location: packages/midnight-prover/src/prover.ts
 *
 * Summary:
 * This module implements the DefaultMidnightProver class which provides a complete
 * implementation of the MidnightProver interface. It coordinates all proof types
 * (hash-chain, policy, disclosure, attestation, inference), manages connection
 * lifecycle, and handles proof publication.
 *
 * Usage:
 * - Primary entry point for ZK proof generation in the PoI system
 * - Coordinates individual provers from src/proofs/
 * - Manages connection to the Midnight proof server
 * - Handles proof publication and verification
 *
 * @example
 * ```typescript
 * import { createMidnightProver } from './prover.js';
 *
 * const prover = createMidnightProver({ debug: true });
 *
 * await prover.connect({
 *   proofServerUrl: 'https://proof.midnight.network',
 *   timeout: 300000,
 *   retries: 3,
 * });
 *
 * const proof = await prover.proveHashChain(input);
 * const result = await prover.publish(proof);
 *
 * await prover.disconnect();
 * ```
 */

import type {
  ProofServerConfig,
  HashChainInput,
  HashChainProof,
  PolicyInput,
  PolicyProof,
  AttestationInput,
  AttestationProof,
  DisclosureInput,
  DisclosureProof,
  InferenceInput,
  InferenceProof,
  EvalAwarenessInput,
  EvalAwarenessProof,
  CovertChannelInput,
  CovertChannelProof,
  MonitorComplianceInput,
  MonitorComplianceProof,
  AnyProof,
  PublicationResult,
  ProofVerificationResult,
} from "./types.js";

import {
  MidnightProverError,
  MidnightProverException,
} from "./types.js";

import {
  AbstractMidnightProver,
  type CreateMidnightProverOptions,
  proverRegistry,
} from "./prover-interface.js";

import { HashChainProver } from "./proofs/hash-chain-proof.js";
import { PolicyComplianceProver } from "./proofs/policy-compliance-proof.js";
import { SelectiveDisclosureProver } from "./proofs/selective-disclosure.js";
import { EvalAwarenessProver } from "./proofs/eval-awareness-proof.js";
import { CovertChannelProver } from "./proofs/covert-channel-proof.js";
import { MonitorComplianceProver } from "./proofs/monitor-compliance-proof.js";
import { ProofPublisher } from "./linking/proof-publication.js";
import { ProofServerClient } from "./midnight/proof-server-client.js";

// =============================================================================
// DEFAULT MIDNIGHT PROVER
// =============================================================================

/**
 * DefaultMidnightProver provides a complete implementation of the MidnightProver interface.
 *
 * This class:
 * - Coordinates all proof types (hash-chain, policy, disclosure)
 * - Manages connection lifecycle with the Midnight proof server
 * - Handles proof publication and verification
 * - Uses individual provers from src/proofs/ for specific proof types
 *
 * @example
 * ```typescript
 * const prover = new DefaultMidnightProver({ debug: true });
 *
 * await prover.connect({
 *   proofServerUrl: 'https://proof.midnight.network',
 *   apiKey: process.env.MIDNIGHT_API_KEY,
 *   timeout: 300000,
 *   retries: 3,
 * });
 *
 * try {
 *   // Generate proofs
 *   const hashChainProof = await prover.proveHashChain(input);
 *   const policyProof = await prover.provePolicyCompliance(policyInput);
 *
 *   // Publish to network
 *   const result = await prover.publish(hashChainProof);
 *   console.log('Published:', result.midnightTxHash);
 * } finally {
 *   await prover.disconnect();
 * }
 * ```
 */
export class DefaultMidnightProver extends AbstractMidnightProver {
  private readonly options: Required<CreateMidnightProverOptions>;

  // Individual provers
  private hashChainProver: HashChainProver;
  private policyProver: PolicyComplianceProver;
  private disclosureProver: SelectiveDisclosureProver;
  private evalAwarenessProver: EvalAwarenessProver;
  private covertChannelProver: CovertChannelProver;
  private monitorComplianceProver: MonitorComplianceProver;

  // Network clients
  private proofServerClient: ProofServerClient;
  private proofPublisher: ProofPublisher;

  // Published proofs cache
  private readonly publishedProofs = new Map<string, AnyProof>();

  /**
   * Create a new DefaultMidnightProver instance.
   *
   * @param options - Configuration options
   */
  constructor(options: CreateMidnightProverOptions = {}) {
    super();

    this.options = {
      debug: options.debug ?? false,
      circuitsDir: options.circuitsDir ?? "./circuits",
      enableInference: options.enableInference ?? false,
    };

    // Initialize individual provers
    this.hashChainProver = new HashChainProver({
      debug: this.options.debug,
      simulatedProvingTimeMs: 50,
    });

    this.policyProver = new PolicyComplianceProver({
      debug: this.options.debug,
    });

    this.disclosureProver = new SelectiveDisclosureProver({
      debug: this.options.debug,
      includeSpanData: true,
      includeEventData: true,
    });

    this.evalAwarenessProver = new EvalAwarenessProver({
      debug: this.options.debug,
      simulatedProvingTimeMs: 50,
    });

    this.covertChannelProver = new CovertChannelProver({
      debug: this.options.debug,
      simulatedProvingTimeMs: 50,
    });

    this.monitorComplianceProver = new MonitorComplianceProver({
      debug: this.options.debug,
      simulatedProvingTimeMs: 50,
    });

    // Initialize network clients
    this.proofServerClient = new ProofServerClient({
      debug: this.options.debug,
      simulatedProvingTimeMs: 50,
    });

    this.proofPublisher = new ProofPublisher({
      debug: this.options.debug,
      maxRetries: 3,
      pollIntervalMs: 1000, // Faster polling for tests
    });
  }

  // ===========================================================================
  // CONNECTION MANAGEMENT
  // ===========================================================================

  /**
   * Connect to the Midnight proof server.
   */
  protected async doConnect(config: ProofServerConfig): Promise<void> {
    this.debug(`Connecting to proof server at ${config.proofServerUrl}...`);

    try {
      // Connect proof server client
      await this.proofServerClient.connect(config);

      // Connect proof publisher
      await this.proofPublisher.connect(config);

      this.debug("Connected successfully");
    } catch (error) {
      // Disconnect any partially connected components
      await this.doDisconnect();

      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.CONNECTION_FAILED,
        `Failed to connect: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Disconnect from the proof server.
   */
  protected async doDisconnect(): Promise<void> {
    this.debug("Disconnecting...");

    // Disconnect components (ignore errors during cleanup)
    try {
      await this.proofServerClient.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    try {
      await this.proofPublisher.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    this.debug("Disconnected");
  }

  // ===========================================================================
  // PROOF GENERATION
  // ===========================================================================

  /**
   * Generate a hash-chain validity proof.
   */
  async proveHashChain(input: HashChainInput): Promise<HashChainProof> {
    this.ensureConnected();
    this.debug(`Generating hash-chain proof for ${input.events.length} events`);

    try {
      const proof = await this.hashChainProver.generateProof(input);
      this.debug(`Hash-chain proof generated: ${proof.proofId}`);
      return proof;
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.PROOF_GENERATION_FAILED,
        `Hash-chain proof generation failed: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate a policy compliance proof.
   */
  async provePolicyCompliance(input: PolicyInput): Promise<PolicyProof> {
    this.ensureConnected();
    this.debug(`Generating policy compliance proof for policy ${input.policy.id}`);

    try {
      const proof = await this.policyProver.generateProof(input);
      this.debug(`Policy proof generated: ${proof.proofId}`);
      return proof;
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.PROOF_GENERATION_FAILED,
        `Policy compliance proof generation failed: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate an attestation validity proof.
   *
   * Note: Attestation proof generation is not yet implemented.
   * This method throws a not-implemented error.
   */
  async proveAttestation(_input: AttestationInput): Promise<AttestationProof> {
    this.ensureConnected();
    this.debug("Attestation proofs not yet implemented");

    throw new MidnightProverException(
      MidnightProverError.CIRCUIT_NOT_FOUND,
      "Attestation proof generation is not yet implemented"
    );
  }

  /**
   * Generate a selective disclosure proof.
   */
  async proveSelectiveDisclosure(input: DisclosureInput): Promise<DisclosureProof> {
    this.ensureConnected();
    this.debug(`Generating selective disclosure proof for span ${input.spanId}`);

    try {
      const proof = await this.disclosureProver.generateProof(input);
      this.debug(`Disclosure proof generated: ${proof.proofId}`);
      return proof;
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.PROOF_GENERATION_FAILED,
        `Selective disclosure proof generation failed: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate a zkML inference proof.
   *
   * WARNING: zkML proofs are extremely expensive and not yet supported.
   * This method throws a not-implemented error unless enableInference is true.
   */
  proveInference(_input: InferenceInput): Promise<InferenceProof> {
    this.ensureConnected();

    if (!this.options.enableInference) {
      throw new MidnightProverException(
        MidnightProverError.CIRCUIT_NOT_FOUND,
        "zkML inference proofs are disabled. Enable with { enableInference: true }"
      );
    }

    // Even with enableInference, actual zkML is not yet implemented
    throw new MidnightProverException(
      MidnightProverError.CIRCUIT_NOT_FOUND,
      "zkML inference proofs are not yet implemented"
    );
  }

  // ===========================================================================
  // SAFETY PROOF GENERATION
  // ===========================================================================

  /**
   * Generate an eval awareness proof.
   */
  async proveEvalAwareness(input: EvalAwarenessInput): Promise<EvalAwarenessProof> {
    this.ensureConnected();
    this.debug("Generating eval-awareness proof");

    try {
      const proof = await this.evalAwarenessProver.generateProof(input);
      this.debug(`Eval-awareness proof generated: ${proof.proofId}`);
      return proof;
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.SAFETY_PROOF_GENERATION_FAILED,
        `Eval-awareness proof generation failed: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate a covert channel detection proof.
   */
  async proveCovertChannel(input: CovertChannelInput): Promise<CovertChannelProof> {
    this.ensureConnected();
    this.debug("Generating covert-channel proof");

    try {
      const proof = await this.covertChannelProver.generateProof(input);
      this.debug(`Covert-channel proof generated: ${proof.proofId}`);
      return proof;
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.SAFETY_PROOF_GENERATION_FAILED,
        `Covert-channel proof generation failed: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate a monitor compliance proof.
   */
  async proveMonitorCompliance(input: MonitorComplianceInput): Promise<MonitorComplianceProof> {
    this.ensureConnected();
    this.debug("Generating monitor-compliance proof");

    try {
      const proof = await this.monitorComplianceProver.generateProof(input);
      this.debug(`Monitor-compliance proof generated: ${proof.proofId}`);
      return proof;
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.SAFETY_PROOF_GENERATION_FAILED,
        `Monitor-compliance proof generation failed: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  // ===========================================================================
  // PUBLICATION
  // ===========================================================================

  /**
   * Publish a proof to the Midnight network.
   */
  async publish(proof: AnyProof): Promise<PublicationResult> {
    this.ensureConnected();
    this.debug(`Publishing proof: ${proof.proofId}`);

    try {
      const result = await this.proofPublisher.publish(proof);

      // Cache the published proof
      this.publishedProofs.set(proof.proofId, proof);

      this.debug(`Proof published: ${result.midnightTxHash}`);
      return result;
    } catch (error) {
      if (error instanceof MidnightProverException) {
        throw error;
      }
      throw new MidnightProverException(
        MidnightProverError.PUBLICATION_FAILED,
        `Proof publication failed: ${String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  // ===========================================================================
  // VERIFICATION
  // ===========================================================================

  /**
   * Verify a proof locally.
   */
  async verify(proof: AnyProof): Promise<ProofVerificationResult> {
    this.debug(`Verifying proof: ${proof.proofId}`);

    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Verify based on proof type
      let valid = false;

      switch (proof.proofType) {
        case "hash-chain":
          valid = await this.hashChainProver.verifyProof(proof as HashChainProof);
          break;

        case "policy-compliance":
          valid = await this.policyProver.verifyProof(proof as PolicyProof);
          break;

        case "selective-disclosure":
          valid = await this.disclosureProver.verifyProof(proof as DisclosureProof);
          break;

        case "attestation-valid":
          warnings.push("Attestation proof verification not yet implemented");
          valid = false;
          break;

        case "zkml-inference":
          warnings.push("zkML inference proof verification not yet implemented");
          valid = false;
          break;

        case "eval-awareness":
          valid = await this.evalAwarenessProver.verifyProof(proof as EvalAwarenessProof);
          break;

        case "covert-channel":
          valid = await this.covertChannelProver.verifyProof(proof as CovertChannelProof);
          break;

        case "monitor-compliance":
          valid = await this.monitorComplianceProver.verifyProof(proof as MonitorComplianceProof);
          break;

        default: {
          const unknownProof = proof as { proofType: string };
          errors.push(`Unknown proof type: ${unknownProof.proofType}`);
          valid = false;
        }
      }

      const result: ProofVerificationResult = {
        valid,
        proofType: proof.proofType,
        publicInputs: this.extractPublicInputs(proof),
        errors,
        warnings,
        verifiedAt: new Date().toISOString(),
      };

      this.debug(`Verification result: ${valid ? "VALID" : "INVALID"}`);

      return result;
    } catch (error) {
      errors.push(`Verification error: ${String(error)}`);

      return {
        valid: false,
        proofType: proof.proofType,
        publicInputs: {},
        errors,
        warnings,
        verifiedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Fetch a proof from the Midnight network by ID.
   */
  async fetchProof(proofId: string): Promise<AnyProof | undefined> {
    this.ensureConnected();
    this.debug(`Fetching proof: ${proofId}`);

    // Check local cache first
    const cached = this.publishedProofs.get(proofId);
    if (cached) {
      this.debug("Proof found in cache");
      return cached;
    }

    // In a real implementation, this would query the Midnight network
    // For now, return undefined (not found)
    this.debug("Proof not found");
    return undefined;
  }

  /**
   * Check if a proof has been published to Midnight.
   */
  async isPublished(proofId: string): Promise<boolean> {
    this.ensureConnected();

    // Check publisher's status
    const status = await this.proofPublisher.getProofStatus(proofId);
    return status.status === "confirmed" || status.status === "pending";
  }

  // ===========================================================================
  // UTILITY METHODS
  // ===========================================================================

  /**
   * Get the genesis hash for hash-chain proofs.
   */
  async getGenesisHash(): Promise<string> {
    return this.hashChainProver.getGenesisHash();
  }

  /**
   * Wait for a proof to be confirmed on the network.
   *
   * @param proofId - Proof identifier
   * @param timeoutMs - Maximum wait time (default: 5 minutes)
   * @returns True if confirmed, false if timeout
   */
  async waitForConfirmation(
    proofId: string,
    timeoutMs?: number
  ): Promise<boolean> {
    this.ensureConnected();
    return this.proofPublisher.waitForConfirmation(proofId, timeoutMs);
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Extract public inputs from a proof for verification result.
   */
  private extractPublicInputs(proof: AnyProof): Record<string, unknown> {
    const anyProof = proof as unknown as { publicInputs?: Record<string, unknown> };
    return anyProof.publicInputs ?? {};
  }

  /**
   * Debug logging helper.
   */
  private debug(message: string): void {
    if (this.options.debug) {
      console.log(`[DefaultMidnightProver] ${message}`);
    }
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a new DefaultMidnightProver instance.
 *
 * @param options - Configuration options
 * @returns New DefaultMidnightProver instance
 */
export function createMidnightProver(
  options?: CreateMidnightProverOptions
): DefaultMidnightProver {
  return new DefaultMidnightProver(options);
}

// =============================================================================
// REGISTER DEFAULT PROVER
// =============================================================================

// Register the default prover in the global registry
proverRegistry.register("default", () => new DefaultMidnightProver());
