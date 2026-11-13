import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorKeyFile, type RegistryInfo } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { registryOperator } from "../src/operator.js";
import { bytes32, chain, deployed, fresh, wallet } from "./fakes.js";
import { fixtureVerifier } from "./fixture-verifier.js";
import { prover } from "./prover.js";

// The operator hands its own registry to the runtime gate (assertKnownRuntime), so a pinned
// generation's runtime spans bind every prepare and every send. Mainnet's pin needs the FPS
// mainnet author key, which no test holds; here preprod pins the fixture registry instead.
const pins = vi.hoisted(() => ({ preprod: [] as unknown[] }));
vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight", async (original) => {
  const real = await original<typeof import("@fluxpointstudios/orynq-sdk-anchors-midnight")>();
  return { ...real, MIDNIGHT_REGISTRIES: { mainnet: real.MIDNIGHT_REGISTRIES.mainnet, preprod: pins.preprod } };
});

// The fixture chain's best block is 499, so what is sent now lands in block 500 at the earliest.
const generation = (ledger8Through: number): RegistryInfo => ({
  generation: 1, address: deployed.address, deployTxHash: "00".repeat(32), deployHeight: 0,
  runtimes: [{ specVersion: 1000300, fromHeight: 0, toHeight: ledger8Through }, { specVersion: 2001100, fromHeight: ledger8Through + 1, toHeight: null }],
  circuits: { anchor: { vkSha256: "00".repeat(32) }, anchor_hiding: { vkSha256: "00".repeat(32) } },
});
const pin = (...registries: RegistryInfo[]) => { pins.preprod.splice(0, pins.preprod.length, ...registries); };
const refusal = "the preprod node runs runtime 1000300 at block 500, which registry generation 1 does not run there";

let authorKeyFile: string;
beforeEach(() => {
  pin();
  authorKeyFile = fresh("author.key");
  createAuthorKeyFile(authorKeyFile);
});

function setup() {
  const net = chain(), journalPath = fresh("journal.sqlite"), w = wallet(net, () => journalPath);
  const operator = registryOperator({ bindingRoot: fresh("bindings"), verifyLanded: fixtureVerifier, network: "preprod", wallet: w, source: net.source, prover, journalPath, authorKeyFile, registry: deployed.address, pollMillis: 1 });
  return { operator, wallet: w };
}
const entry = () => ({ rootHash: bytes32(), manifestHash: bytes32(), merkleRoot: bytes32() });

describe("registryOperator's runtime gate for its own pinned registry generation", () => {
  it("prepares and sends while the generation runs the node's runtime at the next block", async () => {
    pin(generation(500));
    const { operator, wallet: w } = setup();
    try {
      const prepared = await operator.prepare({ kind: 1, entry: entry() });
      await expect(operator.submit(prepared)).resolves.toMatchObject({ txHash: prepared.txHash });
      expect(w.submitted).toHaveLength(1);
    } finally { operator.close(); }
  });

  it("prepares nothing while the generation runs another runtime at the next block, though the submitter builds for the node's", async () => {
    pin(generation(499));
    const { operator, wallet: w } = setup();
    try {
      await expect(operator.prepare({ kind: 1, entry: entry() })).rejects.toThrow(refusal);
      await expect(operator.anchor(entry())).rejects.toThrow(refusal);
      expect(w.submitted).toHaveLength(0);
    } finally { operator.close(); }
  });

  it("sends nothing of confirmed bytes once the generation no longer runs the node's runtime at the next block", async () => {
    pin(generation(500));
    const { operator, wallet: w } = setup();
    try {
      const prepared = await operator.prepare({ kind: 1, entry: entry() });
      pin(generation(499));
      await expect(operator.submit(prepared)).rejects.toThrow(refusal);
      expect(w.submitted).toHaveLength(0);
    } finally { operator.close(); }
  });

  it("holds a registry no generation pins only to the runtimes the submitter builds for", async () => {
    pin({ ...generation(499), address: "cd".repeat(32) });
    const { operator, wallet: w } = setup();
    try {
      const prepared = await operator.prepare({ kind: 1, entry: entry() });
      await operator.submit(prepared);
      expect(w.submitted).toHaveLength(1);
    } finally { operator.close(); }
  });
});
