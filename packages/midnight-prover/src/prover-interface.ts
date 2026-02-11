/**
 * @fileoverview MidnightProver interface definition.
 *
 * Location: packages/midnight-prover/src/prover-interface.ts
 *
 * Summary:
 * This file defines the abstract interface for ZK proof generation using the Midnight network.
 * Implementations will connect to the Midnight proof server and generate various types of
 * zero-knowledge proofs for PoI trace verification.
 *
 * Usage:
 * The MidnightProver interface is implemented by concrete prover classes that connect to
 * the Midnight proof server. It integrates with:
 * - poi-process-trace: For TraceEvent and TraceBundle data
 * - poi-attestor: For AttestationBundle verification in ZK
 * - poi-anchors-cardano: For cross-chain binding to Cardano L1 anchors
 *
 * The prover is used after a trace is recorded and anchored on Cardano,
 * enabling privacy-preserving verification of trace properties.
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

/**
 * Abstract interface for Midnight ZK prover.
 *
 * The MidnightProver provides methods to:
 * 1. Connect to a Midnight proof server
 * 2. Generate various types of ZK proofs
 * 3. Publish proofs to the Midnight network
 * 4. Verify existing proofs
 *
 * All proofs are bound to a Cardano anchor transaction, creating a
 * cross-chain link between the PoI trace on Cardano and the ZK proof on Midnight.
 *
 * @example
 * ```typescript
 * import { MidnightProver, createMidnightProver } from '@fluxpointstudios/poi-sdk-midnight-prover';
 *
 * const prover = createMidnightProver();
 * await prover.connect({ proofServerUrl: 'https://proof.midnight.network', timeout: 300000, retries: 3 });
 *
 * // Generate hash chain proof
 * const proof = await prover.proveHashChain({
 *   events: traceBundle.privateRun.events,
 *   genesisHash: '0x00...00',
 *   expectedRootHash: traceBundle.rootHash,
 *   cardanoAnchorTxHash: 'abc123...',
 * });
 *
 * // Publish to Midnight
 * const result = await prover.publish(proof);
 * console.log('Published:', result.midnightTxHash);
 * ```
 */
export interface MidnightProver {
  // ===========================================================================
  // CONNECTION
  // ===========================================================================

  /**
   * Connect to the Midnight proof server.
   * Must be called before generating proofs.
   *
   * @param config - Proof server configuration
   * @throws MidnightProverException on connection failure
   */
  connect(config: ProofServerConfig): Promise<void>;

  /**
   * Disconnect from the proof server.
   * Releases any held resources.
   */
  disconnect(): Promise<void>;

  /**
   * Check if connected to the proof server.
   */
  isConnected(): boolean;

  /**
   * Get the current connection configuration.
   * Returns undefined if not connected.
   */
  getConfig(): ProofServerConfig | undefined;

  // ===========================================================================
  // PROOF GENERATION
  // ===========================================================================

  /**
   * Generate a hash chain validity proof.
   *
   * Proves that a sequence of events produces the expected rolling hash
   * without revealing the event contents. This is the most common proof type.
   *
   * @param input - Hash chain input with events and expected hash
   * @returns Hash chain proof with public inputs
   * @throws MidnightProverException on failure
   */
  proveHashChain(input: HashChainInput): Promise<HashChainProof>;

  /**
   * Generate a policy compliance proof.
   *
   * Proves that content passed a specified policy without revealing
   * the actual content. Useful for demonstrating compliance with
   * content moderation or safety policies.
   *
   * @param input - Policy input with content hashes and policy definition
   * @returns Policy compliance proof
   * @throws MidnightProverException on failure
   */
  provePolicyCompliance(input: PolicyInput): Promise<PolicyProof>;

  /**
   * Generate an attestation validity proof.
   *
   * Proves that a TEE attestation is valid and binds to the expected
   * hash, without revealing the full attestation evidence. This allows
   * verifying authenticity without exposing TEE-specific details.
   *
   * @param input - Attestation input with bundle and policy
   * @returns Attestation validity proof
   * @throws MidnightProverException on failure
   */
  proveAttestation(input: AttestationInput): Promise<AttestationProof>;

  /**
   * Generate a selective disclosure proof.
   *
   * Proves that a specific span exists in a trace bundle (via Merkle
   * membership) without revealing other spans. Optionally includes
   * the span data for full disclosure.
   *
   * @param input - Disclosure input with bundle and span ID
   * @returns Selective disclosure proof with optional span data
   * @throws MidnightProverException on failure
   */
  proveSelectiveDisclosure(input: DisclosureInput): Promise<DisclosureProof>;

  /**
   * Generate a zkML inference proof.
   *
   * WARNING: This is extremely expensive. Only use for high-stakes scenarios.
   *
   * Proves that a model produced a specific output for a given input,
   * demonstrating correctness of inference. Limited to small models
   * due to circuit constraints.
   *
   * @param input - Inference input with model and token data
   * @returns Inference proof with metrics
   * @throws MidnightProverException on failure (may be unsupported)
   */
  proveInference?(input: InferenceInput): Promise<InferenceProof>;

  // ===========================================================================
  // SAFETY PROOF GENERATION
  // ===========================================================================

  /**
   * Generate an eval awareness proof.
   *
   * Proves that an EAI (Eval Awareness Index) score exceeds a specified
   * threshold without revealing the actual score. This enables privacy-preserving
   * verification that a model meets safety awareness requirements.
   *
   * @param input - Eval awareness input with score, threshold, and method hash
   * @returns Eval awareness proof with public inputs
   * @throws MidnightProverException on failure
   */
  proveEvalAwareness(input: EvalAwarenessInput): Promise<EvalAwarenessProof>;

  /**
   * Generate a covert channel detection proof.
   *
   * Proves that a covert channel detector score exceeds a specified threshold
   * without revealing the actual score. This enables verification that a model
   * output has been checked for covert information channels.
   *
   * @param input - Covert channel input with detector score, threshold, and config hash
   * @returns Covert channel proof with public inputs
   * @throws MidnightProverException on failure
   */
  proveCovertChannel(input: CovertChannelInput): Promise<CovertChannelProof>;

  /**
   * Generate a monitor compliance proof.
   *
   * Proves that all required safety monitors ran for a given trace without
   * revealing individual monitor results. This enables verification that the
   * full monitoring suite was executed.
   *
   * @param input - Monitor compliance input with results and config hash
   * @returns Monitor compliance proof with public inputs
   * @throws MidnightProverException on failure
   */
  proveMonitorCompliance(input: MonitorComplianceInput): Promise<MonitorComplianceProof>;

  // ===========================================================================
  // PUBLICATION
  // ===========================================================================

  /**
   * Publish a proof to the Midnight network.
   *
   * The proof is recorded on-chain and linked to the Cardano anchor
   * specified in the proof's public inputs.
   *
   * @param proof - Any proof type to publish
   * @returns Publication result with Midnight transaction hash
   * @throws MidnightProverException on failure
   */
  publish(proof: AnyProof): Promise<PublicationResult>;

  // ===========================================================================
  // VERIFICATION
  // ===========================================================================

  /**
   * Verify a proof locally (without on-chain verification).
   *
   * This checks the proof's cryptographic validity but does not
   * verify on-chain publication or Cardano anchor linkage.
   *
   * @param proof - Proof to verify
   * @returns Verification result
   */
  verify(proof: AnyProof): Promise<ProofVerificationResult>;

  /**
   * Fetch a proof from the Midnight network by ID.
   *
   * @param proofId - Unique proof identifier
   * @returns The proof if found, undefined otherwise
   */
  fetchProof(proofId: string): Promise<AnyProof | undefined>;

  /**
   * Check if a proof has been published to Midnight.
   *
   * @param proofId - Unique proof identifier
   * @returns True if the proof exists on-chain
   */
  isPublished(proofId: string): Promise<boolean>;
}

/**
 * Factory function type for creating MidnightProver instances.
 */
export type MidnightProverFactory = () => MidnightProver;

/**
 * Options for creating a MidnightProver.
 */
export interface CreateMidnightProverOptions {
  /**
   * Enable debug logging.
   */
  debug?: boolean;

  /**
   * Custom circuit definitions directory.
   */
  circuitsDir?: string;

  /**
   * Enable zkML inference proofs (experimental).
   */
  enableInference?: boolean;
}

// =============================================================================
// ABSTRACT BASE CLASS
// =============================================================================

/**
 * Abstract base class for MidnightProver implementations.
 * Provides common functionality and state management.
 */
export abstract class AbstractMidnightProver implements MidnightProver {
  protected config: ProofServerConfig | undefined;
  protected connected = false;

  /**
   * Connect to the proof server.
   */
  async connect(config: ProofServerConfig): Promise<void> {
    this.config = config;
    await this.doConnect(config);
    this.connected = true;
  }

  /**
   * Disconnect from the proof server.
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.doDisconnect();
      this.connected = false;
    }
  }

  /**
   * Check connection status.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get current configuration.
   */
  getConfig(): ProofServerConfig | undefined {
    return this.config;
  }

  /**
   * Ensure connected before operations.
   * @throws MidnightProverException if not connected
   */
  protected ensureConnected(): void {
    if (!this.connected) {
      throw new Error("Not connected to proof server. Call connect() first.");
    }
  }

  // Abstract methods for subclasses to implement
  protected abstract doConnect(config: ProofServerConfig): Promise<void>;
  protected abstract doDisconnect(): Promise<void>;

  abstract proveHashChain(input: HashChainInput): Promise<HashChainProof>;
  abstract provePolicyCompliance(input: PolicyInput): Promise<PolicyProof>;
  abstract proveAttestation(input: AttestationInput): Promise<AttestationProof>;
  abstract proveSelectiveDisclosure(input: DisclosureInput): Promise<DisclosureProof>;
  abstract proveInference?(input: InferenceInput): Promise<InferenceProof>;
  abstract proveEvalAwareness(input: EvalAwarenessInput): Promise<EvalAwarenessProof>;
  abstract proveCovertChannel(input: CovertChannelInput): Promise<CovertChannelProof>;
  abstract proveMonitorCompliance(input: MonitorComplianceInput): Promise<MonitorComplianceProof>;
  abstract publish(proof: AnyProof): Promise<PublicationResult>;
  abstract verify(proof: AnyProof): Promise<ProofVerificationResult>;
  abstract fetchProof(proofId: string): Promise<AnyProof | undefined>;
  abstract isPublished(proofId: string): Promise<boolean>;
}

// =============================================================================
// REGISTRY
// =============================================================================

/**
 * Registry for MidnightProver implementations.
 * Allows pluggable prover backends.
 */
export interface MidnightProverRegistry {
  /**
   * Register a prover factory.
   *
   * @param name - Unique name for this prover backend
   * @param factory - Factory function to create the prover
   */
  register(name: string, factory: MidnightProverFactory): void;

  /**
   * Get a prover by name.
   *
   * @param name - Name of the registered prover
   * @returns Prover instance or undefined if not found
   */
  get(name: string): MidnightProver | undefined;

  /**
   * Get the default prover.
   *
   * @returns Default prover instance
   * @throws Error if no default is registered
   */
  getDefault(): MidnightProver;

  /**
   * List registered prover names.
   */
  listProvers(): string[];

  /**
   * Set the default prover name.
   *
   * @param name - Name of the prover to use as default
   */
  setDefault(name: string): void;
}

/**
 * Default implementation of MidnightProverRegistry.
 */
export class DefaultMidnightProverRegistry implements MidnightProverRegistry {
  private factories = new Map<string, MidnightProverFactory>();
  private defaultName: string | undefined;

  register(name: string, factory: MidnightProverFactory): void {
    this.factories.set(name, factory);
    // First registered becomes default
    if (this.defaultName === undefined) {
      this.defaultName = name;
    }
  }

  get(name: string): MidnightProver | undefined {
    const factory = this.factories.get(name);
    if (factory === undefined) {
      return undefined;
    }
    return factory();
  }

  getDefault(): MidnightProver {
    if (this.defaultName === undefined) {
      throw new Error("No prover registered");
    }
    const prover = this.get(this.defaultName);
    if (prover === undefined) {
      throw new Error(`Default prover '${this.defaultName}' not found`);
    }
    return prover;
  }

  listProvers(): string[] {
    return Array.from(this.factories.keys());
  }

  setDefault(name: string): void {
    if (!this.factories.has(name)) {
      throw new Error(`Prover '${name}' not registered`);
    }
    this.defaultName = name;
  }
}

/**
 * Global prover registry instance.
 */
export const proverRegistry = new DefaultMidnightProverRegistry();
