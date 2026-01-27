/**
 * @summary Payer and Signer interface definitions for payment execution.
 *
 * This file defines the abstract interfaces that payer implementations must satisfy.
 * The Signer interface handles cryptographic operations, while the Payer interface
 * handles the complete payment flow including balance checks and transaction building.
 *
 * Used by:
 * - Chain-specific payer implementations (Cardano, EVM)
 * - Payment middleware for automatic payment handling
 * - Client SDKs for browser and Node.js environments
 */

import type { ChainId, PaymentProof, PaymentRequest } from "./payment.js";

// ---------------------------------------------------------------------------
// Signer Interface
// ---------------------------------------------------------------------------

/**
 * Low-level cryptographic signing interface.
 *
 * Implementations handle key management and signature generation.
 * This is typically implemented by wallet adapters or key management systems.
 */
export interface Signer {
  /**
   * Get the signing address for a specific chain.
   *
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to the address in chain-native format
   * @throws If the signer does not support the specified chain
   */
  getAddress(chain: ChainId): Promise<string>;

  /**
   * Sign arbitrary binary data.
   *
   * @param payload - Data to sign as Uint8Array
   * @param chain - CAIP-2 chain identifier for chain-specific signing
   * @returns Promise resolving to the signature as Uint8Array
   * @throws If signing fails or chain is not supported
   */
  sign(payload: Uint8Array, chain: ChainId): Promise<Uint8Array>;

  /**
   * Sign a human-readable message (EIP-191 style for EVM, CIP-8 for Cardano).
   *
   * @param message - UTF-8 string message to sign
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to the signature as hex string
   * @throws If message signing is not supported or fails
   */
  signMessage?(message: string, chain: ChainId): Promise<string>;
}

// ---------------------------------------------------------------------------
// Payer Interface
// ---------------------------------------------------------------------------

/**
 * High-level payment execution interface.
 *
 * Payer implementations handle the complete payment flow:
 * 1. Check if they support the requested chain/asset
 * 2. Verify sufficient balance
 * 3. Build and sign the transaction
 * 4. Submit and return proof
 *
 * Implementations may be chain-specific (CardanoPayer, EvmPayer) or
 * aggregate multiple chains (MultiChainPayer).
 */
export interface Payer {
  /**
   * List of CAIP-2 chain IDs this payer supports.
   * Used for quick filtering before attempting payment.
   */
  readonly supportedChains: readonly ChainId[];

  /**
   * Check if this payer can handle the given payment request.
   *
   * This should verify:
   * - Chain is supported
   * - Asset is supported on the chain
   * - Any other protocol-specific requirements
   *
   * @param request - Payment request to evaluate
   * @returns true if this payer can handle the request
   */
  supports(request: PaymentRequest): boolean;

  /**
   * Get the payment address for a specific chain.
   *
   * @param chain - CAIP-2 chain identifier
   * @returns Promise resolving to the address
   * @throws If chain is not supported
   */
  getAddress(chain: ChainId): Promise<string>;

  /**
   * Execute a payment and return proof.
   *
   * This method should:
   * 1. Build the transaction according to the request
   * 2. Sign the transaction
   * 3. Submit to the network (unless facilitator handles this)
   * 4. Return appropriate proof type
   *
   * @param request - Payment request to execute
   * @returns Promise resolving to payment proof
   * @throws InsufficientBalanceError if balance is too low
   * @throws PaymentFailedError if transaction fails
   * @throws PaymentTimeoutError if submission times out
   */
  pay(request: PaymentRequest): Promise<PaymentProof>;

  /**
   * Get the current balance for an asset on a chain.
   *
   * @param chain - CAIP-2 chain identifier
   * @param asset - Asset identifier (native symbol or contract/policy)
   * @returns Promise resolving to balance in atomic units as bigint
   * @throws If chain or asset is not supported
   */
  getBalance(chain: ChainId, asset: string): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// Node Payer Configuration
// ---------------------------------------------------------------------------

/**
 * Supported blockchain data provider types for Node.js payers.
 */
export type ProviderType = "blockfrost" | "koios" | "custom";

/**
 * Configuration for Node.js payer implementations.
 *
 * Node payers run server-side and require explicit provider configuration
 * for blockchain data access and transaction submission.
 */
export interface NodePayerConfig {
  /** Signer implementation for key management */
  signer: Signer;

  /** Blockchain data provider type */
  provider: ProviderType;

  /**
   * Provider-specific configuration.
   *
   * For Blockfrost:
   * - projectId: Blockfrost project ID
   * - network?: "mainnet" | "preprod" | "preview"
   *
   * For Koios:
   * - baseUrl?: Custom Koios endpoint
   * - network?: "mainnet" | "preprod" | "preview"
   *
   * For custom:
   * - baseUrl: Provider endpoint
   * - apiKey?: API key if required
   */
  providerConfig: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Browser Payer Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for browser-based payer implementations.
 *
 * Browser payers typically integrate with wallet extensions or WalletConnect.
 */
export interface BrowserPayerConfig {
  /**
   * Wallet identifier for CIP-30 wallets (e.g., "nami", "eternl", "lace")
   * or WalletConnect project ID for EVM wallets.
   */
  wallet: string;

  /**
   * Preferred chain IDs to use.
   * If multiple are supported, the first matching chain is used.
   */
  preferredChains?: ChainId[];

  /**
   * Auto-connect on initialization.
   * @default false
   */
  autoConnect?: boolean;
}

// ---------------------------------------------------------------------------
// Payer Factory Types
// ---------------------------------------------------------------------------

/**
 * Factory function type for creating payer instances.
 */
export type PayerFactory<TConfig = unknown> = (
  config: TConfig
) => Payer | Promise<Payer>;

/**
 * Registry of payer factories by chain family.
 */
export interface PayerRegistry {
  /** Register a payer factory for a chain family */
  register(chainFamily: string, factory: PayerFactory): void;

  /** Get a payer for a specific chain */
  get(chain: ChainId): Payer | undefined;

  /** Get all registered payers */
  all(): readonly Payer[];
}
