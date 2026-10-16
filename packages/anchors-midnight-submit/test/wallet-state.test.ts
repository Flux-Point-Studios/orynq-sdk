import { afterAll, describe, expect, it, vi } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import fs, { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "@midnight-ntwrk/ledger-v8";
import { FacadeState } from "@midnight-ntwrk/wallet-sdk-facade";
import { createWalletMnemonicFile } from "../src/keys.js";
import { openWallet, readWalletState, writeWalletState, type WalletSnapshot } from "../src/wallet.js";

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
  const open = async (name: string, stateFile = join(dir, `${name}.state.json`)) => {
    const mnemonicFile = join(dir, `${name}.mnemonic`);
    if (!existsSync(mnemonicFile)) createWalletMnemonicFile(mnemonicFile);
    const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: OFFLINE, source: undefined as never, zkDir: "/nonexistent", stateFile });
    return { wallet, stateFile };
  };
  const trapSerialize = () =>
    vi.spyOn(L.ZswapLocalState.prototype, "serialize").mockImplementation(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });
  const TRAPPED = { saved: false, failures: [{ part: "shielded", error: "ParseError: Could not serialize local state: RuntimeError: unreachable" }] };
  const trappedLine = (stateFile: string) =>
    `${stateFile}: the preprod wallet's sync state was not saved (shielded: ParseError: Could not serialize local state: RuntimeError: unreachable); the file keeps its last good save, and the next open resumes from it and replays the events since`;

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
           const wallet = await openWallet({ network: "preprod", mnemonicFile, endpoints: ${JSON.stringify(OFFLINE)}, zkDir: "/nonexistent", stateFile });
           console.log(JSON.stringify(await wallet.saveState()));
           await wallet.close();`,
          mnemonicFile,
          stateFile,
        ],
        { encoding: "utf8", env: { ...process.env, TSX_DISABLE_CACHE: "1" } },
        (error, stdout, stderr) => resolve({ status: error ? Number(error.code) : 0, stdout, stderr }),
      ),
    );

  it("returns a write the file system cuts short as a failure, leaving the last good save byte for byte", async () => {
    const mnemonicFile = join(dir, "cut.mnemonic");
    createWalletMnemonicFile(mnemonicFile);
    const stateFile = join(dir, "cut.state.json");
    expect(await saveOnce(mnemonicFile, stateFile, false)).toMatchObject({ status: 0, stdout: `${JSON.stringify({ saved: true })}\n` });
    const good = readFileSync(stateFile);
    expect(good.length).toBeGreaterThan(1024);

    const cut = await saveOnce(mnemonicFile, stateFile, true);
    expect(cut.status).toBe(0);
    expect(JSON.parse(cut.stdout)).toEqual({ saved: false, failures: [{ part: "file", error: "Error: EFBIG: file too large, write" }] });
    expect(cut.stderr).toContain(
      `${stateFile}: the preprod wallet's sync state was not saved (file: Error: EFBIG: file too large, write); the file keeps its last good save, and the next open resumes from it and replays the events since\n`,
    );
    expect(readFileSync(stateFile).equals(good)).toBe(true);
    expect(leftovers(stateFile)).toEqual([]);
  });
});
