import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bech32m } from "@scure/base";
import { createWalletMnemonicFile, ensurePrivateDir, walletAddresses } from "../src/keys.js";

// The test vector Midnight publishes for HD account 0, index 0 of this mnemonic.
const VECTOR = "volume kitchen portion ill mix service history renew candy chat pledge million prison gadget injury question song broccoli avocado envelope sugar seminar need picture";
const VECTOR_UNSHIELDED = "mn_addr1asyme6duwrv8qv7njpyqcxx7wmwqvq9dx5k07z9p0ew0g25tua3szfajwz";
const VECTOR_SHIELDED =
  "mn_shield-addr1y9j33qvpqxex6v8r676hawmzq4v5ekvltjxk92zhyvu6y0e084cmp2qjvm4z8uswze6fadrnahk7j7kmc8dcnfplv90t5jsm2faj3uqdreptm";

const dir = mkdtempSync(join(tmpdir(), "orynq-midnight-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const secretFile = (name: string, text: string, mode = 0o600) => {
  const path = join(dir, name);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
};
// bech32m words past the prefix; a shielded address is longer than the 90 characters BIP-173 allows.
const payload = (address: string) => bech32m.decode(address as `${string}1${string}`, 1023).words.join(",");

describe("wallet addresses derived from a mnemonic file", () => {
  const vector = secretFile("vector.mnemonic", `${VECTOR}\n`);

  it("reproduce Midnight's published test vector on mainnet", () => {
    const addresses = walletAddresses(vector, "mainnet");
    expect(addresses.unshielded).toBe(VECTOR_UNSHIELDED);
    expect(addresses.shielded).toBe(VECTOR_SHIELDED);
    expect(addresses.dust).toMatch(/^mn_dust1[02-9ac-hj-np-z]+$/);
  });

  it("carry the same keys under the preprod prefixes", () => {
    const main = walletAddresses(vector, "mainnet");
    const pre = walletAddresses(vector, "preprod");
    expect(pre.unshielded).toMatch(/^mn_addr_preprod1/);
    expect(pre.shielded).toMatch(/^mn_shield-addr_preprod1/);
    expect(pre.dust).toMatch(/^mn_dust_preprod1/);
    for (const role of ["unshielded", "shielded", "dust"] as const) expect(payload(pre[role])).toBe(payload(main[role]));
  });

  it("refuse a mnemonic file group or others can read, naming the path and never the words", () => {
    const open = secretFile("open.mnemonic", `${VECTOR}\n`, 0o644);
    expect(() => walletAddresses(open, "mainnet")).toThrow(/open\.mnemonic can be read or written by group or others/);
  });

  it("refuse a file that is not a BIP39 mnemonic without echoing what it holds", () => {
    const words = VECTOR.split(" ");
    const wrong = secretFile("wrong.mnemonic", `${[...words.slice(0, 23), words[0]].join(" ")}\n`);
    let message = "";
    try {
      walletAddresses(wrong, "mainnet");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/wrong\.mnemonic does not hold a valid 24-word BIP39 mnemonic/);
    for (const word of new Set(words)) expect(message.split(/[^a-z]+/)).not.toContain(word);
  });
});

describe("createWalletMnemonicFile", () => {
  it("writes a fresh 24-word mnemonic to a new file only its owner can read", () => {
    const a = join(dir, "a.mnemonic");
    const b = join(dir, "b.mnemonic");
    expect(createWalletMnemonicFile(a)).toBeUndefined();
    createWalletMnemonicFile(b);
    expect(statSync(a).mode & 0o777).toBe(0o600);
    const words = readFileSync(a, "utf8").trim();
    expect(words.split(" ")).toHaveLength(24);
    expect(validateMnemonic(words, wordlist)).toBe(true);
    expect(readFileSync(b, "utf8")).not.toBe(readFileSync(a, "utf8"));
    expect(walletAddresses(a, "preprod").unshielded).not.toBe(walletAddresses(b, "preprod").unshielded);
  });

  it("never replaces an existing file or writes through a symlink", () => {
    const kept = secretFile("kept.mnemonic", "keep\n");
    expect(() => createWalletMnemonicFile(kept)).toThrow(/kept\.mnemonic already exists/);
    expect(readFileSync(kept, "utf8")).toBe("keep\n");
    const link = join(dir, "link.mnemonic");
    symlinkSync(join(dir, "target.mnemonic"), link);
    expect(() => createWalletMnemonicFile(link)).toThrow(/link\.mnemonic already exists/);
    expect(() => lstatSync(join(dir, "target.mnemonic"))).toThrow();
  });
});

describe("ensurePrivateDir", () => {
  it("creates a directory only its owner can enter and accepts one that already is", () => {
    const created = join(dir, "secrets");
    ensurePrivateDir(created);
    expect(statSync(created).mode & 0o777).toBe(0o700);
    expect(() => ensurePrivateDir(created)).not.toThrow();
  });

  it("refuses a directory group or others can enter, and a symlink", () => {
    const open = join(dir, "open-dir");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => ensurePrivateDir(open)).toThrow(/open-dir can be entered by group or others/);
    const link = join(dir, "link-dir");
    symlinkSync(join(dir, "secrets"), link);
    expect(() => ensurePrivateDir(link)).toThrow(/link-dir is not a directory/);
  });
});
