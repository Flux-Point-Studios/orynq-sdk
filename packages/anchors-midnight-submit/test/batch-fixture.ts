import { createHash } from "node:crypto";
export const h = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const sha = (...values: Uint8Array[]) => createHash("sha256").update(Buffer.concat(values)).digest("hex");
const genesis = h(9);
export const batches = [1, 2, 3].map((n) => ({ rootHash: h(n), manifestHash: h(n + 3), anchorId: sha(Buffer.from(h(n), "hex"), Buffer.from(h(n + 3), "hex")) })).sort((a, b) => a.anchorId < b.anchorId ? -1 : 1);
const tag = Buffer.alloc(32); tag.write("orynq:anchor-batches:v1");
export const batch = { label: sha(tag, Buffer.from(genesis, "hex"), ...batches.map((member) => Buffer.from(member.anchorId, "hex"))), kind: 3 as const, materiosGenesis: genesis, batches };
