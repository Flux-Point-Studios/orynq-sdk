import { describe, expect, it } from "vitest";
import fixture from "./fixtures/storage-proof-mainnet.json";
import neighbor from "./fixtures/runtime-neighbor-mainnet.json";
import { provedEntry, provedValue } from "../storage-proof.js";
import { toHex } from "../scale.js";
import { CODE_KEYS, FORK, PENDING_CODE_KEYS, forkBlock, recorded } from "./fork-chain.js";

const EVENTS = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
const CODE = "0x3a636f6465";
const PENDING_CODE = "0x3a70656e64696e675f636f6465";
const CODE_HASH = "0x39568eeb0802fa59d74ac0bc5c7ab62fc05c23ea947937458a4b011558516138";

describe("authenticated Substrate storage values", () => {
  it("binds the real code key to its pinned hash using a compact extension-query witness", () => {
    expect(neighbor.requestedKey).toBe(CODE + "00");
    expect(Buffer.byteLength(JSON.stringify(neighbor.proof))).toBeLessThan(2048);
    expect(provedValue(neighbor.header.stateRoot, CODE, neighbor.proof.proof, true)).toBe(CODE_HASH);
    expect(() => provedValue(neighbor.header.stateRoot, CODE, neighbor.proof.proof)).toThrow(/hashed value/);
    expect(() => provedValue(neighbor.header.stateRoot, CODE + "00", neighbor.proof.proof, true)).toThrow();
    expect(() => provedValue("0x" + "00".repeat(32), CODE, neighbor.proof.proof, true)).toThrow();
    for (let index = 0; index < neighbor.proof.proof.length; index++) {
      expect(() => provedValue(neighbor.header.stateRoot, CODE, neighbor.proof.proof.filter((_, i) => i !== index), true)).toThrow();
    }
    const changed = neighbor.proof.proof.map(node => node.replace(CODE_HASH.slice(2), "aa".repeat(32)));
    expect(() => provedValue(neighbor.header.stateRoot, CODE, changed, true)).toThrow();
  });
  it("reads real Midnight events and the parent runtime hash without a runtime blob", () => {
    expect(provedValue(fixture.header.stateRoot, EVENTS, fixture.proof.proof)).toBe(fixture.events);
    expect(provedValue(fixture.parent.header.stateRoot, CODE, fixture.parent.proof.proof, true)).toBe(CODE_HASH);
  });

  it("rejects another root, key, missing node or changed node", () => {
    expect(() => provedValue(`0x${"00".repeat(32)}`, EVENTS, fixture.proof.proof)).toThrow();
    expect(() => provedValue(fixture.header.stateRoot, CODE + "00", fixture.proof.proof)).toThrow();
    for (const i of [fixture.rootIndex]) {
      const absent = fixture.proof.proof.filter((_, j) => j !== i);
      const changed = [...fixture.proof.proof]; changed[i] = changed[i]!.slice(0, -2) + "ff";
      expect(() => provedValue(fixture.header.stateRoot, EVENTS, absent)).toThrow();
      expect(() => provedValue(fixture.header.stateRoot, EVENTS, changed)).toThrow();
    }
  });

  it("proves a key absent only from the nodes on its path", () => {
    const parentOf = (height: number) => `0x${forkBlock(height).blockHash}`;
    const rootOf = (height: number) => `0x${toHex(forkBlock(height).header.stateRoot)}`;
    const before = recorded<{ proof: string[] }>("state_getReadProof", [[CODE_KEYS, PENDING_CODE_KEYS], parentOf(FORK.setCode - 1)]).proof;
    expect(provedEntry(rootOf(FORK.setCode - 1), PENDING_CODE, before, true)).toBeNull();
    expect(() => provedValue(rootOf(FORK.setCode - 1), PENDING_CODE, before, true)).toThrow(/no value/);
    expect(provedEntry(neighbor.header.stateRoot, PENDING_CODE, neighbor.proof.proof, true)).toBeNull();
    const pending = recorded<{ proof: string[] }>("state_getReadProof", [[CODE_KEYS, PENDING_CODE_KEYS], parentOf(FORK.setCode)]).proof;
    expect(provedEntry(rootOf(FORK.setCode), PENDING_CODE, pending, true)).toBe("0x87d0c023b954ad788bba2c065320fe19f172f374adbe86ebc0a99bc1ce3fe1de");
    expect(provedEntry(rootOf(FORK.setCode), CODE, pending, true)).toBe(CODE_HASH);
    const codeOnly = recorded<{ proof: string[] }>("state_getReadProof", [[CODE_KEYS], parentOf(FORK.setCode)]).proof;
    expect(() => provedEntry(rootOf(FORK.setCode), PENDING_CODE, codeOnly, true)).toThrow(/lacks the requested path/);
    expect(() => provedEntry(`0x${"00".repeat(32)}`, PENDING_CODE, before, true)).toThrow(/root/);
  });

  it("bounds proof work before decoding and refuses malformed bytes", () => {
    for (const nodes of [[], ["0x0"], ["0xgg"], Array(2049).fill("0x00"), [`0x${"00".repeat(4194305)}`]]) {
      expect(() => provedValue(fixture.header.stateRoot, EVENTS, nodes)).toThrow();
    }
    expect(() => provedValue(fixture.header.stateRoot, "0xz", fixture.proof.proof)).toThrow();
  });
});
