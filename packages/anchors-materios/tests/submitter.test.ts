import { describe, it, expect } from "vitest";
import type { AnchorEntry } from "../src/types.js";

describe("submitAnchor", () => {
  it("should have correct AnchorEntry shape", () => {
    const entry: AnchorEntry = {
      type: "process-trace",
      version: "1.0",
      rootHash: "sha256:abc123",
      manifestHash: "sha256:def456",
      timestamp: new Date().toISOString(),
    };
    expect(entry.type).toBe("process-trace");
    expect(entry.version).toBe("1.0");
    expect(entry.rootHash).toBeDefined();
    expect(entry.manifestHash).toBeDefined();
  });
});
