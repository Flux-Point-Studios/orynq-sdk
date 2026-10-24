import { expect } from "vitest";
import { blake2b256 } from "../substrate.js";
import { fromHex, toHex } from "../scale.js";

const digest = (value: string) => `0x${toHex(blake2b256(fromHex(value, "test witness")))}`;
export function replaceProofValue(proof: string[], root: string, oldValue: string, value: string) {
  const nodes = [...proof];
  const index = nodes.indexOf(oldValue);
  expect(index).toBeGreaterThanOrEqual(0);
  nodes[index] = value;
  const pending = [[digest(oldValue), digest(value)]];
  for (let at = 0; at < pending.length; at++) {
    const [oldHash, newHash] = pending[at]!;
    if (root === oldHash) root = newHash!;
    for (let i = 0; i < nodes.length; i++) {
      const before = nodes[i]!;
      const after = before.replaceAll(oldHash!.slice(2), newHash!.slice(2));
      if (after !== before) { nodes[i] = after; pending.push([digest(before), digest(after)]); }
    }
  }
  return { nodes, root };
}

