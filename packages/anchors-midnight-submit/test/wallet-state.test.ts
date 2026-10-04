import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWalletState, writeWalletState } from "../src/wallet.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const addresses = { unshielded: "mn_addr_preprod1a", shielded: "mn_shield-addr_preprod1a", dust: "mn_dust_preprod1a" };
const snapshot = { shielded: '{"s":1}', unshielded: '{"u":1}', dust: '{"d":1}' };

describe("the wallet's saved sync state", () => {
  it("is written only its owner can read, replaced atomically, and read back for the same wallet", () => {
    const file = join(dir, "a.state.json");
    writeWalletState(file, "preprod", addresses, snapshot);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeWalletState(file, "preprod", addresses, { ...snapshot, dust: '{"d":2}' });
    expect(readWalletState(file, "preprod", addresses)).toEqual({ ...snapshot, dust: '{"d":2}' });
  });

  it("is absent until a wallet first saves one", () => {
    expect(readWalletState(join(dir, "none.state.json"), "preprod", addresses)).toBeNull();
  });

  it("is refused for another wallet or another network, so two wallets never share one", () => {
    const file = join(dir, "b.state.json");
    writeWalletState(file, "preprod", addresses, snapshot);
    expect(() => readWalletState(file, "preprod", { ...addresses, dust: "mn_dust_preprod1b" })).toThrow(/b\.state\.json was saved by another wallet/);
    expect(() => readWalletState(file, "mainnet", addresses)).toThrow(/b\.state\.json was saved on preprod, not mainnet/);
  });

  it("is refused when group or others can read it", () => {
    const file = join(dir, "c.state.json");
    writeWalletState(file, "preprod", addresses, snapshot);
    chmodSync(file, 0o644);
    expect(() => readWalletState(file, "preprod", addresses)).toThrow(/c\.state\.json can be read or written by group or others/);
  });
});
