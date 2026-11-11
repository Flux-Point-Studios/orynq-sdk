import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deleteSealingKey, sealSecret, unsealSecret } from "../src/sealing.js";

const keyName = () => `orynq-test-${randomBytes(6).toString("hex")}`;

const powershell = (script: string): string =>
  execFileSync(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim();

describe.runIf(process.platform === "win32")("TPM sealing key", { timeout: 60_000 }, () => {
  const created: string[] = [];
  const named = () => {
    const name = keyName();
    created.push(name);
    return name;
  };
  afterEach(() => {
    const failures = created.splice(0).flatMap((name) => {
      try {
        deleteSealingKey(name);
        return [];
      } catch (error) {
        return [error];
      }
    });
    if (failures.length > 0) throw new AggregateError(failures, "TPM test keys left behind");
  });

  it("unseals exactly the secret it sealed", () => {
    const name = named();
    const secret = randomBytes(74);
    expect(unsealSecret(name, sealSecret(name, secret))).toEqual(secret);
  });

  it("keeps the key in the Platform Crypto Provider with export forbidden", () => {
    const name = named();
    sealSecret(name, randomBytes(32));
    const report = powershell(
      `$k = [System.Security.Cryptography.CngKey]::Open('${name}', [System.Security.Cryptography.CngProvider]::new('Microsoft Platform Crypto Provider'));` +
        `try { $k.Export([System.Security.Cryptography.CngKeyBlobFormat]::GenericPrivateBlob) | Out-Null; 'exported' } catch { 'refused' }; $k.ExportPolicy`,
    );
    expect(report.split(/\r?\n/)).toEqual(["refused", "None"]);
  });

  it("reuses one key across seals of the same name", () => {
    const name = named();
    const first = randomBytes(32);
    const second = randomBytes(32);
    const sealedFirst = sealSecret(name, first);
    const sealedSecond = sealSecret(name, second);
    expect(unsealSecret(name, sealedFirst)).toEqual(first);
    expect(unsealSecret(name, sealedSecond)).toEqual(second);
  });

  it("refuses to unseal under a different key", () => {
    const sealed = sealSecret(named(), randomBytes(32));
    const other = named();
    sealSecret(other, randomBytes(32));
    expect(() => unsealSecret(other, sealed)).toThrow(/NCryptDecrypt/);
  });

  it("refuses a tampered blob", () => {
    const name = named();
    const sealed = sealSecret(name, randomBytes(32));
    sealed[sealed.length - 1] ^= 0x01;
    expect(() => unsealSecret(name, sealed)).toThrow(/NCryptDecrypt/);
  });

  it("refuses to unseal when no key has that name", () => {
    expect(() => unsealSecret(keyName(), randomBytes(256))).toThrow(/NCryptOpenKey/);
  });

  it("refuses a secret larger than one OAEP block", () => {
    expect(() => sealSecret(keyName(), randomBytes(191))).toThrow(/at most 190 bytes/);
  });
});
