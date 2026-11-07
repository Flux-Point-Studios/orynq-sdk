import { afterAll, describe, expect, it, vi } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import fs, { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "@midnightntwrk/ledger-v8";
import { FacadeState, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { Subject, finalize } from "rxjs";
import { createWalletMnemonicFile, walletAddresses } from "../src/keys.js";
import { WALLET_STATE_FORMAT, moveLegacyWalletState, openWallet, readWalletState, writeWalletState, type WalletSnapshot } from "../src/wallet.js";
import { liveSource } from "./fakes.js";
import { DatabaseSync } from "node:sqlite";
import { TTL_MARGIN_MILLIS, openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";

// A source for a wallet opened in another process: a node and an indexer of one chain.
const SAME_CHAIN_SOURCE = `{ indexer: { blockAt: async (height) => ({ height, hash: "00".repeat(32) }) }, node: { call: async () => "0x" + "00".repeat(32) } }`;

const dir = mkdtempSync(join(tmpdir(), "orynq-wallet-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const addresses = { unshielded: "mn_addr_preprod1a", shielded: "mn_shield-addr_preprod1a", dust: "mn_dust_preprod1a" };
const snapshot = { shielded: '{"s":1}', unshielded: '{"u":1}', dust: '{"d":1}' };
const HOSTED = "https://indexer.preprod.midnight.network/api/v3/graphql";
const walletModule = fileURLToPath(new URL("../src/wallet.ts", import.meta.url));

// Every file a save of the state file could leave beside it: its name plus a suffix.
const leftovers = (stateFile: string) => readdirSync(dirname(stateFile)).filter((name) => name.startsWith(`${basename(stateFile)}.`));

// Replaces a node:fs function for every module, those importing it by name included, until the
// returned function puts it back.
function intercept<K extends "fsyncSync" | "renameSync">(name: K, wrap: (real: (typeof fs)[K]) => (typeof fs)[K]): () => void {
  const real = fs[name];
  (fs as Record<K, unknown>)[name] = wrap(real);
  syncBuiltinESMExports();
  return () => {
    (fs as Record<K, unknown>)[name] = real;
    syncBuiltinESMExports();
  };
}

// Saves `saved` with writeWalletState in a child process that stops at its first call to `stopAt`
// until released: at writeFileSync its temporary file exists and is still empty, at renameSync
// that file is complete. Two of them interleave two processes' saves exactly.
const stoppedSave = (stateFile: string, saved: WalletSnapshot, stopAt: "writeFileSync" | "renameSync") => {
  const gate = mkdtempSync(join(dir, "gate-"));
  let exited = false;
  let child!: ChildProcess;
  const done = new Promise<{ status: number | string; signal: string | null; stdout: string; stderr: string }>((resolve) => {
    child = execFile(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import fs from "node:fs";
         import { syncBuiltinESMExports } from "node:module";
         import { writeWalletState } from ${JSON.stringify(walletModule)};
         const [file, saved, stopAt, gate] = process.argv.slice(1);
         const real = fs[stopAt];
         fs[stopAt] = (...args) => {
           fs[stopAt] = real;
           syncBuiltinESMExports();
           fs.writeFileSync(gate + "/stopped", "");
           const nap = new Int32Array(new SharedArrayBuffer(4));
           while (!fs.existsSync(gate + "/go")) Atomics.wait(nap, 0, 0, 10);
           return real(...args);
         };
         syncBuiltinESMExports();
         writeWalletState(file, "preprod", ${JSON.stringify(addresses)}, ${JSON.stringify(HOSTED)}, JSON.parse(saved));
         console.log("saved");`,
        stateFile,
        JSON.stringify(saved),
        stopAt,
        gate,
      ],
      { encoding: "utf8", env: { ...process.env, TSX_DISABLE_CACHE: "1" }, timeout: 100_000 },
      (error, stdout, stderr) => {
        exited = true;
        resolve({ status: error ? (error.code ?? 0) : 0, signal: error?.signal ?? null, stdout, stderr });
      },
    );
  });
  const stopped = (async () => {
    while (!existsSync(join(gate, "stopped"))) {
      if (exited) throw new Error(`the save exited before it stopped at ${stopAt}: ${(await done).stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  return { stopped, done, release: () => writeFileSync(join(gate, "go"), ""), kill: () => child.kill("SIGKILL") };
};

describe("the wallet's saved sync state", () => {
  it("is written only its owner can read, replaced atomically, and read back for the same wallet", () => {
    const file = join(dir, "a.state.json");
    writeWalletState(file, "preprod", addresses, HOSTED, snapshot);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeWalletState(file, "preprod", addresses, HOSTED, { ...snapshot, dust: '{"d":2}' });
    expect(readWalletState(file, "preprod", addresses, HOSTED)).toEqual({ ...snapshot, dust: '{"d":2}' });
  });

  // Renamed into place first, the state file could survive a crash naming data that never
  // reached the disk.
  it("is flushed to disk whole before it is renamed over the state file", () => {
    const file = join(dir, "flushed.state.json");
    const order: string[] = [];
    const restoreFsync = intercept("fsyncSync", (real) => (fd) => {
      const { ino, size } = fstatSync(fd);
      order.push(`fsync ${ino} ${size}`);
      real(fd);
    });
    const restoreRename = intercept("renameSync", (real) => (from, to) => {
      order.push(`rename ${statSync(from).ino}`);
      real(from, to);
    });
    try {
      writeWalletState(file, "preprod", addresses, HOSTED, snapshot);
    } finally {
      restoreRename();
      restoreFsync();
    }
    const { ino, size } = statSync(file);
    expect(order).toEqual([`fsync ${ino} ${size}`, `rename ${ino}`]);
  });

  // The interleaving a shared temporary file turns into an empty state file: A's new file is
  // complete and about to be renamed while B's has been created and holds nothing yet.
  it("is replaced by two processes saving at once only with each one's own complete save", async () => {
    const stateFile = join(dir, "shared.state.json");
    const first = { ...snapshot, dust: '{"d":"first"}' };
    const second = { ...snapshot, dust: '{"d":"second"}' };
    const a = stoppedSave(stateFile, first, "renameSync");
    await a.stopped;
    const b = stoppedSave(stateFile, second, "writeFileSync");
    try {
      await b.stopped;
      a.release();
      expect(await a.done).toMatchObject({ status: 0, stdout: "saved\n" });
      expect(readWalletState(stateFile, "preprod", addresses, HOSTED)).toEqual(first);
      b.release();
      expect(await b.done).toMatchObject({ status: 0, stdout: "saved\n" });
      expect(readWalletState(stateFile, "preprod", addresses, HOSTED)).toEqual(second);
      expect(leftovers(stateFile)).toEqual([]);
    } finally {
      a.kill();
      b.kill();
    }
  });

  it("is absent until a wallet first saves one", () => {
    expect(readWalletState(join(dir, "none.state.json"), "preprod", addresses, HOSTED)).toBeNull();
  });

  it.each([
    ["mnemonic", "synthetic words that are not a wallet phrase"],
    ["key", "d".repeat(64)],
    ["project-id", `mainnet${"e".repeat(32)}`],
  ])("names a mistaken %s file without quoting its contents", (name, contents) => {
    const file = join(dir, `${name}.not-json`);
    writeFileSync(file, contents!, { mode: 0o600 });
    let message = "";
    try {
      readWalletState(file, "preprod", addresses, HOSTED);
    } catch (error) {
      message = (error as Error).message;
    }
    expect({
      safeDiagnostic: message === `${file} is not JSON; move it aside to sync from genesis`,
      quotesContents: message.includes(contents!.slice(0, 10)),
    }).toEqual({ safeDiagnostic: true, quotesContents: false });
  });

  it.each(["network", "indexer"])("does not quote an unexpected saved %s", (field) => {
    const file = join(dir, `${field}.state.json`);
    const contents = "synthetic-private-value";
    writeFileSync(file, JSON.stringify({ format: WALLET_STATE_FORMAT, network: "preprod", indexer: HOSTED, addresses, ...snapshot, [field]: contents }), { mode: 0o600 });
    let message = "";
    try {
      readWalletState(file, "preprod", addresses, HOSTED);
    } catch (error) {
      message = (error as Error).message;
    }
    expect({ namesFile: message.includes(file), namesField: message.includes(field), quotesContents: message.includes(contents) })
      .toEqual({ namesFile: true, namesField: true, quotesContents: false });
  });

  it("is refused for another wallet or another network, so two wallets never share one", () => {
    const file = join(dir, "b.state.json");
    writeWalletState(file, "preprod", addresses, HOSTED, snapshot);
    for (const role of ["unshielded", "shielded", "dust"] as const) {
      expect(() => readWalletState(file, "preprod", { ...addresses, [role]: `${addresses[role]}b` }, HOSTED)).toThrow(/b\.state\.json was saved by another wallet/);
    }
    expect(() => readWalletState(file, "mainnet", addresses, HOSTED)).toThrow(/b\.state\.json was saved on another network/);
  });

  // Event ids differ between indexers: a state replayed against another indexer's events fails
  // on every update ("an update path that wasn't compatible with the tree") and never syncs.
  it("is refused for another indexer, whose event ids its offsets do not name", () => {
    const file = join(dir, "d.state.json");
    writeWalletState(file, "preprod", addresses, HOSTED, snapshot);
    expect(() => readWalletState(file, "preprod", addresses, "https://midnight-preprod.blockfrost.io/api/v0")).toThrow(
      /d\.state\.json was synced from another indexer/,
    );
  });

  it("is written in the wallet-sdk 2.x state format, and a file in any other is refused", () => {
    const file = join(dir, "format.state.json");
    writeWalletState(file, "preprod", addresses, HOSTED, snapshot);
    expect(JSON.parse(readFileSync(file, "utf8")).format).toBe("orynq-midnight-wallet-state/wallet-sdk-2");
    for (const format of [undefined, "orynq-midnight-wallet-state/wallet-sdk-3"]) {
      writeFileSync(file, JSON.stringify({ format, network: "preprod", indexer: HOSTED, addresses, ...snapshot }), { mode: 0o600 });
      expect(() => readWalletState(file, "preprod", addresses, HOSTED)).toThrow(`${file} was not saved by this wallet's wallet-sdk 2.x state format; move it aside to sync from genesis`);
    }
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
  const open = async (name: string, stateFile = join(dir, `${name}.state.json`)) => {
    const mnemonicFile = join(dir, `${name}.mnemonic`);
    if (!existsSync(mnemonicFile)) createWalletMnemonicFile(mnemonicFile);
    const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source: liveSource(), zkDir: "/nonexistent", stateFile });
    return { wallet, stateFile };
  };
  const trapSerialize = () =>
    vi.spyOn(L.ZswapLocalState.prototype, "serialize").mockImplementation(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });

  it("cancels the actual timed sync subscription when the service aborts", async () => {
    const { wallet } = await open("cancel-sync"); let unsubscribed = false;
    const source = new Subject<FacadeState>();
    const state = vi.spyOn(WalletFacade.prototype, "state").mockReturnValue(source.pipe(finalize(() => { unsubscribed = true; })));
    const abort = new AbortController(); let failed = false;
    const pending = wallet.waitForSync(180 * 60_000, abort.signal); pending.catch(() => { failed = true; });
    try {
      abort.abort(); await new Promise(resolve => setImmediate(resolve));
      expect(failed).toBe(true); await expect(pending).rejects.toThrow(/interrupted/i); expect(unsubscribed).toBe(true);
    } finally { source.complete(); state.mockRestore(); await wallet.close(); }
  });
  const TRAPPED = { saved: false, failures: [{ part: "shielded", error: "ParseError: Could not serialize local state: RuntimeError" }] };
  const trappedLine = (stateFile: string) =>
    `${stateFile}: the preprod wallet's sync state was not saved (shielded: ParseError: Could not serialize local state: RuntimeError); the file keeps its last good save, and the next open resumes from it and replays the events since`;

  it("returns a failed part as a value, keeps the last good save byte for byte, and says the next open resumes from it", async () => {
    const { wallet, stateFile } = await open("trap");
    try {
      expect(await wallet.saveState()).toEqual({ saved: true });
      const good = readFileSync(stateFile);
      const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const trap = trapSerialize();
      try {
        expect(await wallet.saveState()).toEqual(TRAPPED);
        expect(loud).toHaveBeenCalledWith(trappedLine(stateFile));
      } finally {
        trap.mockRestore();
        loud.mockRestore();
      }
      expect(readFileSync(stateFile).equals(good)).toBe(true);
      expect(leftovers(stateFile)).toEqual([]);
      expect(await wallet.saveState()).toEqual({ saved: true });
    } finally {
      await wallet.close();
    }
  });

  // No indexer answers here, so the wallet is made to report itself synced, which is what has
  // close() save.
  it("returns from close() a synced wallet's failed save as a value, leaving the last good save byte for byte", async () => {
    const { wallet, stateFile } = await open("closing");
    expect(await wallet.saveState()).toEqual({ saved: true });
    const good = readFileSync(stateFile);
    const synced = vi.spyOn(FacadeState.prototype, "isSynced", "get").mockReturnValue(true);
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const trap = trapSerialize();
    try {
      expect(await wallet.close()).toEqual(TRAPPED);
      expect(loud).toHaveBeenCalledWith(trappedLine(stateFile));
    } finally {
      trap.mockRestore();
      loud.mockRestore();
      synced.mockRestore();
    }
    expect(readFileSync(stateFile).equals(good)).toBe(true);
    expect(leftovers(stateFile)).toEqual([]);
  });

  // A checkpoint and close() can save at once: each save serializes only once the one before it is
  // in place, so a state serialized earlier never replaces one serialized later.
  it("runs one wallet's saves one at a time", async () => {
    const { wallet } = await open("serial");
    const order: string[] = [];
    const real = L.ZswapLocalState.prototype.serialize;
    const serialize = vi.spyOn(L.ZswapLocalState.prototype, "serialize").mockImplementation(function (this: L.ZswapLocalState) {
      order.push("serialize");
      return real.call(this);
    });
    const restoreRename = intercept("renameSync", (realRename) => (from, to) => {
      order.push("rename");
      realRename(from, to);
    });
    try {
      expect(await Promise.all([wallet.saveState(), wallet.saveState()])).toEqual([{ saved: true }, { saved: true }]);
    } finally {
      restoreRename();
      serialize.mockRestore();
      await wallet.close();
    }
    expect(order).toEqual(["serialize", "rename", "serialize", "rename"]);
  });

  // Bytes a sub-wallet serialized but cannot read back would fail every later open.
  it.each([
    ["shielded", L.ZswapLocalState],
    ["dust", L.DustLocalState],
  ] as const)("installs only a state the %s wallet restores from, leaving the last good save byte for byte otherwise", async (part, State) => {
    const { wallet, stateFile } = await open(`unreadable-${part}`);
    try {
      expect(await wallet.saveState()).toEqual({ saved: true });
      const good = readFileSync(stateFile);
      const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const garbled = vi.spyOn(State.prototype as { serialize(): Uint8Array }, "serialize").mockReturnValue(new Uint8Array([1, 2, 3]));
      try {
        expect(await wallet.saveState()).toEqual({ saved: false, failures: [{ part, error: expect.stringMatching(/deserialize/) }] });
        expect(loud).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`sync state was not saved \\(${part}: .*deserialize.*\\); the file keeps its last good save`)));
      } finally {
        garbled.mockRestore();
        loud.mockRestore();
      }
      expect(readFileSync(stateFile).equals(good)).toBe(true);
      expect(leftovers(stateFile)).toEqual([]);
    } finally {
      await wallet.close();
    }
  });

  // Reading a DUST state of megabytes back takes tens of seconds.
  it("reads each saved part back once at open", async () => {
    const { wallet } = await open("read-once");
    expect(await wallet.saveState()).toEqual({ saved: true });
    await wallet.close();
    const reads = [vi.spyOn(L.ZswapLocalState, "deserialize"), vi.spyOn(L.DustLocalState, "deserialize")];
    try {
      await (await open("read-once")).wallet.close();
      expect(reads.map((read) => read.mock.calls.length)).toEqual([1, 1]);
    } finally {
      for (const read of reads) read.mockRestore();
    }
  });

  it("refuses at open a state file a sub-wallet does not restore from, naming the file and never quoting the state", async () => {
    const { wallet, stateFile } = await open("unrestorable");
    expect(await wallet.saveState()).toEqual({ saved: true });
    await wallet.close();
    const saved = readWalletState(stateFile, "preprod", wallet.addresses, OFFLINE.indexer)!;
    writeWalletState(stateFile, "preprod", wallet.addresses, OFFLINE.indexer, { ...saved, shielded: '{"publicKeys":"c01dc0ffee"}' });
    const refused = await open("unrestorable").then(
      () => null,
      (error: Error) => error.message,
    );
    expect(refused).toMatch(new RegExp(`^${stateFile.replaceAll(".", "\\.")} does not restore \\(shielded: .+\\); move it aside to sync from genesis$`));
    expect(refused).not.toContain("c01dc0ffee");
  });

  it.each(["shielded", "dust"] as const)("never quotes a corrupt %s ledger header in a restore error", async part => {
    const { wallet, stateFile } = await open(`bad-header-${part}`);
    expect(await wallet.saveState()).toEqual({ saved: true });
    await wallet.close();
    const saved = readWalletState(stateFile, "preprod", wallet.addresses, OFFLINE.indexer)!;
    const corrupt = JSON.parse(saved[part]);
    const secret = "synthetic-private-header-value";
    corrupt.state = Buffer.from(secret + "x".repeat(100)).toString("hex");
    writeWalletState(stateFile, "preprod", wallet.addresses, OFFLINE.indexer, { ...saved, [part]: JSON.stringify(corrupt) });
    const message = await open(`bad-header-${part}`).then(() => "", (error: Error) => error.message);
    expect(message).toContain("Could not deserialize local state");
    expect(message).not.toContain(secret.slice(0, 10));
    expect(message).not.toContain(corrupt.state.slice(0, 10));
  });

  // A directory at the state file's path fails the rename as root too, which CI runs as.
  it("returns a state file it cannot replace as a failure, leaving that path as it was and nothing beside it", async () => {
    const { wallet, stateFile } = await open("blocked");
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mkdirSync(stateFile);
      try {
        expect(await wallet.saveState()).toEqual({ saved: false, failures: [{ part: "file", error: expect.stringMatching(/EISDIR/) }] });
        expect(loud).toHaveBeenCalledWith(expect.stringMatching(/sync state was not saved \(file: .*EISDIR.*\); the file keeps its last good save/));
        expect(readdirSync(stateFile)).toEqual([]);
        expect(leftovers(stateFile)).toEqual([]);
      } finally {
        rmdirSync(stateFile);
      }
    } finally {
      loud.mockRestore();
      await wallet.close();
    }
  });

  it.each([
    { label: "known", code: "ENOSPC", expected: "Error: ENOSPC" },
    { label: "unknown", code: "synthetic-private-error-code", expected: "Error" },
  ])("keeps only safe filesystem codes in a $label save failure", async ({ label, code, expected }) => {
    const { wallet, stateFile } = await open(`file-code-${label}`);
    expect(await wallet.saveState()).toEqual({ saved: true });
    const good = readFileSync(stateFile);
    const secret = "synthetic-private-state-in-error";
    const loud = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const restoreRename = intercept("renameSync", () => () => {
      throw Object.assign(new Error(secret), { code, path: secret, dest: secret, syscall: secret });
    });
    try {
      expect(await wallet.saveState()).toEqual({ saved: false, failures: [{ part: "file", error: expected }] });
      expect(loud.mock.calls.flat().join("\n")).not.toContain(secret);
      expect(loud.mock.calls.flat().join("\n")).not.toContain("synthetic-private-error-code");
      expect(readFileSync(stateFile)).toEqual(good);
      expect(leftovers(stateFile)).toEqual([]);
    } finally {
      restoreRename();
      loud.mockRestore();
      await wallet.close();
    }
  });

  it("refuses at open a state file in a directory that does not exist, where no save could land", async () => {
    await expect(open("homeless", join(dir, "missing", "homeless.state.json"))).rejects.toThrow(/ENOENT: no such file or directory, scandir '.*\/missing'/);
  });

  // Process 1 always runs: a caller other than root may not signal it, which is how a save by
  // another user looks.
  it("removes at open the temporary file of a save whose process died, never one still being written", async () => {
    const stateFile = join(dir, "abandoned.state.json");
    const killed = stoppedSave(stateFile, snapshot, "renameSync");
    await killed.stopped;
    killed.kill();
    expect(await killed.done).toMatchObject({ signal: "SIGKILL" });
    const [abandoned] = leftovers(stateFile);
    const another = abandoned!.replace(/\.\d+\.([0-9a-f]{16})\.next$/, ".1.$1.next");
    writeFileSync(join(dir, another), "");
    await (await open("abandoned")).wallet.close();
    expect(leftovers(stateFile)).toEqual([another]);
    rmSync(join(dir, another));

    const running = stoppedSave(stateFile, snapshot, "writeFileSync");
    try {
      await running.stopped;
      const inFlight = leftovers(stateFile);
      expect(inFlight).toHaveLength(1);
      await (await open("abandoned")).wallet.close();
      expect(leftovers(stateFile)).toEqual(inFlight);
      running.release();
      expect(await running.done).toMatchObject({ status: 0, stdout: "saved\n" });
    } finally {
      running.kill();
    }
    expect(readWalletState(stateFile, "preprod", addresses, HOSTED)).toEqual(snapshot);
    expect(leftovers(stateFile)).toEqual([]);
  });

  // Opens the wallet over no indexer and saves its state once, in a child process. `capped` keeps
  // that process's files from growing past one block (512 bytes under dash, 1 KiB under bash):
  // past the limit write(2) returns a short count instead of failing, as on a full disk or a
  // spent quota.
  const saveOnce = (mnemonicFile: string, stateFile: string, capped: boolean) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
      execFile(
        "/bin/sh",
        [
          "-c",
          `${capped ? "ulimit -f 1 && " : ""}exec "$@"`,
          "sh",
          process.execPath,
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { openWallet } from ${JSON.stringify(walletModule)};
           const [mnemonicFile, stateFile] = process.argv.slice(1);
           const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: ${JSON.stringify(OFFLINE)}, source: ${SAME_CHAIN_SOURCE}, zkDir: "/nonexistent", stateFile });
           console.log(JSON.stringify(await wallet.saveState()));
           await wallet.close();`,
          mnemonicFile,
          stateFile,
        ],
        { encoding: "utf8", env: { ...process.env, TSX_DISABLE_CACHE: "1" } },
        (error, stdout, stderr) => resolve({ status: error ? Number(error.code) : 0, stdout, stderr }),
      ),
    );

  // deploy-mainnet and anchor-mainnet open one wallet over one state file, and may run at once.
  it("is shared by two processes of one wallet saving it at once: every read finds one whole save, and the last restores", async () => {
    const { wallet, stateFile } = await open("two-runs");
    expect(await wallet.saveState()).toEqual({ saved: true });
    await wallet.close();
    const savesOf = () =>
      new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
        execFile(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `import { openWallet } from ${JSON.stringify(walletModule)};
             const [mnemonicFile, stateFile] = process.argv.slice(1);
             const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: ${JSON.stringify(OFFLINE)}, source: ${SAME_CHAIN_SOURCE}, zkDir: "/nonexistent", stateFile });
             const saved = [];
             for (let i = 0; i < 10; i++) saved.push((await wallet.saveState()).saved);
             await wallet.close();
             console.log(JSON.stringify(saved));`,
            join(dir, "two-runs.mnemonic"),
            stateFile,
          ],
          { encoding: "utf8", env: { ...process.env, TSX_DISABLE_CACHE: "1" } },
          (error, stdout, stderr) => resolve({ status: error ? Number(error.code) : 0, stdout, stderr }),
        ),
      );
    let running = true;
    const runs = Promise.all([savesOf(), savesOf()]).finally(() => (running = false));
    let reads = 0;
    while (running) {
      expect(readWalletState(stateFile, "preprod", wallet.addresses, OFFLINE.indexer)).not.toBeNull();
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const allSaved = `${JSON.stringify(Array(10).fill(true))}\n`;
    expect(await runs).toEqual([expect.objectContaining({ status: 0, stdout: allSaved }), expect.objectContaining({ status: 0, stdout: allSaved })]);
    expect(reads).toBeGreaterThan(0);
    expect(leftovers(stateFile)).toEqual([]);
    await (await open("two-runs")).wallet.close();
  });

  it("returns a write the file system cuts short as a failure, leaving the last good save byte for byte", async () => {
    const mnemonicFile = join(dir, "cut.mnemonic");
    createWalletMnemonicFile(mnemonicFile);
    const stateFile = join(dir, "cut.state.json");
    expect(await saveOnce(mnemonicFile, stateFile, false)).toMatchObject({ status: 0, stdout: `${JSON.stringify({ saved: true })}\n` });
    const good = readFileSync(stateFile);
    expect(good.length).toBeGreaterThan(1024);

    const cut = await saveOnce(mnemonicFile, stateFile, true);
    expect(cut.status).toBe(0);
    expect(JSON.parse(cut.stdout)).toEqual({ saved: false, failures: [{ part: "file", error: "Error: EFBIG" }] });
    expect(cut.stderr).toContain(
      `${stateFile}: the preprod wallet's sync state was not saved (file: Error: EFBIG); the file keeps its last good save, and the next open resumes from it and replays the events since\n`,
    );
    expect(readFileSync(stateFile).equals(good)).toBe(true);
    expect(leftovers(stateFile)).toEqual([]);
  });
});

// wallet-sdk 2.x cannot restore what wallet-sdk 1.x saved: its DUST state predates every ledger 9
// event, and 2.x rebuilds the DUST state from the chain.
describe("a state file wallet-sdk 1.x saved", () => {
  const legacy = (name: string) => {
    const file = join(dir, `${name}.state.json`);
    writeFileSync(file, JSON.stringify({ network: "preprod", indexer: HOSTED, addresses, ...snapshot }), { mode: 0o600 });
    return { file, bytes: readFileSync(file) };
  };

  it("is moved aside beside the state file, byte for byte, and nothing else is", () => {
    const { file, bytes } = legacy("legacy-move");
    expect(moveLegacyWalletState(file, [])).toBe(`${file}.wallet-sdk-1`);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.wallet-sdk-1`)).toEqual(bytes);
    const current = join(dir, "current.state.json");
    writeWalletState(current, "preprod", addresses, HOSTED, snapshot);
    expect(moveLegacyWalletState(current, [])).toBeNull();
    expect(moveLegacyWalletState(join(dir, "absent.state.json"), [])).toBeNull();
    const garbled = join(dir, "garbled.state.json");
    writeFileSync(garbled, "not json", { mode: 0o600 });
    expect(moveLegacyWalletState(garbled, [])).toBeNull();
    expect(existsSync(garbled)).toBe(true);
  });

  it("is never moved over an earlier one", () => {
    const { file, bytes } = legacy("legacy-twice");
    writeFileSync(`${file}.wallet-sdk-1`, "earlier", { mode: 0o600 });
    expect(() => moveLegacyWalletState(file, [])).toThrow(`${file} was saved by wallet-sdk 1.x and ${file}.wallet-sdk-1 already exists; move one of them before opening the wallet`);
    expect(readFileSync(file)).toEqual(bytes);
    expect(readFileSync(`${file}.wallet-sdk-1`, "utf8")).toBe("earlier");
  });

  // A sync from genesis offers again every coin a fee in flight spent, which the wallet then spends
  // a second time and the node refuses (DustDoubleSpend): the move waits for the journals.
  const held = (minutes: number) => ({ txHash: "ab".repeat(32), ttl: new Date(Date.now() + minutes * 60_000) });

  it("is not moved while a fee the wallet paid may still land", () => {
    const { file, bytes } = legacy("legacy-held");
    const inFlight = held(-4);
    expect(() => moveLegacyWalletState(file, [inFlight])).toThrow(`${file} was saved by wallet-sdk 1.x while the fee ${inFlight.txHash} the wallet paid may still land, until ${new Date(inFlight.ttl.getTime() + TTL_MARGIN_MILLIS).toISOString()}; a sync from genesis would spend its DUST again, so the state file stays until the journal settles it`);
    expect(readFileSync(file)).toEqual(bytes);
    expect(existsSync(`${file}.wallet-sdk-1`)).toBe(false);
  });

  it("is moved once every fee the wallet paid is past its TTL and the journal's margin", () => {
    const { file } = legacy("legacy-settled");
    expect(moveLegacyWalletState(file, [held(-6)])).toBe(`${file}.wallet-sdk-1`);
  });

  const journalHolding = (name: string, payer: string, minutes: number) => {
    const path = join(dir, `${name}.journal.sqlite`);
    openJournal(path).close();
    const db = new DatabaseSync(path);
    db.prepare("insert into attempts (key, tx_hash, bytes, ttl_ms, state, payer) values (?, ?, ?, ?, 'pending', ?)").run("preprod/r/a/1/c/", "cd".repeat(32), new Uint8Array([1]), Date.now() + minutes * 60_000, payer);
    db.close();
    return path;
  };
  const openOver = async (name: string, journals?: readonly string[]) => {
    const mnemonicFile = join(dir, `${name}.mnemonic`);
    createWalletMnemonicFile(mnemonicFile);
    const { file, bytes } = legacy(name);
    const OFFLINE = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} };
    const opening = openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source: liveSource(), zkDir: "/nonexistent", stateFile: file, ...(journals ? { journals } : {}) });
    return { file, bytes, opening };
  };

  it("is not moved by an open that names no journal, or whose journal holds a fee the wallet paid in flight", async () => {
    const unnamed = await openOver("legacy-unnamed");
    await expect(unnamed.opening).rejects.toThrow(`${unnamed.file} was saved by wallet-sdk 1.x, and no journal of the fees the wallet paid was named; the state file stays`);
    expect(readFileSync(unnamed.file)).toEqual(unnamed.bytes);
    const mnemonicFile = join(dir, "legacy-journal.mnemonic");
    createWalletMnemonicFile(mnemonicFile);
    const journal = journalHolding("legacy-journal", walletAddresses(mnemonicFile, "preprod").unshielded, 10);
    const { file, bytes } = legacy("legacy-journal");
    const OFFLINE = { operator: "offline", indexer: "http://127.0.0.1:9/graphql", indexerWs: "ws://127.0.0.1:9/graphql/ws", node: "http://127.0.0.1:9", headers: {} };
    await expect(openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source: liveSource(), zkDir: "/nonexistent", stateFile: file, journals: [journal, join(dir, "never-created.sqlite")] })).rejects.toThrow(`while the fee ${"cd".repeat(32)} the wallet paid may still land`);
    expect(readFileSync(file)).toEqual(bytes);
    expect(existsSync(join(dir, "never-created.sqlite"))).toBe(false);
  });

  it("opens a wallet that syncs from genesis, and the next save writes a wallet-sdk 2.x state in its place", async () => {
    const other = journalHolding("legacy-open-other", "mn_addr_test1someoneelse", 10);
    const { file, bytes, opening } = await openOver("legacy-open", [other]);
    const wallet = await opening;
    try {
      expect(readFileSync(`${file}.wallet-sdk-1`)).toEqual(bytes);
      expect(await wallet.saveState()).toEqual({ saved: true });
      expect(JSON.parse(readFileSync(file, "utf8")).format).toBe(WALLET_STATE_FORMAT);
    } finally {
      await wallet.close();
    }
  });
});

