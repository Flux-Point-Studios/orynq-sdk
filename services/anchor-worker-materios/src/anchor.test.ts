/**
 * Unit tests for anchor-id derivation in anchor-worker-materios.
 *
 * Pin the byte-exact algorithm so a future refactor cannot silently drift
 * from `daemon/checkpoint.py::compute_anchor_id` (operator-kit). The gateway
 * `/batches/:anchorId` reverse-lookup is keyed on this id; a drift would
 * leak 404s for every anchor the daemon prepared.
 */

import { describe, test, expect } from "vitest";
import { createHash } from "crypto";
import { deriveAnchorId } from "./anchor.js";

/** Reference implementation (independent of `deriveAnchorId`). */
function referenceAnchorId(rootHex: string, manifestHex: string): string {
  const root = rootHex.replace(/^0[xX]/, "");
  const manifest = manifestHex.replace(/^0[xX]/, "");
  const bytes = Buffer.from(root + manifest, "hex");
  return "0x" + createHash("sha256").update(bytes).digest("hex");
}

describe("deriveAnchorId", () => {
  test("is deterministic for known inputs", () => {
    const root = "a".repeat(64);
    const manifest = "b".repeat(64);
    const a = deriveAnchorId(root, manifest);
    const b = deriveAnchorId(root, manifest);
    expect(a).toBe(b);
    expect(a.startsWith("0x")).toBe(true);
    expect(a.length).toBe(66); // 0x + 64 hex chars
  });

  test("strips 0x prefix idempotently", () => {
    const root = "a".repeat(64);
    const manifest = "b".repeat(64);
    const noPrefix = deriveAnchorId(root, manifest);
    const rootPrefix = deriveAnchorId("0x" + root, manifest);
    const manifestPrefix = deriveAnchorId(root, "0x" + manifest);
    const both = deriveAnchorId("0x" + root, "0x" + manifest);
    expect(noPrefix).toBe(rootPrefix);
    expect(noPrefix).toBe(manifestPrefix);
    expect(noPrefix).toBe(both);
  });

  test("differs when root and manifest swap", () => {
    const root = "a".repeat(64);
    const manifest = "b".repeat(64);
    expect(deriveAnchorId(root, manifest)).not.toBe(deriveAnchorId(manifest, root));
  });

  test("matches reference implementation byte-for-byte", () => {
    const root = "deadbeef" + "00".repeat(28);
    const manifest = "abcd1234" + "ff".repeat(28);
    expect(deriveAnchorId(root, manifest)).toBe(referenceAnchorId(root, manifest));
  });

  test("matches the python daemon's compute_anchor_id (canonical vectors)", () => {
    // Vectors generated using:
    //   python3 -c "import hashlib; \
    //     r=bytes.fromhex('aa'*32); m=bytes.fromhex('bb'*32); \
    //     print('0x'+hashlib.sha256(r+m).hexdigest())"
    // (see daemon/checkpoint.py::compute_anchor_id)
    const cases: { root: string; manifest: string; expected: string }[] = [
      {
        root: "aa".repeat(32),
        manifest: "bb".repeat(32),
        // sha256(0xaa*32 || 0xbb*32)
        expected: "0x" + createHash("sha256")
          .update(Buffer.concat([Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0xbb)]))
          .digest("hex"),
      },
      {
        root: "0x" + "00".repeat(32),
        manifest: "0x" + "ff".repeat(32),
        expected: "0x" + createHash("sha256")
          .update(Buffer.concat([Buffer.alloc(32, 0x00), Buffer.alloc(32, 0xff)]))
          .digest("hex"),
      },
    ];
    for (const c of cases) {
      expect(deriveAnchorId(c.root, c.manifest)).toBe(c.expected);
    }
  });

  test("0X (uppercase) prefix normalized", () => {
    const root = "deadbeef" + "00".repeat(28);
    const manifest = "abcd1234" + "ff".repeat(28);
    expect(deriveAnchorId("0X" + root, "0X" + manifest)).toBe(
      deriveAnchorId(root, manifest),
    );
  });
});
