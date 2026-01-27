/**
 * @summary Unit tests for EIP-3009 utilities.
 *
 * Tests cover:
 * - Nonce generation (cryptographic randomness)
 * - Typed data building for EIP-712
 * - Validity calculation for time-bounded authorization
 * - Serialization/deserialization for HTTP transport
 * - Validation of authorization time bounds
 * - USDC domain configuration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateNonce,
  buildTypedData,
  calculateValidity,
  serializeAuthorization,
  deserializeAuthorization,
  encodeAuthorizationToBase64,
  decodeAuthorizationFromBase64,
  isAuthorizationValid,
  getUsdcDomainConfig,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_DOMAIN_CONFIG,
  type Eip3009Authorization,
} from "../eip3009.js";

// ---------------------------------------------------------------------------
// generateNonce Tests
// ---------------------------------------------------------------------------

describe("generateNonce", () => {
  it("should return a 32-byte hex string with 0x prefix", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("should generate unique nonces", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      nonces.add(generateNonce());
    }
    // All 100 nonces should be unique
    expect(nonces.size).toBe(100);
  });

  it("should be lowercase hex", () => {
    const nonce = generateNonce();
    expect(nonce).toBe(nonce.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// buildTypedData Tests
// ---------------------------------------------------------------------------

describe("buildTypedData", () => {
  const baseParams = {
    tokenName: "USD Coin",
    chainId: 8453,
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
    from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`,
    to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`,
    value: BigInt("1000000"),
  };

  it("should build valid EIP-712 typed data structure", () => {
    const typedData = buildTypedData(baseParams);

    expect(typedData.domain).toBeDefined();
    expect(typedData.types).toBeDefined();
    expect(typedData.primaryType).toBe("TransferWithAuthorization");
    expect(typedData.message).toBeDefined();
  });

  it("should set correct domain values", () => {
    const typedData = buildTypedData(baseParams);

    expect(typedData.domain.name).toBe("USD Coin");
    expect(typedData.domain.version).toBe("2"); // Default version
    expect(typedData.domain.chainId).toBe(BigInt(8453));
    expect(typedData.domain.verifyingContract).toBe(baseParams.tokenAddress);
  });

  it("should set correct message values", () => {
    const typedData = buildTypedData(baseParams);

    expect(typedData.message.from).toBe(baseParams.from);
    expect(typedData.message.to).toBe(baseParams.to);
    expect(typedData.message.value).toBe(baseParams.value);
  });

  it("should default validAfter to 0", () => {
    const typedData = buildTypedData(baseParams);
    expect(typedData.message.validAfter).toBe(BigInt(0));
  });

  it("should default validBefore to 1 hour from now", () => {
    const now = Math.floor(Date.now() / 1000);
    const typedData = buildTypedData(baseParams);
    const validBefore = Number(typedData.message.validBefore);

    // Should be approximately 1 hour from now (with some tolerance)
    expect(validBefore).toBeGreaterThan(now + 3590);
    expect(validBefore).toBeLessThan(now + 3610);
  });

  it("should accept custom validAfter and validBefore", () => {
    const typedData = buildTypedData({
      ...baseParams,
      validAfter: 1000,
      validBefore: 2000,
    });

    expect(typedData.message.validAfter).toBe(BigInt(1000));
    expect(typedData.message.validBefore).toBe(BigInt(2000));
  });

  it("should accept custom nonce", () => {
    const customNonce =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as `0x${string}`;
    const typedData = buildTypedData({
      ...baseParams,
      nonce: customNonce,
    });

    expect(typedData.message.nonce).toBe(customNonce);
  });

  it("should generate nonce if not provided", () => {
    const typedData = buildTypedData(baseParams);
    expect(typedData.message.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("should pad short nonces to 32 bytes", () => {
    const shortNonce = "0x1234" as `0x${string}`;
    const typedData = buildTypedData({
      ...baseParams,
      nonce: shortNonce,
    });

    // Should be padded to 64 hex chars
    expect(typedData.message.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(typedData.message.nonce).toContain("1234");
  });

  it("should accept string value and convert to bigint", () => {
    const typedData = buildTypedData({
      ...baseParams,
      value: "1000000",
    });

    expect(typedData.message.value).toBe(BigInt(1000000));
  });

  it("should include correct types structure", () => {
    const typedData = buildTypedData(baseParams);

    expect(typedData.types).toEqual(TRANSFER_WITH_AUTHORIZATION_TYPES);
  });
});

// ---------------------------------------------------------------------------
// calculateValidity Tests
// ---------------------------------------------------------------------------

describe("calculateValidity", () => {
  it("should return validAfter as 0 by default", () => {
    const { validAfter } = calculateValidity(3600);
    expect(validAfter).toBe(BigInt(0));
  });

  it("should return validBefore as now + timeout", () => {
    const now = Math.floor(Date.now() / 1000);
    const { validBefore } = calculateValidity(3600);

    // Should be approximately now + 3600 seconds
    expect(Number(validBefore)).toBeGreaterThan(now + 3590);
    expect(Number(validBefore)).toBeLessThan(now + 3610);
  });

  it("should accept custom startOffset", () => {
    const { validAfter } = calculateValidity(3600, 100);
    expect(validAfter).toBe(BigInt(100));
  });
});

// ---------------------------------------------------------------------------
// Serialization Tests
// ---------------------------------------------------------------------------

describe("serializeAuthorization", () => {
  const mockAuthorization: Eip3009Authorization = {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: BigInt(8453),
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    message: {
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: BigInt("1000000"),
      validAfter: BigInt(0),
      validBefore: BigInt(1700000000),
      nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    },
    signature:
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
  };

  it("should convert bigint values to strings", () => {
    const serialized = serializeAuthorization(mockAuthorization);

    expect(typeof serialized.value).toBe("string");
    expect(serialized.value).toBe("1000000");
    expect(typeof serialized.validAfter).toBe("string");
    expect(serialized.validAfter).toBe("0");
    expect(typeof serialized.validBefore).toBe("string");
    expect(serialized.validBefore).toBe("1700000000");
  });

  it("should convert chainId to number", () => {
    const serialized = serializeAuthorization(mockAuthorization);

    expect(typeof serialized.chainId).toBe("number");
    expect(serialized.chainId).toBe(8453);
  });

  it("should include all required fields", () => {
    const serialized = serializeAuthorization(mockAuthorization);

    expect(serialized.signature).toBeDefined();
    expect(serialized.from).toBeDefined();
    expect(serialized.to).toBeDefined();
    expect(serialized.value).toBeDefined();
    expect(serialized.validAfter).toBeDefined();
    expect(serialized.validBefore).toBeDefined();
    expect(serialized.nonce).toBeDefined();
    expect(serialized.chainId).toBeDefined();
    expect(serialized.contract).toBeDefined();
  });
});

describe("deserializeAuthorization", () => {
  const serialized = {
    signature:
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
    from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    value: "1000000",
    validAfter: "0",
    validBefore: "1700000000",
    nonce:
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    chainId: 8453,
    contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  };

  it("should convert string values to bigint", () => {
    const authorization = deserializeAuthorization(serialized);

    expect(typeof authorization.message.value).toBe("bigint");
    expect(authorization.message.value).toBe(BigInt(1000000));
    expect(typeof authorization.message.validAfter).toBe("bigint");
    expect(authorization.message.validAfter).toBe(BigInt(0));
    expect(typeof authorization.message.validBefore).toBe("bigint");
    expect(authorization.message.validBefore).toBe(BigInt(1700000000));
  });

  it("should throw for missing required fields", () => {
    expect(() =>
      deserializeAuthorization({ ...serialized, signature: undefined } as any)
    ).toThrow("Missing required field");
  });

  it("should roundtrip with serializeAuthorization", () => {
    const authorization = deserializeAuthorization(serialized);
    const reserialized = serializeAuthorization(authorization);

    expect(reserialized.value).toBe(serialized.value);
    expect(reserialized.from).toBe(serialized.from);
    expect(reserialized.to).toBe(serialized.to);
  });
});

// ---------------------------------------------------------------------------
// Base64 Encoding Tests
// ---------------------------------------------------------------------------

describe("encodeAuthorizationToBase64", () => {
  const mockAuthorization: Eip3009Authorization = {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: BigInt(8453),
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    message: {
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      value: BigInt("1000000"),
      validAfter: BigInt(0),
      validBefore: BigInt(1700000000),
      nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    },
    signature:
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
  };

  it("should return a valid base64 string", () => {
    const encoded = encodeAuthorizationToBase64(mockAuthorization);

    // Base64 should only contain valid characters
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("should be decodable back to authorization", () => {
    const encoded = encodeAuthorizationToBase64(mockAuthorization);
    const decoded = decodeAuthorizationFromBase64(encoded);

    expect(decoded.message.from).toBe(mockAuthorization.message.from);
    expect(decoded.message.to).toBe(mockAuthorization.message.to);
    expect(decoded.message.value).toBe(mockAuthorization.message.value);
  });
});

describe("decodeAuthorizationFromBase64", () => {
  it("should throw for invalid base64", () => {
    expect(() => decodeAuthorizationFromBase64("not-valid-base64!!!")).toThrow();
  });

  it("should throw for invalid JSON", () => {
    const invalidJson = Buffer.from("not json").toString("base64");
    expect(() => decodeAuthorizationFromBase64(invalidJson)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isAuthorizationValid Tests
// ---------------------------------------------------------------------------

describe("isAuthorizationValid", () => {
  it("should return valid for authorization in valid time window", () => {
    const now = Math.floor(Date.now() / 1000);
    const authorization: Eip3009Authorization = {
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: BigInt(8453),
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      message: {
        from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        value: BigInt("1000000"),
        validAfter: BigInt(0), // Valid immediately
        validBefore: BigInt(now + 3600), // Valid for 1 hour
        nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      },
      signature: "0xabcd",
    };

    const result = isAuthorizationValid(authorization);
    expect(result.isValid).toBe(true);
  });

  it("should return invalid for expired authorization", () => {
    const authorization: Eip3009Authorization = {
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: BigInt(8453),
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      message: {
        from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        value: BigInt("1000000"),
        validAfter: BigInt(0),
        validBefore: BigInt(1000000000), // Expired in the past
        nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      },
      signature: "0xabcd",
    };

    const result = isAuthorizationValid(authorization);
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("should return invalid for not-yet-valid authorization", () => {
    const now = Math.floor(Date.now() / 1000);
    const authorization: Eip3009Authorization = {
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: BigInt(8453),
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      message: {
        from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        value: BigInt("1000000"),
        validAfter: BigInt(now + 3600), // Not valid for 1 hour
        validBefore: BigInt(now + 7200),
        nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      },
      signature: "0xabcd",
    };

    const result = isAuthorizationValid(authorization);
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("not yet valid");
  });
});

// ---------------------------------------------------------------------------
// USDC Domain Config Tests
// ---------------------------------------------------------------------------

describe("USDC_DOMAIN_CONFIG", () => {
  it("should have config for common chains", () => {
    expect(USDC_DOMAIN_CONFIG[1]).toBeDefined(); // Ethereum
    expect(USDC_DOMAIN_CONFIG[8453]).toBeDefined(); // Base
    expect(USDC_DOMAIN_CONFIG[84532]).toBeDefined(); // Base Sepolia
    expect(USDC_DOMAIN_CONFIG[137]).toBeDefined(); // Polygon
    expect(USDC_DOMAIN_CONFIG[42161]).toBeDefined(); // Arbitrum
  });

  it("should have correct name and version for USDC", () => {
    const config = USDC_DOMAIN_CONFIG[8453];
    expect(config.name).toBe("USD Coin");
    expect(config.version).toBe("2");
  });
});

describe("getUsdcDomainConfig", () => {
  it("should return config for known chains", () => {
    const config = getUsdcDomainConfig(8453);
    expect(config.name).toBe("USD Coin");
    expect(config.version).toBe("2");
  });

  it("should return default config for unknown chains", () => {
    const config = getUsdcDomainConfig(999999);
    expect(config.name).toBe("USD Coin");
    expect(config.version).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// Type Constants Tests
// ---------------------------------------------------------------------------

describe("TRANSFER_WITH_AUTHORIZATION_TYPES", () => {
  it("should have correct type structure", () => {
    const types = TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization;

    expect(types).toHaveLength(6);
    expect(types.find((t) => t.name === "from")?.type).toBe("address");
    expect(types.find((t) => t.name === "to")?.type).toBe("address");
    expect(types.find((t) => t.name === "value")?.type).toBe("uint256");
    expect(types.find((t) => t.name === "validAfter")?.type).toBe("uint256");
    expect(types.find((t) => t.name === "validBefore")?.type).toBe("uint256");
    expect(types.find((t) => t.name === "nonce")?.type).toBe("bytes32");
  });
});
