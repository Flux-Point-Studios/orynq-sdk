import { describe, expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { buildRegistryDeploy, decodeAnchorTransaction, unprovenRegistryCall } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { provingService } from "../src/zk.js";

const zkDir = process.env.MIDNIGHT_PP;
if (!zkDir) throw new Error("MIDNIGHT_PP must name the directory tools/compactc/install.sh filled");
const random32 = () => crypto.getRandomValues(new Uint8Array(32));

// The operator's proving path end to end: zkir-v2 in the wallet SDK's worker thread, asking this
// process for key material, which keyMaterial serves only as pinned.
describe("provingService", () => {
  it("proves a registry anchor in a worker thread, and the bound bytes decode as exactly that anchor", async () => {
    const ttl = new Date(Date.now() + 3600e3);
    const deploy = buildRegistryDeploy({ networkId: "preprod", ttl });
    const state = ([...deploy.tx.intents!.values()][0]!.actions[0] as L.ContractDeploy).initialState;
    const commitment = random32();
    const { tx } = unprovenRegistryCall({ networkId: "preprod", address: deploy.address, state, call: { circuit: "anchor", args: [commitment, 1n] }, witnesses: { authorSecret: random32() }, ttl });
    const proven = await provingService(zkDir).prove(tx);
    const bytes = proven.bind().serialize();
    const { calls } = decodeAnchorTransaction(bytes, [deploy.address]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ entryPoint: "anchor", kind: 1, commitment: Buffer.from(commitment).toString("hex") });
    expect(bytes.length).toBeGreaterThan(4000);
  });
});
