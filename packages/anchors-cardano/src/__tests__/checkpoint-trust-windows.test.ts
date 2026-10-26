import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { certFormatOf, decodeReceiptRecord } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { createKoiosCheckpointSource } from "../providers/koios.js";
import { MATERIOS_CHECKPOINT_WALLET_PINS, verifyMateriosCheckpointAnchor, type MateriosCheckpointClaim } from "../materios-checkpoint-verifier.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/materios-checkpoint-mainnet.json", import.meta.url), "utf8"));
function setup(name = "wrapped5", edit: (row: any) => void = () => {}) {
  const b = fixture.batches[name];
  const receipt = decodeReceiptRecord(Buffer.from(fixture.receipts[b.receiptId], "hex"));
  const certFormat = certFormatOf(receipt, b.genesis, b.receiptId)!;
  const claim: MateriosCheckpointClaim = {
    genesis: b.genesis, receiptId: b.receiptId,
    cert: { certFormat, contentHash: receipt.contentHash, baseRootSha256: receipt.baseRootSha256, storageLocatorHash: receipt.storageLocatorHash },
    certifiedBlock: b.certifiedBlock, inclusion: { leafHashes: b.leafHashes },
    manifest: { fromBlock: b.fromBlock, toBlock: b.toBlock }, cardano: { txHash: b.txHash },
  };
  const source = createKoiosCheckpointSource({ network: "mainnet", retries: 0, fetchFn: (async (url, init) => {
    const key = `${init?.method ?? "GET"} ${String(url)} ${init?.body ?? ""}`;
    const body = structuredClone(fixture.koios[key]);
    if (key.includes("/tx_info")) for (const row of body) if (row.tx_hash === b.txHash) edit(row);
    return new Response(JSON.stringify(body));
  }) as typeof fetch });
  return { claim, options: { source, anchorWallets: MATERIOS_CHECKPOINT_WALLET_PINS } };
}

describe("wallet trust belongs to an encoding and bounded Cardano slot window", () => {
  it("accepts both inclusive boundaries and refuses a still-live key outside them", async () => {
    const pin = MATERIOS_CHECKPOINT_WALLET_PINS.find((p) => p.encoding === "flat")!;
    for (const slot of [pin.fromSlot, pin.toSlot]) {
      const { claim, options } = setup("flat1", (row) => { row.absolute_slot = slot; });
      expect((await verifyMateriosCheckpointAnchor(claim, options)).verified).toBe(true);
    }
    for (const slot of [pin.fromSlot - 1, pin.toSlot + 1, undefined]) {
      const { claim, options } = setup("flat1", (row) => { row.absolute_slot = slot; });
      expect((await verifyMateriosCheckpointAnchor(claim, options)).refusal?.check).toBe("wallet");
    }
  });

  it("refuses another encoding even when the funding address is pinned", async () => {
    const { claim, options } = setup();
    const anchorWallets = options.anchorWallets.map((pin) => ({ ...pin, encoding: "flat" as const }));
    expect((await verifyMateriosCheckpointAnchor(claim, { ...options, anchorWallets })).refusal?.check).toBe("wallet");
  });

  it("owns its trust-window snapshot while source calls are in flight", async () => {
    const pins = MATERIOS_CHECKPOINT_WALLET_PINS.map((pin) => ({ ...pin }));
    const lucid = pins.find((pin) => pin.encoding === "flat")!;
    const slot = lucid.toSlot + 1;
    const { claim, options } = setup("flat1", (row) => { row.absolute_slot = slot; lucid.toSlot = slot; });
    expect((await verifyMateriosCheckpointAnchor(claim, { ...options, anchorWallets: pins })).refusal?.check).toBe("wallet");
    expect(lucid.toSlot).toBe(slot);
  });

  it("rebuilds window-B dcbor certificates while keeping their historical commitment genesis", async () => {
    const { claim, options } = setup("legacyGenesis1");
    expect(claim.cert?.certFormat.format).toBe("dcbor-v1");
    const result = await verifyMateriosCheckpointAnchor(claim, options);
    expect(result.verified).toBe(true);
    expect(result.checks[0]!.detail).toContain(`checkpoint commitment genesis ${claim.genesis}`);
    expect(result.checks[0]!.detail).not.toContain("on Materios chain");
  });

  it("checks the FROM boundary independently before the manifest commitment", async () => {
    const { claim, options } = setup();
    claim.manifest.fromBlock--;
    expect((await verifyMateriosCheckpointAnchor(claim, options)).refusal?.check).toBe("blocks");
  });

  it.each(["extra-key", "non-string"])("enforces detailed-schema typed wrappers behind the real wallet pin (%s)", async (attack) => {
    const { claim, options } = setup("wrapped5", (row) => {
      const root = row.metadata["8746"].map.find((entry: any) => entry.k.string === "root");
      if (attack === "extra-key") root.k.extra = "root";
      else root.v.string = 123;
    });
    const result = await verifyMateriosCheckpointAnchor(claim, options);
    expect(result.refusal?.check).toBe("record");
    expect(result.refusal?.reason).toMatch(/detailed-schema/);
  });
});
