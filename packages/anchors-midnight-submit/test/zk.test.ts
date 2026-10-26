import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compiledContractFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { ZK_PINS, keyMaterial } from "../src/zk.js";

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
    expect(Object.keys(ZK_PINS).sort()).toEqual(["bls_midnight_2p13", "bls_midnight_2p14", "dust/9/spend.bzkir", "dust/9/spend.prover", "dust/9/spend.verifier"]);
  });

  it("serves each registry circuit from the committed build", async () => {
    const provider = keyMaterial(zkDir);
    for (const circuit of ["anchor", "anchor_hiding"]) {
      const material = await provider.lookupKey(circuit);
      expect(sha256(material!.proverKey)).toBe(sha256(compiledContractFile(`keys/${circuit}.prover`)));
      expect(sha256(material!.verifierKey)).toBe(sha256(compiledContractFile(`keys/${circuit}.verifier`)));
      expect(sha256(material!.ir)).toBe(sha256(compiledContractFile(`zkir/${circuit}.bzkir`)));
    }
  });

  it("serves the DUST spend circuit and the k=13/14 parameters only as pinned", async () => {
    const provider = keyMaterial(zkDir);
    const dust = await provider.lookupKey("midnight/dust/spend");
    expect(sha256(dust!.proverKey)).toBe(ZK_PINS["dust/9/spend.prover"]);
    expect(sha256(dust!.verifierKey)).toBe(ZK_PINS["dust/9/spend.verifier"]);
    expect(sha256(dust!.ir)).toBe(ZK_PINS["dust/9/spend.bzkir"]);
    expect(sha256(await provider.getParams(13))).toBe(ZK_PINS.bls_midnight_2p13);
    expect(sha256(await provider.getParams(14))).toBe(ZK_PINS.bls_midnight_2p14);
    await expect(provider.getParams(15)).rejects.toThrow(/no pinned parameters for k=15/);
  });

  it("has nothing for shielded-token circuits, which an anchor never spends", async () => {
    expect(await keyMaterial(zkDir).lookupKey("midnight/zswap/spend")).toBeUndefined();
    expect(await keyMaterial(zkDir).lookupKey("midnight/zswap/output")).toBeUndefined();
  });

  it("refuses a file that no longer matches its pin", async () => {
    const tampered = join(scratch, "zk");
    mkdirSync(join(tampered, "dust", "9"), { recursive: true });
    for (const name of Object.keys(ZK_PINS)) copyFileSync(join(zkDir, name), join(tampered, name));
    const prover = readFileSync(join(tampered, "dust/9/spend.prover"));
    prover[4096]! ^= 1;
    chmodSync(join(tampered, "dust/9/spend.prover"), 0o600);
    writeFileSync(join(tampered, "dust/9/spend.prover"), prover);
    await expect(keyMaterial(tampered).lookupKey("midnight/dust/spend")).rejects.toThrow(/dust\/9\/spend\.prover hashes to [0-9a-f]{64}, pinned 996602da/);
    expect(sha256(await keyMaterial(tampered).getParams(13))).toBe(ZK_PINS.bls_midnight_2p13);
  });
});
