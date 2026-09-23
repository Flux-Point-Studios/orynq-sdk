import { describe, expect, it } from "vitest";
import { buildAuthHeaders } from "../receipt.js";

const REQUEST = {
  method: "POST",
  path: `/blobs/${"ab".repeat(32)}/manifest`,
  body: new TextEncoder().encode("{}"),
  id: "ab".repeat(32),
};

describe("buildAuthHeaders", () => {
  it("uses Authorization: Bearer for matra_-prefixed tokens (v6 gateway path)", () => {
    const headers = buildAuthHeaders(
      { baseUrl: "https://example/gateway", apiKey: "matra_abc123" },
      REQUEST,
    );
    expect(headers).toEqual({ Authorization: "Bearer matra_abc123" });
  });

  it("uses x-api-key for legacy (non-matra_) keys", () => {
    const headers = buildAuthHeaders(
      { baseUrl: "https://example/gateway", apiKey: "legacy-key-without-prefix" },
      REQUEST,
    );
    expect(headers).toEqual({ "x-api-key": "legacy-key-without-prefix" });
  });

  it("returns v1 and v2 sr25519 signature headers when no apiKey is provided", () => {
    const fakeSig = new Uint8Array(64).fill(0xab);
    const headers = buildAuthHeaders(
      {
        baseUrl: "https://example/gateway",
        signerKeypair: {
          address: "5FXCG7by7UuQZpbHMi1kRtQfgDSpA83D2GH82kaWHuMMFu2m",
          sign: () => fakeSig,
        },
      },
      REQUEST,
    );
    expect(headers["x-uploader-address"]).toBe(
      "5FXCG7by7UuQZpbHMi1kRtQfgDSpA83D2GH82kaWHuMMFu2m",
    );
    expect(headers["x-upload-sig"]).toBe("0x" + "ab".repeat(64));
    expect(headers["x-upload-sig-v2"]).toBe("0x" + "ab".repeat(64));
    expect(headers["x-upload-ts"]).toMatch(/^\d+$/);
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("x-api-key");
  });

  it("calls sign as a method of the signer, so a class-based signer keeps its state", () => {
    class ClassSigner {
      readonly address = "5FXCG7by7UuQZpbHMi1kRtQfgDSpA83D2GH82kaWHuMMFu2m";
      private readonly signature = new Uint8Array(64).fill(0xcd);
      sign(_message: Uint8Array): Uint8Array {
        return this.signature;
      }
    }
    const headers = buildAuthHeaders(
      { baseUrl: "https://example/gateway", signerKeypair: new ClassSigner() },
      REQUEST,
    );
    expect(headers["x-upload-sig"]).toBe("0x" + "cd".repeat(64));
    expect(headers["x-upload-sig-v2"]).toBe("0x" + "cd".repeat(64));
  });

  it("apiKey wins when both apiKey and signerKeypair are set", () => {
    const headers = buildAuthHeaders(
      {
        baseUrl: "https://example/gateway",
        apiKey: "matra_token_xyz",
        signerKeypair: {
          address: "5FXCG7by7UuQZpbHMi1kRtQfgDSpA83D2GH82kaWHuMMFu2m",
          sign: () => new Uint8Array(64),
        },
      },
      REQUEST,
    );
    expect(headers).toEqual({ Authorization: "Bearer matra_token_xyz" });
  });

  it("returns empty headers when neither apiKey nor signerKeypair is provided", () => {
    const headers = buildAuthHeaders(
      { baseUrl: "https://example/gateway" },
      REQUEST,
    );
    expect(headers).toEqual({});
  });
});
