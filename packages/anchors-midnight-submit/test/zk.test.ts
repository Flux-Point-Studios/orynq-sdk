import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WasmProver } from "@midnightntwrk/wallet-sdk-prover-client/effect";
import { compiledContractFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import * as L8 from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { ZK_PINS, keyMaterial, provingService } from "../src/zk.js";

// tools/compactc/install.sh installs the parameters and the DUST spend keys into MIDNIGHT_PP.
const zkDir = process.env.MIDNIGHT_PP;
if (!zkDir) throw new Error("MIDNIGHT_PP must name the directory tools/compactc/install.sh filled");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const scratch = mkdtempSync(join(homedir(), ".cache", "orynq-zk-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the key material an operator proves with", () => {
  it("pins exactly what the installer pins", () => {
    const installer = readFileSync(new URL("../../../tools/compactc/compactc.sha256", import.meta.url), "utf8");
    for (const [name, digest] of Object.entries(ZK_PINS)) expect(installer).toContain(`${digest}  ${name}`);
    expect(Object.keys(ZK_PINS).sort()).toEqual(["bls_midnight_2p13", "bls_midnight_2p14", "dust/10/spend.bzkir", "dust/10/spend.prover", "dust/10/spend.verifier", "dust/9/spend.bzkir", "dust/9/spend.prover", "dust/9/spend.verifier"]);
  });

  // wallet-sdk-prover-client 2.0.0 checks the DUST spend files it reads against the hashes each
  // ledger release declares, at circuit generation 9 for ledger 8 and 10 for ledger 9. Served the
  // files the installer verified, its providers accept exactly the bytes keyMaterial serves.
  it("pins each ledger's DUST spend circuit as the wallet SDK's own prover pins it", async () => {
    const server = createServer((req, res) => {
      const name = decodeURIComponent(new URL(req.url!, "http://local").pathname.slice(1));
      if (!(name in ZK_PINS)) return void res.writeHead(404).end();
      res.writeHead(200).end(readFileSync(join(zkDir, name)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const source = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      for (const [ledger, sdk] of [[8, WasmProver.makeV8KeyMaterialProvider({ source })], [9, WasmProver.makeV9KeyMaterialProvider({ source })]] as const) {
        const theirs = await sdk.lookupKey("midnight/dust/spend"), ours = await keyMaterial(zkDir, ledger).lookupKey("midnight/dust/spend");
        expect([sha256(theirs!.proverKey), sha256(theirs!.verifierKey), sha256(theirs!.ir)]).toEqual([sha256(ours!.proverKey), sha256(ours!.verifierKey), sha256(ours!.ir)]);
      }
    } finally {
      server.close();
    }
  });

  it.each([8, 9] as const)("serves each registry circuit from the committed build under ledger %i", async (ledger) => {
    const provider = keyMaterial(zkDir, ledger);
    for (const circuit of ["anchor", "anchor_hiding"]) {
      const material = await provider.lookupKey(circuit);
      expect(sha256(material!.proverKey)).toBe(sha256(compiledContractFile(`keys/${circuit}.prover`)));
      expect(sha256(material!.verifierKey)).toBe(sha256(compiledContractFile(`keys/${circuit}.verifier`)));
      expect(sha256(material!.ir)).toBe(sha256(compiledContractFile(`zkir/${circuit}.bzkir`)));
    }
  });

  it.each([[8, 9], [9, 10]] as const)("serves ledger %i's DUST spend circuit, generation %i, and the k=13/14 parameters only as pinned", async (ledger, generation) => {
    const provider = keyMaterial(zkDir, ledger);
    const dust = await provider.lookupKey("midnight/dust/spend");
    expect(sha256(dust!.proverKey)).toBe(ZK_PINS[`dust/${generation}/spend.prover`]);
    expect(sha256(dust!.verifierKey)).toBe(ZK_PINS[`dust/${generation}/spend.verifier`]);
    expect(sha256(dust!.ir)).toBe(ZK_PINS[`dust/${generation}/spend.bzkir`]);
    expect(sha256(await provider.getParams(13))).toBe(ZK_PINS.bls_midnight_2p13);
    expect(sha256(await provider.getParams(14))).toBe(ZK_PINS.bls_midnight_2p14);
    await expect(provider.getParams(15)).rejects.toThrow(/no pinned parameters for k=15/);
  });

  it("has nothing for shielded-token circuits, which an anchor never spends", async () => {
    for (const ledger of [8, 9] as const) {
      expect(await keyMaterial(zkDir, ledger).lookupKey("midnight/zswap/spend")).toBeUndefined();
      expect(await keyMaterial(zkDir, ledger).lookupKey("midnight/zswap/output")).toBeUndefined();
    }
  });

  it("refuses a file that no longer matches its pin", async () => {
    const tampered = join(scratch, "zk");
    mkdirSync(join(tampered, "dust", "9"), { recursive: true });
    mkdirSync(join(tampered, "dust", "10"), { recursive: true });
    for (const name of Object.keys(ZK_PINS)) copyFileSync(join(zkDir, name), join(tampered, name));
    const prover = readFileSync(join(tampered, "dust/9/spend.prover"));
    prover[4096]! ^= 1;
    chmodSync(join(tampered, "dust/9/spend.prover"), 0o600);
    writeFileSync(join(tampered, "dust/9/spend.prover"), prover);
    await expect(keyMaterial(tampered, 8).lookupKey("midnight/dust/spend")).rejects.toThrow(/dust\/9\/spend\.prover hashes to [0-9a-f]{64}, pinned 996602da/);
    expect(sha256((await keyMaterial(tampered, 9).lookupKey("midnight/dust/spend"))!.proverKey)).toBe(ZK_PINS["dust/10/spend.prover"]);
    expect(sha256(await keyMaterial(tampered, 8).getParams(13))).toBe(ZK_PINS.bls_midnight_2p13);
  });
});

describe("the operator's prover", () => {
  // Each ledger's transaction is proven with that ledger's prover and comes back of that ledger.
  it("proves a transaction of either ledger with that ledger's prover", async () => {
    const ttl = new Date(Date.now() + 600e3);
    const prover = provingService("/nonexistent");
    expect(await prover.prove(L9.Transaction.fromParts("preprod", undefined, undefined, L9.Intent.new(ttl)))).toBeInstanceOf(L9.Transaction);
    expect(await prover.prove(L8.Transaction.fromParts("preprod", undefined, undefined, L8.Intent.new(ttl)))).toBeInstanceOf(L8.Transaction);
  });
});
