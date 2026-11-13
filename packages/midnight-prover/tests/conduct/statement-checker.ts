import { createHash } from "node:crypto";
import { mandateCommitment, type MandateV1 } from "@fluxpointstudios/orynq-sdk-conduct";
import { getGenesisHash } from "@fluxpointstudios/orynq-sdk-process-trace";

/** The rolling-hash fields every event statement discloses. */
export interface RollStatement {
  readonly prevRollHex: Uint8Array;
  readonly rollAfter: Uint8Array;
}

/**
 * Assumption A2, checked outside the circuit: the statements continue one rolling chain from the genesis hash, each
 * `prevRollHex` the lowercase hex of the previous `rollAfter`.
 */
export async function chain(statements: readonly RollStatement[]): Promise<void> {
  let expected = await getGenesisHash();
  for (const [i, { prevRollHex, rollAfter }] of statements.entries()) {
    const text = Buffer.from(prevRollHex).toString("latin1");
    if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`prevRollHex ${i} is not 64 lowercase hex digits`);
    if (text !== expected) throw new Error(i === 0 ? "prevRollHex 0 is not the genesis rolling hash" : `prevRollHex ${i} is not the hex of rollAfter ${i - 1}`);
    expected = Buffer.from(rollAfter).toString("hex");
  }
}

const le8 = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};

export const MANDATE_ATOMS_DOMAIN = "orynq:conduct:mandate-atoms:v1";

/**
 * The reference for K, the mandate-atoms commitment: SHA-256 over the zero-padded domain, the mandate commitment C and
 * the atoms a step uses, each uint as 8 little-endian bytes and the asset as its SHA-256.
 */
export function mandateAtoms(m: MandateV1): Uint8Array {
  const domain = Buffer.alloc(32);
  domain.write(MANDATE_ATOMS_DOMAIN, "ascii");
  return new Uint8Array(createHash("sha256").update(Buffer.concat([
    domain, mandateCommitment(m), le8(m.validityWindow.notBefore), le8(m.validityWindow.notAfter),
    createHash("sha256").update(m.spendCap.asset, "utf8").digest(), le8(m.spendCap.amount), le8(m.spendCap.windowSeconds),
    Uint8Array.of(Number(m.egressPolicy.mode)), m.counterpartyAllowlistRoot, m.egressPolicy.allowlistRoot,
  ])).digest());
}
