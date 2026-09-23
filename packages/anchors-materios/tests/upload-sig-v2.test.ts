/**
 * materios-upload-v2 request signing. The gateway rebuilds the signing string
 * from the request it receives, so what the SDK signs must be byte-for-byte
 * what it sends. fixtures/upload-sig-v2-golden.json is shared verbatim with
 * materios-gateway (the verifier) and materios-operator-kit (the cert-daemon).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { hexToU8a, stringToU8a } from "@polkadot/util";
import type { KeyringPair } from "@polkadot/keyring/types";
import { buildAuthHeaders, uploadBlobs, uploadSigV2Message } from "../src/receipt.js";
import type { BlobGatewayConfig } from "../src/types.js";

interface GoldenVector {
  signer_uri: string;
  address: string;
  method: string;
  path: string;
  id: string;
  body: string;
  body_sha256: string;
  ts: number;
  signing_string: string;
  signatures: Record<"substrate-interface" | "polkadot-js", string>;
}

const GOLDEN: GoldenVector = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "upload-sig-v2-golden.json"), "utf-8"),
);

const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function alice(): Promise<KeyringPair> {
  await cryptoWaitReady();
  return new Keyring({ type: "sr25519" }).addFromUri(GOLDEN.signer_uri);
}

function signerGateway(pair: KeyringPair): BlobGatewayConfig {
  return {
    baseUrl: "https://materios.example/preprod-blobs",
    signerKeypair: { address: pair.address, sign: (m) => pair.sign(m) },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("golden vector", () => {
  it("builds the gateway's signing string from the same request parts", () => {
    expect(sha256hex(Buffer.from(GOLDEN.body, "utf-8"))).toBe(GOLDEN.body_sha256);
    expect(
      uploadSigV2Message({
        method: GOLDEN.method,
        path: GOLDEN.path,
        bodySha256: GOLDEN.body_sha256,
        id: GOLDEN.id,
        address: GOLDEN.address,
        ts: GOLDEN.ts,
      }),
    ).toBe(GOLDEN.signing_string);
  });

  it.each(["substrate-interface", "polkadot-js"] as const)("accepts the %s signature", async (signer) => {
    const pair = await alice();
    expect(pair.verify(GOLDEN.signing_string, hexToU8a(GOLDEN.signatures[signer]), pair.publicKey)).toBe(true);
  });

  it("signs the golden request so that the golden signing string verifies", async () => {
    const pair = await alice();
    vi.useFakeTimers({ toFake: ["Date"], now: GOLDEN.ts * 1000 });
    const headers = buildAuthHeaders(signerGateway(pair), {
      method: GOLDEN.method,
      path: GOLDEN.path,
      body: Buffer.from(GOLDEN.body, "utf-8"),
      id: GOLDEN.id,
    });
    expect(headers["x-upload-ts"]).toBe(String(GOLDEN.ts));
    expect(headers["x-uploader-address"]).toBe(GOLDEN.address);
    expect(pair.verify(GOLDEN.signing_string, hexToU8a(headers["x-upload-sig-v2"]), pair.publicKey)).toBe(true);
  });
});

describe("uploadBlobs", () => {
  it("signs every request with v1 and v2 over exactly what it sends", async () => {
    const pair = await alice();
    const sent: Array<{ url: string; method: string; headers: Record<string, string>; body: Uint8Array }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body: string | Uint8Array }) => {
        const body = typeof init.body === "string" ? Buffer.from(init.body, "utf-8") : init.body;
        sent.push({ url, method: init.method, headers: init.headers, body });
        return new Response("{}", { status: 200 });
      }),
    );
    const contentHash = "ab".repeat(32);
    const chunks = [
      { path: "chunks/0.bin", data: Buffer.from("first chunk") },
      { path: "chunks/1.bin", data: Buffer.from("second chunk é") },
    ];
    const manifest = {
      receipt_id: "0x" + "cd".repeat(32),
      content_hash: contentHash,
      total_size: 26,
      chunk_count: 2,
      chunks: [],
    };

    const result = await uploadBlobs("0x" + contentHash, manifest, chunks, signerGateway(pair));

    expect(result.success).toBe(true);
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST https://materios.example/preprod-blobs/blobs/${contentHash}/manifest`,
      `PUT https://materios.example/preprod-blobs/blobs/${contentHash}/chunks/0`,
      `PUT https://materios.example/preprod-blobs/blobs/${contentHash}/chunks/1`,
    ]);
    for (const r of sent) {
      const path = r.url.slice("https://materios.example/preprod-blobs".length);
      const ts = Number(r.headers["x-upload-ts"]);
      const v2 = uploadSigV2Message({
        method: r.method,
        path,
        bodySha256: sha256hex(r.body),
        id: contentHash,
        address: pair.address,
        ts,
      });
      expect(pair.verify(stringToU8a(v2), hexToU8a(r.headers["x-upload-sig-v2"]), pair.publicKey)).toBe(true);
      const v1 = `materios-upload-v1|${contentHash}|${pair.address}|${ts}`;
      expect(pair.verify(stringToU8a(v1), hexToU8a(r.headers["x-upload-sig"]), pair.publicKey)).toBe(true);
    }
    expect(new Set(sent.map((r) => r.headers["x-upload-sig"])).size).toBe(sent.length);
  });
});
