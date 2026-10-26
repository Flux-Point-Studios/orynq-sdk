import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { batchSetCommitment } from "../checkpoint.js";

const G = "0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf";
const hash = (n: number) => n.toString(16).padStart(64, "0");

it("matches the independently encoded Midnight batch-set domain for one and many members", () => {
  for (const ids of [[hash(1)], [hash(0), hash(1), hash(255)], Array.from({ length: 1024 }, (_, i) => hash(i))]) {
    const tag = Buffer.alloc(32); tag.write("orynq:anchor-batches:v1");
    const digest = createHash("sha256").update(Buffer.concat([tag, Buffer.from(G, "hex"), ...ids.map(id => Buffer.from(id, "hex"))])).digest("hex");
    expect(batchSetCommitment({ materiosGenesis: G, anchorIds: ids })).toBe("0x" + digest);
  }
});

it("normalizes aliases before enforcing strictly ascending unique members", () => {
  const one = batchSetCommitment({ materiosGenesis: G, anchorIds: [hash(255)] });
  expect(batchSetCommitment({ materiosGenesis: "0x" + G.toUpperCase(), anchorIds: ["0x" + hash(255).toUpperCase()] })).toBe(one);
  for (const ids of [[], [hash(1), hash(1)], [hash(255), "0x" + hash(255).toUpperCase()], [hash(2), hash(1)], ["zz".repeat(32)], Array.from({ length: 1025 }, (_, i) => hash(i)), Array(1)]) expect(() => batchSetCommitment({ materiosGenesis: G, anchorIds: ids })).toThrow();
  expect(() => batchSetCommitment({ materiosGenesis: G.slice(1), anchorIds: [hash(1)] })).toThrow();
});

it("orders protocol bytes independently of host collation", () => {
  const collation = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => { throw new Error("Protocol ordering must not use host collation"); });
  try { expect(batchSetCommitment({ materiosGenesis: G, anchorIds: [hash(1), hash(2)] })).toMatch(/^0x[a-f0-9]{64}$/); }
  finally { collation.mockRestore(); }
});
