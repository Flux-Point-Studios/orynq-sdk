/**
 * @summary Round-2 hardening regression tests for anchor verification (#61).
 *
 * Each suite reproduces an exploit an adversarial re-review surfaced:
 *  1. Span-hash trust — `recomputeBundleRootHash` must recompute each span hash
 *     from the span's actual header + events, NOT the self-declared `span.hash`.
 *     Tampering a span header while leaving `span.hash` stale must fail integrity.
 *  2. SSRF bypasses — IPv4-mapped IPv6 metadata address, and arbitrary DNS hosts
 *     when `allowedHosts` is omitted, must be rejected.
 *  3. Size cap — a body with no content-length larger than the cap must be
 *     rejected while streaming, not buffered whole.
 */

import { describe, it, expect, vi } from "vitest";
import { verifyAnchor } from "../anchor-verifier.js";
import { POI_METADATA_LABEL } from "../types.js";
import type { AnchorChainProvider, AnchorEntry, TxInfo } from "../types.js";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceBundle } from "@fluxpointstudios/orynq-sdk-process-trace";

const VALID_HASH = "a".repeat(64);
const VALID_HASH_2 = "b".repeat(64);

function createValidEntry(overrides?: Partial<AnchorEntry>): AnchorEntry {
  return {
    type: "process-trace",
    version: "1.0",
    rootHash: VALID_HASH,
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

function createMockProvider(overrides?: Partial<AnchorChainProvider>): AnchorChainProvider {
  return {
    getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([createValidEntry()])),
    getTxInfo: vi.fn().mockResolvedValue({
      txHash: "tx",
      blockHash: "block",
      blockHeight: 1000,
      slot: 50000,
      timestamp: "2024-01-28T12:00:00Z",
      confirmations: 50,
    } as TxInfo),
    getNetworkId: vi.fn().mockReturnValue("preprod"),
    ...overrides,
  };
}

async function buildRealBundle(): Promise<TraceBundle> {
  const run = await createTrace({ agentId: "agent-c61" });
  const span = addSpan(run, {
    name: "work",
    visibility: "public",
    metadata: { stage: "honest" },
  });
  await addEvent(run, span.id, { kind: "command", command: "do the thing", visibility: "public" });
  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("recomputeBundleRootHash: span hash is recomputed, not trusted (#61)", () => {
  it("span-header tampering with a stale span.hash fails integrity", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;

    // Attacker rewrites a span HEADER field (metadata) that auditors read, but
    // leaves the self-declared span.hash untouched. Rolling hash is unaffected
    // (it derives from events), so a verifier that trusts span.hash would still
    // recompute the honest root and wrongly pass.
    const forged = JSON.parse(JSON.stringify(bundle)) as TraceBundle;
    const span = forged.privateRun.spans[0]! as Record<string, unknown>;
    (span.metadata as Record<string, unknown>) = { stage: "TAMPERED" };
    // span.hash is deliberately left as the honest value.

    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [{ type: "https", uri: "https://storage.example.com/b.json", hash: "" }],
    });
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(forged));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["storage.example.com"],
    });

    expect(result.valid).toBe(false);
    expect(result.bundle).toBeUndefined();
  });

  it("an honest bundle still verifies", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [{ type: "https", uri: "https://storage.example.com/b.json", hash: "" }],
    });
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(bundle));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["storage.example.com"],
    });
    expect(result.valid).toBe(true);
    expect(result.bundle).toBeDefined();
  });
});

describe("SSRF hardening round 2 (#61)", () => {
  it("rejects an IPv4-mapped IPv6 metadata address", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [
        { type: "https", uri: "https://[::ffff:169.254.169.254]/latest/meta-data", hash: "" },
      ],
    });
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(bundle));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.bundle).toBeUndefined();
  });

  it("rejects an arbitrary DNS host when allowedHosts is omitted", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [{ type: "https", uri: "https://evil.attacker.example/b.json", hash: "" }],
    });
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(bundle));

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      // allowedHosts intentionally omitted
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.bundle).toBeUndefined();
    expect(result.warnings.some((w) => /allow-?list|host/i.test(w))).toBe(true);
  });
});

describe("readCapped enforces the cap while streaming (#61)", () => {
  it("rejects an oversize body that declares no content-length", async () => {
    const bundle = await buildRealBundle();
    const anchorRoot = bundle.rootHash;
    const entry = createValidEntry({
      rootHash: anchorRoot,
      storageRefs: [{ type: "https", uri: "https://storage.example.com/big.json", hash: "" }],
    });
    const provider = createMockProvider({
      getTxMetadata: vi.fn().mockResolvedValue(createValidMetadata([entry])),
    });

    // A huge body streamed in chunks, with NO content-length header. The cap
    // must be enforced mid-stream — text() (buffer-then-measure) must not be the
    // gate. If the body were buffered whole first, this would OOM/pass.
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const totalChunks = 40; // ~2.5 MiB, over a 1 MiB cap
    const body = {
      getReader() {
        return {
          async read() {
            if (sent >= totalChunks) return { done: true, value: undefined };
            sent += 1;
            return { done: false, value: chunk };
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
      // Buffer-then-measure must NOT be the gate: res.text() here would OOM in
      // production. A correct streaming cap rejects via the reader before ever
      // materializing the whole body. We fail the test if text() is consulted.
      text: async () => {
        throw new Error("readCapped buffered the whole body via text() (cap bypass)");
      },
    } as unknown as Response;
    const fetchFn = vi.fn().mockResolvedValue(res);

    const result = await verifyAnchor(provider, "tx123", anchorRoot, {
      fetchBundle: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowedHosts: ["storage.example.com"],
      maxBundleBytes: 1024 * 1024,
    });

    expect(result.bundle).toBeUndefined();
    expect(result.warnings.some((w) => /size cap|exceeds/i.test(w))).toBe(true);
  });
});
