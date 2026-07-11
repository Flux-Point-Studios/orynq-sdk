/**
 * @summary Round-3 hardening regression tests for anchor verification (#61).
 *
 *  1. fetchBundle fail-closed — when `fetchBundle:true` is requested but NO ref
 *     was successfully fetched AND integrity-verified (SSRF-blocked, HTTP error,
 *     size-cap, network error), the result must be valid:false with a hard
 *     error, not a warning-only valid:true.
 *  2. Redundancy — a poisoned first mirror (rootHash mismatch / non-bundle doc)
 *     must NOT DoS verification of the honest remaining refs: iterate all refs;
 *     first that fetches + hash-matches wins.
 *  3. Size-cap — the on-chain `ref.size` must never REDUCE the read below
 *     `maxBytes`; a valid bundle up to maxBytes is always fully read even when
 *     `ref.size` under-declares it. (`ref.size > maxBytes` is an early reject.)
 */

import { describe, it, expect, vi } from "vitest";
import { verifyAnchor } from "../anchor-verifier.js";
import { POI_METADATA_LABEL } from "../types.js";
import type { AnchorChainProvider, AnchorEntry, TxInfo, StorageRef } from "../types.js";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceBundle } from "@fluxpointstudios/orynq-sdk-process-trace";

const VALID_HASH_2 = "b".repeat(64);

function createValidEntry(overrides?: Partial<AnchorEntry>): AnchorEntry {
  return {
    type: "process-trace",
    version: "1.0",
    rootHash: "a".repeat(64),
    manifestHash: VALID_HASH_2,
    timestamp: "2024-01-28T12:00:00Z",
    ...overrides,
  };
}

function createValidMetadata(entries: AnchorEntry[]) {
  return {
    [POI_METADATA_LABEL.toString()]: { schema: "poi-anchor-v1", anchors: entries },
  };
}

function createMockProvider(entry: AnchorEntry): AnchorChainProvider {
  return {
    getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    getTxInfo: vi.fn().mockResolvedValue({
      txHash: "tx",
      blockHash: "block",
      blockHeight: 1000,
      slot: 50000,
      timestamp: "2024-01-28T12:00:00Z",
      confirmations: 50,
    } as TxInfo),
    getNetworkId: vi.fn().mockReturnValue("preprod"),
  };
}

async function buildRealBundle(): Promise<TraceBundle> {
  const run = await createTrace({ agentId: "agent-c61-r3" });
  const span = addSpan(run, { name: "work", visibility: "public" });
  await addEvent(run, span.id, { kind: "command", command: "do the thing", visibility: "public" });
  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("fetchBundle fails closed when nothing is fetched+verified (#61 round-3)", () => {
  it("SSRF-blocked-only → valid:false", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [{ type: "https", uri: "https://[::ffff:169.254.169.254]/meta", hash: "" }],
    });
    const provider = createMockProvider(entry);
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(bundle));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.valid).toBe(false);
    expect(result.bundle).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("404-only → valid:false", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [{ type: "https", uri: "https://storage.example.com/b.json", hash: "" }],
    });
    const provider = createMockProvider(entry);
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse("not found", 404));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["storage.example.com"],
    });

    expect(result.valid).toBe(false);
    expect(result.bundle).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("network-error-only → valid:false", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [{ type: "https", uri: "https://storage.example.com/b.json", hash: "" }],
    });
    const provider = createMockProvider(entry);
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["storage.example.com"],
    });

    expect(result.valid).toBe(false);
    expect(result.bundle).toBeUndefined();
  });
});

describe("redundant refs: a poisoned first mirror does not DoS the honest ones (#61 round-3)", () => {
  it("recovers when the second ref hash-matches after the first mismatches", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;

    // First ref serves a tampered bundle (rootHash mismatch); second serves the honest one.
    const forged = JSON.parse(JSON.stringify(bundle)) as TraceBundle;
    (forged.privateRun.spans[0]! as Record<string, unknown>).metadata = { poisoned: true };

    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [
        { type: "https", uri: "https://mirror1.example.com/b.json", hash: "" },
        { type: "https", uri: "https://mirror2.example.com/b.json", hash: "" },
      ],
    });
    const provider = createMockProvider(entry);
    const fetchFn = vi.fn(async (url: string) =>
      url.includes("mirror1") ? jsonResponse(forged) : jsonResponse(bundle)
    );

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["mirror1.example.com", "mirror2.example.com"],
    });

    expect(fetchFn).toHaveBeenCalledTimes(2); // it did NOT stop after mirror1
    expect(result.valid).toBe(true);
    expect(result.bundle).toBeDefined();
  });

  it("recovers when the first ref returns a non-bundle document", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [
        { type: "https", uri: "https://mirror1.example.com/oops.json", hash: "" },
        { type: "https", uri: "https://mirror2.example.com/b.json", hash: "" },
      ],
    });
    const provider = createMockProvider(entry);
    const fetchFn = vi.fn(async (url: string) =>
      url.includes("mirror1") ? jsonResponse({ not: "a bundle" }) : jsonResponse(bundle)
    );

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["mirror1.example.com", "mirror2.example.com"],
    });

    expect(result.valid).toBe(true);
    expect(result.bundle).toBeDefined();
  });

  it("all refs poisoned → valid:false", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const forged = JSON.parse(JSON.stringify(bundle)) as TraceBundle;
    (forged.privateRun.spans[0]! as Record<string, unknown>).metadata = { poisoned: true };
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [
        { type: "https", uri: "https://mirror1.example.com/b.json", hash: "" },
        { type: "https", uri: "https://mirror2.example.com/b.json", hash: "" },
      ],
    });
    const provider = createMockProvider(entry);
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(forged));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["mirror1.example.com", "mirror2.example.com"],
    });

    expect(result.valid).toBe(false);
    expect(result.bundle).toBeUndefined();
  });
});

describe("DNS-rebinding guard: DNS hosts require an explicit allowedHosts (#61 round-3)", () => {
  it("a DNS host with no allowedHosts is rejected without fetching", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [{ type: "https", uri: "https://storage.example.com/b.json", hash: "" }],
    });
    const provider = createMockProvider(entry);
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(bundle));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      // allowedHosts omitted — a DNS host must not be fetched (rebind TOCTOU).
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.valid).toBe(false);
    expect(result.bundle).toBeUndefined();
    expect(result.warnings.some((w) => /allowedHosts|rebind/i.test(w))).toBe(true);
  });
});

describe("ref.size must not truncate a valid bundle below maxBytes (#61 round-3)", () => {
  it("an under-declared ref.size still reads + verifies a bundle within maxBytes", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const fullText = JSON.stringify(bundle);

    // Attacker under-declares size to 5 bytes, hoping to truncate the read so the
    // hash check fails (griefing). maxBytes is generous; the read must not be capped to 5.
    const ref: StorageRef = {
      type: "https",
      uri: "https://storage.example.com/b.json",
      hash: "",
      size: 5,
    };
    const entry = createValidEntry({ rootHash: anchorRoot, storageRefs: [ref] });
    const provider = createMockProvider(entry);

    // A streaming body that yields the full text in one chunk. If refCap were
    // min(ref.size, maxBytes)=5, readCapped would reject as over-cap.
    const encoded = new TextEncoder().encode(fullText);
    let sent = false;
    const body = {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: encoded };
          },
          releaseLock() {},
          cancel() {},
        };
      },
    };
    const res = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body,
      text: async () => fullText,
    } as unknown as Response;
    const fetchFn = vi.fn().mockResolvedValue(res);

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["storage.example.com"],
      maxBundleBytes: 1024 * 1024,
    });

    expect(result.valid).toBe(true);
    expect(result.bundle).toBeDefined();
  });

  it("rejects a ref whose declared size exceeds maxBytes before fetching", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const ref: StorageRef = {
      type: "https",
      uri: "https://storage.example.com/huge.json",
      hash: "",
      size: 5 * 1024 * 1024, // over the 1 MiB cap
    };
    const entry = createValidEntry({ rootHash: anchorRoot, storageRefs: [ref] });
    const provider = createMockProvider(entry);
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(bundle));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["storage.example.com"],
      maxBundleBytes: 1024 * 1024,
    });

    expect(fetchFn).not.toHaveBeenCalled(); // early-rejected without a fetch
    expect(result.valid).toBe(false);
    expect(result.bundle).toBeUndefined();
  });
});
