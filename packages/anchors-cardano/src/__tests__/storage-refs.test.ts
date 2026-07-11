/**
 * @summary Tests for durable storageRefs in anchor metadata + verifyAnchor
 * auto-fetch (issue #61).
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildAnchorMetadata,
  parseAnchorMetadata,
  validateAnchorEntry,
  createAnchorEntryFromManifest,
  verifyAnchor,
  isAnchorEntry,
  POI_METADATA_LABEL,
} from "../index.js";
import type { AnchorEntry, AnchorChainProvider, StorageRef, TxInfo } from "../index.js";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceManifest, TraceBundle } from "@fluxpointstudios/orynq-sdk-process-trace";

const ROOT = "a".repeat(64);
const MANIFEST = "b".repeat(64);

const refs: StorageRef[] = [
  { type: "arweave", uri: "ar://abc123", hash: "sha256:deadbeef", size: 1024 },
  { type: "ipfs", uri: "ipfs://QmXyz", hash: "sha256:deadbeef" },
];

function entryWithRefs(): AnchorEntry {
  return {
    type: "process-trace",
    version: "1.0",
    rootHash: ROOT,
    manifestHash: MANIFEST,
    timestamp: "2026-01-01T00:00:00.000Z",
    storageRefs: refs,
  };
}

describe("storageRefs serialization round-trip", () => {
  it("survives buildAnchorMetadata -> parseAnchorMetadata", () => {
    const built = buildAnchorMetadata(entryWithRefs());
    const parsed = parseAnchorMetadata(built.json);
    expect(parsed.valid).toHaveLength(1);
    const out = parsed.valid[0]!;
    expect(out.storageRefs).toBeDefined();
    expect(out.storageRefs).toHaveLength(2);
    expect(out.storageRefs![0]!.uri).toBe("ar://abc123");
    expect(out.storageRefs![1]!.type).toBe("ipfs");
  });

  it("isAnchorEntry accepts entries with storageRefs", () => {
    expect(isAnchorEntry(entryWithRefs())).toBe(true);
  });

  it("validateAnchorEntry accepts valid storageRefs", () => {
    expect(validateAnchorEntry(entryWithRefs()).valid).toBe(true);
  });

  it("validateAnchorEntry rejects malformed storageRefs", () => {
    const bad = entryWithRefs();
    // @ts-expect-error intentionally malformed ref
    bad.storageRefs = [{ type: "ipfs", hash: "x" }]; // missing uri
    const result = validateAnchorEntry(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/storageRefs\[0\]\.uri/);
  });

  it("createAnchorEntryFromManifest embeds storageRefs", () => {
    const manifest = {
      manifestHash: MANIFEST,
      rootHash: ROOT,
      merkleRoot: "c".repeat(64),
      totalEvents: 3,
      agentId: "agent-1",
    } as unknown as TraceManifest;
    const entry = createAnchorEntryFromManifest(manifest, { storageRefs: refs });
    expect(entry.storageRefs).toHaveLength(2);
  });
});

describe("verifyAnchor fetchBundle", () => {
  async function realBundle(): Promise<TraceBundle> {
    const run = await createTrace({ agentId: "agent-refs" });
    const span = addSpan(run, { name: "work", visibility: "public" });
    await addEvent(run, span.id, {
      kind: "command",
      command: "run",
      visibility: "public",
    });
    await closeSpan(run, span.id);
    return finalizeTrace(run);
  }

  function provider(anchorRoot: string): AnchorChainProvider {
    const txInfo: TxInfo = {
      txHash: "tx1",
      blockHash: "blk",
      blockHeight: 1,
      slot: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      confirmations: 100,
    };
    return {
      getTxMetadata: async () =>
        buildAnchorMetadata({
          ...entryWithRefs(),
          rootHash: anchorRoot,
          storageRefs: [{ type: "https", uri: "https://gw.example/bundle.json", hash: "h" }],
        }).json,
      getTxInfo: async () => txInfo,
      getNetworkId: () => "preprod",
    };
  }

  it("attaches the bundle only when its content hashes to the anchor rootHash", async () => {
    const bundle = await realBundle();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(bundle),
    } as unknown as Response);

    const result = await verifyAnchor(provider(bundle.rootHash), "tx1", bundle.rootHash, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["gw.example"],
    });

    expect(result.valid).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith("https://gw.example/bundle.json");
    expect(result.bundle).toEqual(bundle);
    expect(result.warnings.some((w) => /does not match/i.test(w))).toBe(false);
  });

  it("fails (valid:false, no bundle) when the fetched content does not hash to the anchor rootHash", async () => {
    // Self-declared rootHash matches the anchor, but the content does NOT hash
    // to it — the old circular check trusted the declared field; now rejected.
    const forged = { rootHash: ROOT, merkleRoot: "c".repeat(64) };
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(forged),
    } as unknown as Response);

    const result = await verifyAnchor(provider(ROOT), "tx1", ROOT, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["gw.example"],
    });

    expect(result.valid).toBe(false);
    expect(result.bundle).toBeUndefined();
    expect(result.errors.some((e) => /integrity/i.test(e))).toBe(true);
  });

  it("does not fetch when fetchBundle is not set", async () => {
    const fetchFn = vi.fn();
    const result = await verifyAnchor(provider(ROOT), "tx1", ROOT, {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.valid).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.bundle).toBeUndefined();
  });
});
