import { describe, expect, it, vi } from "vitest";
import type { MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import type { AnchorReceipt, PreparedAnchor } from "../src/operator.js";
import { verifyConfirmedAnchor } from "../src/confirmed-anchor.js";

const verification = vi.hoisted(() => ({ report: {} as Record<string, unknown>, calls: [] as unknown[][] }));
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight", async original => ({
  ...await original<typeof import("@fluxpointstudios/orynq-sdk-anchors-midnight")>(),
  verifyMidnightAnchor: async (...args: unknown[]) => { verification.calls.push(args); return verification.report; },
}));
const prepared: PreparedAnchor = { network: "mainnet", registry: "ab".repeat(32), txHash: "cd".repeat(32), bytes: new Uint8Array(), ttl: new Date(), declaredFee: 1n, author: "ef".repeat(32), kind: 1, commitment: "12".repeat(32), attribute: "00".repeat(32) };
const receipt: AnchorReceipt = { ...prepared, blockHeight: 20, blockHash: "34".repeat(32) };
const source = {} as MidnightSource;
const valid = () => ({ status: "valid", assurance: "consensus-verified", author: { key: prepared.author, status: "known" }, registry: { address: prepared.registry }, anchor: { kind: prepared.kind, commitment: prepared.commitment }, block: { height: receipt.blockHeight, hash: receipt.blockHash } });

describe("consensus confirmation before recording an anchor", () => {
  it("uses public consensus verification without a caller-selected author trust override", async () => {
    verification.report = valid(); verification.calls = [];
    await expect(verifyConfirmedAnchor(source, prepared, receipt)).resolves.toBeUndefined();
    expect(verification.calls).toEqual([[{ network: "mainnet", txHash: prepared.txHash, expect: { kind: 1, commitment: prepared.commitment } }, { source, finality: "verify" }]]);
  });
  it.each([
    { assurance: "multi-path" }, { assurance: "single-path" }, { status: "unverified-finality" },
    { author: { key: prepared.author, status: "expected" } }, { author: { key: "99".repeat(32), status: "known" } },
    { registry: { address: "99".repeat(32) } }, { anchor: { kind: 1, commitment: "99".repeat(32) } },
    { block: { height: 21, hash: receipt.blockHash } }, { block: { height: 20, hash: "99".repeat(32) } },
  ])("refuses a weaker or mismatched report (%j)", async change => {
    verification.report = { ...valid(), ...change };
    await expect(verifyConfirmedAnchor(source, prepared, receipt)).rejects.toThrow("results were not recorded");
  });
  it("refuses a receipt for another transaction before asking a verifier", async () => {
    verification.calls = [];
    await expect(verifyConfirmedAnchor(source, prepared, { ...receipt, txHash: "99".repeat(32) })).rejects.toThrow("differs from the confirmed anchor");
    expect(verification.calls).toEqual([]);
  });
});
