import { describe, expect, it } from "vitest";
import * as L8 from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { assertTransactionRuntime, decodeTransaction, ledgerParametersIn, runtimeLedger } from "../ledgers.js";
import { fromHex } from "../scale.js";
import { midnightTransactionIn } from "../substrate.js";
import { fixture } from "./anchor-chain.js";
import { relabelled } from "./registry-call.js";
import ledger9Block from "./fixtures/mainnet-ledger9-block.json";

const v9 = fromHex(fixture.anchor.tx, "v9 anchor");
const v12 = midnightTransactionIn(fromHex(ledger9Block.extrinsics[3]!, "extrinsic"))!;

describe("the ledger each runtime executes", () => {
  it("is ledger 8 under runtime 1000300 and ledger 9 under runtime 2001100", () => {
    expect(runtimeLedger(1000300)).toBe(L8);
    expect(runtimeLedger(2001100)).toBe(L9);
  });

  it("is unknown for any other runtime", () => {
    for (const spec of [1000400, 2001000, 0]) expect(() => runtimeLedger(spec)).toThrow(`runtime ${spec} executes no ledger this decoder knows`);
  });
});

describe("decodeTransaction", () => {
  it("reads transaction[v9] with ledger 8 and transaction[v12] with ledger 9", () => {
    expect(decodeTransaction(v9).tx).toBeInstanceOf(L8.Transaction);
    expect(decodeTransaction(v12).tx).toBeInstanceOf(L9.Transaction);
    expect(decodeTransaction(v12).tx.transactionHash()).toBe("655fe3d8bd2c06494e2dc95c82883d1b7d235969b905939e6f57533b18dd84b8");
  });

  it("refuses a header neither ledger writes, and bytes its ledger cannot read", () => {
    expect(() => decodeTransaction(new Uint8Array(Buffer.from("midnight:transaction[v11]:")))).toThrow(/transaction header midnight:transaction\[v11\] is not one this decoder knows/);
    expect(() => decodeTransaction(v12.subarray(0, 200))).toThrow(/the bytes are not a Midnight transaction/);
  });
});

describe("assertTransactionRuntime binds a transaction's ledger to the runtime that executed it", () => {
  it("accepts each ledger's transaction under its own runtime", () => {
    expect(() => assertTransactionRuntime(v9, 1000300)).not.toThrow();
    expect(() => assertTransactionRuntime(v12, 2001100)).not.toThrow();
  });

  it("refuses a ledger 8 transaction relabelled v12, which ledger 9 reads as another transaction, under runtime 1000300", () => {
    const forged = relabelled(v9);
    expect(decodeTransaction(forged).tx.transactionHash()).not.toBe(decodeTransaction(v9).tx.transactionHash());
    expect(() => assertTransactionRuntime(forged, 1000300)).toThrow("transaction header midnight:transaction[v12] is not one runtime 1000300 executes");
  });

  it("refuses ledger 8 bytes under runtime 2001100, and any transaction under a runtime it does not know", () => {
    expect(() => assertTransactionRuntime(v9, 2001100)).toThrow("transaction header midnight:transaction[v9] is not one runtime 2001100 executes");
    expect(() => assertTransactionRuntime(v12, 1000400)).toThrow("runtime 1000400 executes no ledger this decoder knows");
  });
});

describe("ledgerParametersIn", () => {
  it("reads ledger-parameters[v5] with ledger 8 and [v8] with ledger 9, and refuses any other header", () => {
    expect(ledgerParametersIn(L8.LedgerParameters.initialParameters().serialize())).toBeInstanceOf(L8.LedgerParameters);
    expect(ledgerParametersIn(L9.LedgerParameters.initialParameters().serialize())).toBeInstanceOf(L9.LedgerParameters);
    expect(() => ledgerParametersIn(new Uint8Array(Buffer.from("midnight:ledger-parameters[v7]:")))).toThrow("ledger parameters header midnight:ledger-parameters[v7] is not one this decoder knows");
  });
});
