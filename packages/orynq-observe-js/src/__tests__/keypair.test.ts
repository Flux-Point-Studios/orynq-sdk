/**
 * ObserverKeypair persistence + signing tests.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InvalidKeyfileError,
  ObserverKeypair,
} from "../keypair";

function tmpFile(suffix: string): string {
  const dir = mkdtempSync(join(tmpdir(), "orynq-observe-test-"));
  return join(dir, `obs${suffix}.json`);
}

describe("ObserverKeypair", () => {
  it("from-seed deterministic", async () => {
    const seed = "0x" + "ab".repeat(32);
    const a = await ObserverKeypair.fromSeedHex(seed);
    const b = await ObserverKeypair.fromSeedHex(seed);
    expect(a.publicHex).toBe(b.publicHex);
  });

  it("generate produces distinct keys", async () => {
    const a = await ObserverKeypair.generate();
    const b = await ObserverKeypair.generate();
    expect(a.publicHex).not.toBe(b.publicHex);
  });

  it("sign and verify roundtrip", async () => {
    const kp = await ObserverKeypair.fromSeedHex("0x" + "01".repeat(32));
    const payload = new TextEncoder().encode("hello-world");
    const sig = kp.signBytes(payload);
    expect(sig.length).toBe(64);
    expect(kp.verifyBytes(payload, sig)).toBe(true);
    const tampered = new TextEncoder().encode("hello-world!");
    expect(kp.verifyBytes(tampered, sig)).toBe(false);
  });

  it("save then load roundtrip", async () => {
    const kp = await ObserverKeypair.generate();
    const p = tmpFile("-roundtrip");
    kp.save(p);
    const loaded = await ObserverKeypair.load(p);
    expect(loaded.publicHex).toBe(kp.publicHex);
    expect(loaded.secretHex).toBe(kp.secretHex);
  });

  it("save sets mode 0600", async () => {
    const kp = await ObserverKeypair.generate();
    const p = tmpFile("-mode");
    kp.save(p);
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("load accepts legacy sr25519 scheme keyfile", async () => {
    const kp = await ObserverKeypair.generate();
    const p = tmpFile("-legacy");
    writeFileSync(
      p,
      JSON.stringify({
        scheme: "sr25519",
        public: kp.publicHex,
        secret: kp.secretHex,
      }),
    );
    const loaded = await ObserverKeypair.load(p);
    expect(loaded.publicHex).toBe(kp.publicHex);
  });

  it("load rejects unknown scheme", async () => {
    const p = tmpFile("-bad-scheme");
    writeFileSync(
      p,
      JSON.stringify({
        scheme: "ed25519",
        public: "00".repeat(32),
        secret: "00".repeat(64),
      }),
    );
    await expect(ObserverKeypair.load(p)).rejects.toBeInstanceOf(
      InvalidKeyfileError,
    );
  });

  it("ss58 address is the polkadot-encoded form", async () => {
    const kp = await ObserverKeypair.fromSeedHex("0x" + "ab".repeat(32));
    expect(typeof kp.ss58Address).toBe("string");
    expect(kp.ss58Address.length).toBeGreaterThan(40);
  });
});
