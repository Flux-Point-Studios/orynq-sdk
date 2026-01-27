/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-evm-x402/src/eip3009.ts
 * @summary EIP-3009 "Transfer With Authorization" utilities for gasless token transfers.
 *
 * EIP-3009 enables gasless token transfers where:
 * - Token holder signs an authorization off-chain (no gas required)
 * - Any party can execute the transfer on-chain using the signature
 * - Time-bounded validity prevents replay after expiration
 * - Nonce-based replay protection within validity period
 *
 * This is used by x402 protocol for gasless payment UX:
 * 1. Buyer signs EIP-3009 authorization
 * 2. Server/facilitator calls transferWithAuthorization
 * 3. Tokens transfer atomically, buyer pays no gas
 *
 * References:
 * - EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
 * - EIP-712: https://eips.ethereum.org/EIPS/eip-712
 *
 * Used by:
 * - x402-payer.ts for creating payment signatures
 * - Server-side verification of x402 payment proofs
 */

import type { Account } from "viem";

// ---------------------------------------------------------------------------
// EIP-3009 Type Definitions
// ---------------------------------------------------------------------------

/**
 * EIP-712 typed data structure for TransferWithAuthorization.
 *
 * This matches the exact structure expected by USDC and other EIP-3009
 * compatible tokens for signature verification.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * EIP-712 domain parameters for token contracts.
 */
export interface Eip712Domain {
  /** Token name (e.g., "USD Coin") */
  name: string;
  /** Domain version (typically "1" or "2" for USDC) */
  version: string;
  /** EVM chain ID */
  chainId: bigint;
  /** Token contract address */
  verifyingContract: `0x${string}`;
}

/**
 * TransferWithAuthorization message parameters.
 */
export interface TransferWithAuthorizationMessage {
  /** Address authorizing the transfer (token holder) */
  from: `0x${string}`;
  /** Address receiving the tokens */
  to: `0x${string}`;
  /** Amount to transfer in atomic units */
  value: bigint;
  /** Unix timestamp after which authorization is valid (0 = immediately) */
  validAfter: bigint;
  /** Unix timestamp before which authorization is valid */
  validBefore: bigint;
  /** Unique 32-byte nonce for replay protection */
  nonce: `0x${string}`;
}

/**
 * Complete EIP-3009 authorization with signature.
 */
export interface Eip3009Authorization {
  /** The typed data domain */
  domain: Eip712Domain;
  /** The authorization message */
  message: TransferWithAuthorizationMessage;
  /** The EIP-712 signature */
  signature: `0x${string}`;
}

/**
 * Parameters for building EIP-3009 typed data.
 */
export interface BuildTypedDataParams {
  /** Token name for EIP-712 domain */
  tokenName: string;
  /** Domain version (typically "2" for USDC) */
  version?: string;
  /** EVM chain ID */
  chainId: number | bigint;
  /** Token contract address */
  tokenAddress: `0x${string}`;
  /** Address authorizing the transfer */
  from: `0x${string}`;
  /** Address receiving the tokens */
  to: `0x${string}`;
  /** Amount in atomic units */
  value: bigint | string;
  /** Unix timestamp after which valid (default: 0 = immediately) */
  validAfter?: number | bigint;
  /** Unix timestamp before which valid (default: 1 hour from now) */
  validBefore?: number | bigint;
  /** Custom nonce (default: random 32 bytes) */
  nonce?: `0x${string}`;
}

/**
 * Serialized authorization payload for HTTP transport.
 */
export interface SerializedAuthorization {
  /** EIP-712 signature */
  signature: string;
  /** Payer address */
  from: string;
  /** Recipient address */
  to: string;
  /** Amount in atomic units (string for precision) */
  value: string;
  /** Valid after timestamp */
  validAfter: string;
  /** Valid before timestamp */
  validBefore: string;
  /** 32-byte nonce (hex) */
  nonce: string;
  /** EVM chain ID */
  chainId: number;
  /** Token contract address */
  contract: string;
}

// ---------------------------------------------------------------------------
// Nonce Generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure random nonce for EIP-3009.
 *
 * Uses Web Crypto API when available, falls back to Math.random for
 * environments without crypto (should never be used in production).
 *
 * @returns 32-byte nonce as hex string with 0x prefix
 *
 * @example
 * ```typescript
 * const nonce = generateNonce();
 * // "0xa1b2c3d4e5f6...64 hex chars total"
 * ```
 */
export function generateNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);

  // Use Web Crypto API if available (browser and modern Node.js)
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback for environments without crypto (not recommended for production)
    console.warn(
      "Web Crypto API not available, using Math.random for nonce generation. " +
        "This is NOT cryptographically secure."
    );
    for (let i = 0; i < 32; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return ("0x" + bytesToHex(bytes)) as `0x${string}`;
}

// ---------------------------------------------------------------------------
// Typed Data Building
// ---------------------------------------------------------------------------

/**
 * Build EIP-712 typed data for TransferWithAuthorization.
 *
 * Creates the complete typed data structure needed for EIP-712 signing.
 * Handles default values for validAfter, validBefore, and nonce.
 *
 * @param params - Parameters for the authorization
 * @returns Object with domain, types, primaryType, and message
 *
 * @example
 * ```typescript
 * const typedData = buildTypedData({
 *   tokenName: "USD Coin",
 *   chainId: 8453,
 *   tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
 *   from: "0x...",
 *   to: "0x...",
 *   value: 1000000n, // 1 USDC
 * });
 *
 * // Sign with viem account
 * const signature = await account.signTypedData(typedData);
 * ```
 */
export function buildTypedData(params: BuildTypedDataParams): {
  domain: Eip712Domain;
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  primaryType: "TransferWithAuthorization";
  message: TransferWithAuthorizationMessage;
} {
  const {
    tokenName,
    version = "2",
    chainId,
    tokenAddress,
    from,
    to,
    value,
    validAfter = 0,
    validBefore,
    nonce,
  } = params;

  // Convert values to bigint
  const valueBigInt = typeof value === "string" ? BigInt(value) : value;
  const chainIdBigInt =
    typeof chainId === "number" ? BigInt(chainId) : chainId;
  const validAfterBigInt =
    typeof validAfter === "number" ? BigInt(validAfter) : validAfter;

  // Default validBefore to 1 hour from now if not specified
  const defaultValidBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const validBeforeBigInt =
    validBefore !== undefined
      ? typeof validBefore === "number"
        ? BigInt(validBefore)
        : validBefore
      : defaultValidBefore;

  // Generate nonce if not provided
  const nonceValue = nonce ?? generateNonce();

  // Ensure nonce is 32 bytes (64 hex chars + 0x prefix)
  const paddedNonce = padNonce(nonceValue);

  return {
    domain: {
      name: tokenName,
      version,
      chainId: chainIdBigInt,
      verifyingContract: tokenAddress,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from,
      to,
      value: valueBigInt,
      validAfter: validAfterBigInt,
      validBefore: validBeforeBigInt,
      nonce: paddedNonce,
    },
  };
}

/**
 * Calculate validity timestamps for EIP-3009 authorization.
 *
 * @param timeoutSeconds - How long the authorization should be valid
 * @param startOffset - Offset from now for validAfter (default: 0)
 * @returns Object with validAfter and validBefore as bigint
 *
 * @example
 * ```typescript
 * const { validAfter, validBefore } = calculateValidity(3600); // 1 hour
 * // validAfter = 0n (immediately valid)
 * // validBefore = current time + 3600 seconds
 * ```
 */
export function calculateValidity(
  timeoutSeconds: number,
  startOffset = 0
): { validAfter: bigint; validBefore: bigint } {
  const now = Math.floor(Date.now() / 1000);
  return {
    validAfter: BigInt(startOffset), // 0 means immediately valid
    validBefore: BigInt(now + timeoutSeconds),
  };
}

// ---------------------------------------------------------------------------
// Signing Helpers
// ---------------------------------------------------------------------------

/**
 * Sign EIP-3009 authorization using a viem Account.
 *
 * This is a convenience function that builds typed data and signs it
 * using the account's signTypedData method.
 *
 * @param account - Viem account with signTypedData support
 * @param params - Authorization parameters
 * @returns Complete authorization with signature
 * @throws Error if account doesn't support signTypedData
 *
 * @example
 * ```typescript
 * const authorization = await signAuthorization(account, {
 *   tokenName: "USD Coin",
 *   chainId: 8453,
 *   tokenAddress: "0x...",
 *   from: account.address,
 *   to: "0x...",
 *   value: 1000000n,
 * });
 *
 * // Use authorization.signature in payment header
 * ```
 */
export async function signAuthorization(
  account: Account,
  params: BuildTypedDataParams
): Promise<Eip3009Authorization> {
  if (!account.signTypedData) {
    throw new Error(
      "Account does not support signTypedData. " +
        "EIP-712 typed data signing is required for EIP-3009 authorizations."
    );
  }

  const typedData = buildTypedData(params);

  const signature = await account.signTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });

  return {
    domain: typedData.domain,
    message: typedData.message,
    signature,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize an EIP-3009 authorization for HTTP transport.
 *
 * Converts bigint values to strings for JSON serialization and
 * returns a structure suitable for base64 encoding.
 *
 * @param authorization - Complete authorization with signature
 * @returns Serializable authorization object
 *
 * @example
 * ```typescript
 * const serialized = serializeAuthorization(authorization);
 * const payload = btoa(JSON.stringify(serialized));
 * // Use payload in X-PAYMENT-SIGNATURE header
 * ```
 */
export function serializeAuthorization(
  authorization: Eip3009Authorization
): SerializedAuthorization {
  return {
    signature: authorization.signature,
    from: authorization.message.from,
    to: authorization.message.to,
    value: authorization.message.value.toString(),
    validAfter: authorization.message.validAfter.toString(),
    validBefore: authorization.message.validBefore.toString(),
    nonce: authorization.message.nonce,
    chainId: Number(authorization.domain.chainId),
    contract: authorization.domain.verifyingContract,
  };
}

/**
 * Deserialize an authorization payload from HTTP transport.
 *
 * Converts string values back to appropriate types for verification.
 *
 * @param data - Serialized authorization (from JSON parse of base64)
 * @returns Parsed authorization with bigint values
 * @throws Error if data is malformed
 *
 * @example
 * ```typescript
 * const json = atob(header);
 * const serialized = JSON.parse(json);
 * const authorization = deserializeAuthorization(serialized);
 * ```
 */
export function deserializeAuthorization(
  data: SerializedAuthorization
): Eip3009Authorization {
  // Validate required fields
  const requiredFields = [
    "signature",
    "from",
    "to",
    "value",
    "validAfter",
    "validBefore",
    "nonce",
    "chainId",
    "contract",
  ] as const;

  for (const field of requiredFields) {
    if (data[field] === undefined || data[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  return {
    domain: {
      name: "USD Coin", // Default for USDC
      version: "2",
      chainId: BigInt(data.chainId),
      verifyingContract: data.contract as `0x${string}`,
    },
    message: {
      from: data.from as `0x${string}`,
      to: data.to as `0x${string}`,
      value: BigInt(data.value),
      validAfter: BigInt(data.validAfter),
      validBefore: BigInt(data.validBefore),
      nonce: data.nonce as `0x${string}`,
    },
    signature: data.signature as `0x${string}`,
  };
}

/**
 * Encode an authorization as a base64 string for HTTP headers.
 *
 * @param authorization - Complete authorization with signature
 * @returns Base64-encoded JSON string
 */
export function encodeAuthorizationToBase64(
  authorization: Eip3009Authorization
): string {
  const serialized = serializeAuthorization(authorization);
  const json = JSON.stringify(serialized);
  return stringToBase64(json);
}

/**
 * Decode an authorization from a base64 HTTP header value.
 *
 * @param base64 - Base64-encoded authorization
 * @returns Parsed authorization
 * @throws Error if base64 or JSON is invalid
 */
export function decodeAuthorizationFromBase64(
  base64: string
): Eip3009Authorization {
  const json = base64ToString(base64);
  const data = JSON.parse(json) as SerializedAuthorization;
  return deserializeAuthorization(data);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check if an authorization is currently valid (time-bounded check).
 *
 * @param authorization - Authorization to validate
 * @returns Object with isValid boolean and optional reason
 *
 * @example
 * ```typescript
 * const { isValid, reason } = isAuthorizationValid(authorization);
 * if (!isValid) {
 *   console.error(`Authorization invalid: ${reason}`);
 * }
 * ```
 */
export function isAuthorizationValid(authorization: Eip3009Authorization): {
  isValid: boolean;
  reason?: string;
} {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const { validAfter, validBefore } = authorization.message;

  if (now < validAfter) {
    return {
      isValid: false,
      reason: `Authorization not yet valid. Valid after ${validAfter.toString()}`,
    };
  }

  if (now >= validBefore) {
    return {
      isValid: false,
      reason: `Authorization expired. Valid before ${validBefore.toString()}`,
    };
  }

  return { isValid: true };
}

// ---------------------------------------------------------------------------
// USDC-Specific Configuration
// ---------------------------------------------------------------------------

/**
 * USDC contract configurations for EIP-3009.
 *
 * Circle's USDC implementation uses version "2" for the EIP-712 domain.
 */
export const USDC_DOMAIN_CONFIG: Record<
  number,
  { name: string; version: string }
> = {
  /** Ethereum Mainnet */
  1: { name: "USD Coin", version: "2" },
  /** Base Mainnet */
  8453: { name: "USD Coin", version: "2" },
  /** Base Sepolia */
  84532: { name: "USD Coin", version: "2" },
  /** Polygon Mainnet */
  137: { name: "USD Coin", version: "2" },
  /** Arbitrum One */
  42161: { name: "USD Coin", version: "2" },
};

/**
 * Get USDC domain configuration for a chain.
 *
 * @param chainId - EVM chain ID
 * @returns Domain name and version, or defaults
 */
export function getUsdcDomainConfig(chainId: number): {
  name: string;
  version: string;
} {
  return USDC_DOMAIN_CONFIG[chainId] ?? { name: "USD Coin", version: "2" };
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Convert Uint8Array to hex string (without 0x prefix).
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Pad a nonce to 32 bytes (64 hex chars + 0x prefix).
 */
function padNonce(nonce: `0x${string}`): `0x${string}` {
  const hex = nonce.slice(2);
  if (hex.length === 64) {
    return nonce;
  }
  return ("0x" + hex.padStart(64, "0")) as `0x${string}`;
}

/**
 * Convert string to base64 (works in browser and Node.js).
 */
function stringToBase64(str: string): string {
  if (typeof btoa === "function") {
    return btoa(str);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf-8").toString("base64");
  }
  throw new Error("No base64 encoding available");
}

/**
 * Convert base64 to string (works in browser and Node.js).
 */
function base64ToString(base64: string): string {
  if (typeof atob === "function") {
    return atob(base64);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64, "base64").toString("utf-8");
  }
  throw new Error("No base64 decoding available");
}
