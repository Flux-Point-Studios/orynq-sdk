import { Blake2256, Hex, trieNodeDec, validateProofs, type HexString, type Nibble, type TrieNode } from "@polkadot-api/substrate-bindings";

const HEX = /^0x(?:[0-9a-f]{2})*$/;

// Read-proof nodes are untrusted until their root matches a finalized header's stateRoot.
export function provedValue(root: string, key: string, nodes: readonly string[], hashOnly = false): string {
  if (!/^0x[0-9a-f]{64}$/.test(root) || !HEX.test(key) || key.length > 514) throw new Error("Invalid storage root or key");
  if (nodes.length < 1 || nodes.length > 2048) throw new Error("Storage proof must contain 1..2048 nodes");
  let bytes = 0;
  for (const node of nodes) {
    if (!HEX.test(node)) throw new Error("Malformed storage proof node");
    bytes += (node.length - 2) / 2;
    if (bytes > 4 * 1024 * 1024) throw new Error("Storage proof exceeds 4 MiB");
  }
  const proof = validateProofs(nodes as HexString[]);
  if (!proof || proof.rootHash !== root) throw new Error("Storage proof root differs from the finalized state root");
  let node: TrieNode | (typeof proof.proofs)[HexString] | undefined = proof.proofs[proof.rootHash];
  let remaining = key.slice(2);
  for (let depth = 0; depth <= key.length; depth++) {
    if (!node || node.type === "Raw" || node.type === "Empty" || node.type === "Reserved") throw new Error("Storage proof lacks the requested path");
    if (!remaining.startsWith(node.partialKey)) throw new Error("Storage proof key differs from the requested key");
    remaining = remaining.slice(node.partialKey.length);
    if (!remaining.length) {
      if (!("value" in node)) throw new Error("Storage proof has no value at the requested key");
      if (node.type === "LeafWithHash" || node.type === "BranchWithHash") {
        if (hashOnly) return node.value;
        const raw = proof.proofs[node.value];
        if (!raw || raw.type !== "Raw") throw new Error("Storage proof lacks the hashed value");
        return raw.value;
      }
      const value = node.type === "Leaf" ? Hex().dec(node.value) : node.value;
      return hashOnly ? `0x${Buffer.from(Blake2256(Buffer.from(value.slice(2), "hex"))).toString("hex")}` : value;
    }
    if (!("children" in node)) throw new Error("Storage proof ends before the requested key");
    const child = node.children[remaining[0] as Nibble];
    remaining = remaining.slice(1);
    if (!child) throw new Error("Storage proof lacks the requested child");
    node = child.length === 66 ? proof.proofs[child] : trieNodeDec(child);
  }
  throw new Error("Storage proof exceeds the key path");
}
