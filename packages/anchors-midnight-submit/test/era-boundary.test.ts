import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as L from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { createAuthorKeyFile } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { registryOperator } from "../src/operator.js";
import { registryDeployer } from "../src/deployer.js";
import { proofReleaseOperator } from "../src/proof-release.js";
import { SUBMITTER_RUNTIME_SPEC_VERSIONS, assertKnownRuntime } from "../src/submission.js";
import { bytes32, chain, deployed, deployed9, fresh, wallet } from "./fakes.js";
import { fixtureVerifier } from "./fixture-verifier.js";
import { prover } from "./prover.js";
import { withFixtureProof } from "../../midnight-prover/tests/fixture-prover.js";

vi.mock("@fluxpointstudios/orynq-sdk-midnight-prover", async importOriginal => {
  const original = await importOriginal<typeof import("@fluxpointstudios/orynq-sdk-midnight-prover")>();
  return { ...original, proofProvider: (dir: string) => withFixtureProof(original.proofProvider(dir)) };
});

// Bytes of one ledger never reach a node that executes another: every send, a journalled row's
// resend included, checks the node's current runtime at the last send boundary.
let bindingRoot: string, authorKeyFile: string, saltKeyFile: string;
beforeEach(() => {
  bindingRoot = fresh("bindings");
  authorKeyFile = fresh("author.key");
  createAuthorKeyFile(authorKeyFile);
  saltKeyFile = fresh("salt.key");
  createAuthorKeyFile(saltKeyFile);
});
const entry = () => ({ rootHash: bytes32(), manifestHash: bytes32(), merkleRoot: bytes32() });
const rows = (journalPath: string) => {
  const db = new DatabaseSync(journalPath);
  try {
    return db.prepare("select state, broadcasts from attempts").all();
  } finally {
    db.close();
  }
};
// A wallet whose first delivery fails in transport, leaving its journal row unsent.
const failingFirstDelivery = (w: ReturnType<typeof wallet>) => {
  let failed = false;
  const deliver = w.submit.bind(w);
  w.submit = async (tx) => {
    if (failed) return deliver(tx);
    failed = true;
    throw new Error("transport: connection reset");
  };
  return w;
};

describe("a journalled row nobody sent before the fork", () => {
  it("is not resent once the node runs a runtime of another ledger, and stays journalled with its DUST held", async () => {
    const net = chain();
    const journalPath = fresh("journal.sqlite");
    const w = failingFirstDelivery(wallet(net, () => journalPath));
    const operator = registryOperator({ bindingRoot, verifyLanded: fixtureVerifier, network: "preprod", wallet: w, source: net.source, prover, journalPath, authorKeyFile, saltKeyFile, registry: deployed.address, pollMillis: 1 });
    try {
      const anchored = entry();
      await expect(operator.anchor(anchored)).rejects.toThrow(/transport/);
      net.upgrade(2001100);
      await expect(operator.anchor(anchored)).rejects.toThrow(/the journalled bytes cannot land: transaction header midnight:transaction\[v9\] is not one runtime 2001100 executes; the journalled bytes were retained and nothing was sent/);
      expect(w.submitted).toEqual([]);
      expect(w.discarded).toEqual([]);
      expect(rows(journalPath)).toEqual([{ state: "pending", broadcasts: 0 }]);
    } finally {
      operator.close();
    }
  });
});

describe("a registry deploy prepared before the fork", () => {
  it("is not sent once the node runs ledger 9", async () => {
    const net = chain();
    const journalPath = fresh("deploy.sqlite");
    const w = wallet(net, () => journalPath);
    const deployer = registryDeployer({ network: "preprod", wallet: w, source: net.source, prover, journalPath, pollMillis: 1 });
    try {
      const prepared = await deployer.prepare();
      net.upgrade(2001100);
      await expect(deployer.submit(prepared)).rejects.toThrow(/runtime 2001100, which is not one this submitter knows \(1000300\)/);
      expect(w.submitted).toEqual([]);
    } finally {
      deployer.close();
    }
  });

  it("journalled and unsent, is neither described nor resent once the node runs ledger 9", async () => {
    const net = chain();
    const journalPath = fresh("deploy.sqlite");
    const w = failingFirstDelivery(wallet(net, () => journalPath));
    const deployer = registryDeployer({ network: "preprod", wallet: w, source: net.source, prover, journalPath, pollMillis: 1 });
    try {
      const prepared = await deployer.prepare();
      await expect(deployer.submit(prepared)).rejects.toThrow(/transport/);
      net.upgrade(2001100);
      await expect(deployer.journalled()).rejects.toThrow(/not one this submitter knows \(1000300\)/);
      await expect(deployer.submit(prepared)).rejects.toThrow(/not one this submitter knows \(1000300\)/);
      expect(w.submitted).toEqual([]);
      expect(rows(journalPath)).toEqual([{ state: "pending", broadcasts: 0 }]);
    } finally {
      deployer.close();
    }
  });
});

describe("a proof release", () => {
  it("builds and pays for nothing while the node runs ledger 9, which its ledger 8 builder does not write for", async () => {
    const net = chain({ spec: 2001100 });
    const journalPath = fresh("proof-release.sqlite");
    const w = wallet(net, () => journalPath);
    const paid = vi.spyOn(w, "payFee");
    const operator = proofReleaseOperator({ network: "preprod", source: net.source, wallet: w, paramsDir: "unused", journalPath, expiresAt: Date.now() + 3600_000 });
    try {
      await expect(operator.prepare("deploy")).rejects.toThrow(/runtime 2001100, which is not one this submitter knows \(1000300\)/);
      expect(paid).not.toHaveBeenCalled();
      expect(w.submitted).toEqual([]);
    } finally {
      operator.close();
    }
  });
});

describe("the runtimes a caller admits", () => {
  it("are named by every caller: an empty list admits nothing", async () => {
    const net = chain();
    await expect(assertKnownRuntime(net.source, "preprod", [])).rejects.toThrow(/names no runtime it builds for/);
    await expect(assertKnownRuntime(net.source, "preprod", SUBMITTER_RUNTIME_SPEC_VERSIONS)).resolves.toBe(1000300);
  });
});

describe("the ledger 9 parameters a call is built with", () => {
  const prepareUnder = async (net: ReturnType<typeof chain>) => {
    const journalPath = fresh("journal.sqlite");
    const w = wallet(net, () => journalPath);
    const paid = vi.spyOn(w, "payFee");
    const operator = registryOperator({ bindingRoot, verifyLanded: fixtureVerifier, network: "preprod", wallet: w, source: net.source, prover, journalPath, authorKeyFile, saltKeyFile, registry: deployed.address, pollMillis: 1 });
    try {
      return { result: await operator.prepare({ kind: 1, entry: entry() }).catch((error: unknown) => error), paid };
    } finally {
      operator.close();
    }
  };
  const parametersHex = Buffer.from(L9.LedgerParameters.initialParameters().serialize()).toString("hex");

  it.each([
    ["a block the node holds under another hash", 499, /the preprod indexer attributes its ledger parameters to block 499 \(e{64}\), which the node holds as [0-9a-f]{64}; nothing was prepared/],
    ["a block the node does not hold", 600, /the preprod indexer attributes its ledger parameters to block 600 \(e{64}\), which the node does not hold; nothing was prepared/],
  ])("are refused when the indexer attributes them to %s", async (_, height, refusal) => {
    const net = chain({ spec: 2001100, state: deployed9.state });
    (net.source.indexer as { ledgerParameters: () => Promise<unknown> }).ledgerParameters = async () => ({ height, hash: "ee".repeat(32), parameters: parametersHex });
    const { result, paid } = await prepareUnder(net);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(refusal);
    expect(paid).not.toHaveBeenCalled();
  });

  it("are refused when the block they come from ran another runtime than the one the call is built for", async () => {
    const net = chain({ state: deployed9.state });
    const before = { height: 499, hash: net.blockHash(499) };
    net.advance(1);
    net.upgrade(2001100);
    (net.source.indexer as { ledgerParameters: () => Promise<unknown> }).ledgerParameters = async () => ({ ...before, parameters: parametersHex });
    const { result, paid } = await prepareUnder(net);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(new RegExp(`the preprod indexer's ledger parameters come from block 499 \\(${before.hash}\\), which ran runtime 1000300, not 2001100; nothing was prepared`));
    expect(paid).not.toHaveBeenCalled();
  });

  it("are taken from a block of the node's chain that ran the call's runtime", async () => {
    const { result } = await prepareUnder(chain({ spec: 2001100, state: deployed9.state }));
    expect(result).not.toBeInstanceOf(Error);
  });
});

describe("the test node", () => {
  it("refuses bytes of another ledger than its runtime executes", () => {
    const net = chain();
    net.upgrade(2001100);
    const tx = L.Transaction.fromParts("preprod", undefined, undefined, L.Intent.new(new Date(Date.now() + 600e3))).mockProve().bind();
    expect(() => net.land(tx)).toThrow(/test node: author_submitExtrinsic failed: .*ledger 8 bytes under runtime 2001100/);
  });
});
