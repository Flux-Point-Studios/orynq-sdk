import { afterAll, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as L from "@midnight-ntwrk/ledger-v8";
import { createWalletMnemonicFile } from "../src/keys.js";
import { openWallet, readWalletState, writeWalletState } from "../src/wallet.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const addresses = { unshielded: "mn_addr_preprod1a", shielded: "mn_shield-addr_preprod1a", dust: "mn_dust_preprod1a" };
const snapshot = { shielded: '{"s":1}', unshielded: '{"u":1}', dust: '{"d":1}' };
const HOSTED = "https://indexer.preprod.midnight.network/api/v3/graphql";

describe("the wallet's saved sync state", () => {
  it("is written only its owner can read, replaced atomically, and read back for the same wallet", () => {
    const file = join(dir, "a.state.json");
    writeWalletState(file, "preprod", addresses, HOSTED, snapshot);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeWalletState(file, "preprod", addresses, HOSTED, { ...snapshot, dust: '{"d":2}' });
    expect(readWalletState(file, "preprod", addresses, HOSTED)).toEqual({ ...snapshot, dust: '{"d":2}' });
  });

  it("is absent until a wallet first saves one", () => {
    expect(readWalletState(join(dir, "none.state.json"), "preprod", addresses, HOSTED)).toBeNull();
  });

  it("is refused for another wallet or another network, so two wallets never share one", () => {
    const file = join(dir, "b.state.json");
    writeWalletState(file, "preprod", addresses, HOSTED, snapshot);
    expect(() => readWalletState(file, "preprod", { ...addresses, dust: "mn_dust_preprod1b" }, HOSTED)).toThrow(/b\.state\.json was saved by another wallet/);
    expect(() => readWalletState(file, "mainnet", addresses, HOSTED)).toThrow(/b\.state\.json was saved on preprod, not mainnet/);
  });

  // Event ids differ between indexers: a state replayed against another indexer's events fails
  // on every update ("an update path that wasn't compatible with the tree") and never syncs.
  it("is refused for another indexer, whose event ids its offsets do not name", () => {
    const file = join(dir, "d.state.json");
    writeWalletState(file, "preprod", addresses, HOSTED, snapshot);
    expect(() => readWalletState(file, "preprod", addresses, "https://midnight-preprod.blockfrost.io/api/v0")).toThrow(
      /d\.state\.json was synced from https:\/\/indexer\.preprod\.midnight\.network\/api\/v3\/graphql, not https:\/\/midnight-preprod\.blockfrost\.io\/api\/v0/,
    );
  });

  it("is refused when group or others can read it", () => {
    const file = join(dir, "c.state.json");
    writeWalletState(file, "preprod", addresses, HOSTED, snapshot);
    chmodSync(file, 0o644);
    expect(() => readWalletState(file, "preprod", addresses, HOSTED)).toThrow(/c\.state\.json can be read or written by group or others/);
  });
});

// A real wallet over an indexer that never answers: it never syncs, but each sub-wallet still
// serializes the state it holds. On preprod, ledger-v8 8.1.3 trapped (RuntimeError: unreachable)
// inside ZswapLocalState.serialize after a landed anchor; the trap is injected here at the same call.
describe("saving a wallet's sync state", () => {
  const OFFLINE = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} };
  const open = async (name: string) => {
    const mnemonicFile = join(dir, `${name}.mnemonic`);
    createWalletMnemonicFile(mnemonicFile);
    const stateFile = join(dir, `${name}.state.json`);
    const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source: undefined as never, zkDir: "/nonexistent", stateFile });
    return { wallet, stateFile };
  };

  it("returns a failed part as a value, keeps the last good save byte for byte, and says the next open resumes from it", async () => {
    const { wallet, stateFile } = await open("trap");
    try {
      expect(await wallet.saveState()).toEqual({ saved: true });
      const good = readFileSync(stateFile);
      const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const trap = vi.spyOn(L.ZswapLocalState.prototype, "serialize").mockImplementation(() => {
        throw new WebAssembly.RuntimeError("unreachable");
      });
      try {
        expect(await wallet.saveState()).toEqual({ saved: false, failures: [{ part: "shielded", error: "ParseError: Could not serialize local state: RuntimeError: unreachable" }] });
        expect(loud).toHaveBeenCalledWith(
          `${stateFile}: the preprod wallet's sync state was not saved (shielded: ParseError: Could not serialize local state: RuntimeError: unreachable); the file keeps its last good save, and the next open resumes from it and replays the events since`,
        );
      } finally {
        trap.mockRestore();
        loud.mockRestore();
      }
      expect(readFileSync(stateFile).equals(good)).toBe(true);
      expect(existsSync(`${stateFile}.next`)).toBe(false);
      expect(await wallet.saveState()).toEqual({ saved: true });
    } finally {
      await wallet.close();
    }
  });

  // A directory where the next state file goes fails the write as root too, which CI runs as.
  it("returns a state file it cannot replace as a failure, leaving that file as it was", async () => {
    const { wallet, stateFile } = await open("blocked");
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await wallet.saveState()).toEqual({ saved: true });
      const good = readFileSync(stateFile);
      mkdirSync(`${stateFile}.next`);
      try {
        expect(await wallet.saveState()).toEqual({ saved: false, failures: [{ part: "file", error: expect.stringMatching(/EISDIR/) }] });
        expect(loud).toHaveBeenCalledWith(expect.stringMatching(/sync state was not saved \(file: .*EISDIR.*\); the file keeps its last good save/));
      } finally {
        rmdirSync(`${stateFile}.next`);
      }
      expect(readFileSync(stateFile).equals(good)).toBe(true);
    } finally {
      loud.mockRestore();
      await wallet.close();
    }
  });
});
