/**
 * @summary Tests for pre-execution model-manifest pinning (issue #59).
 */

import { describe, it, expect, vi } from "vitest";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  verifyBundle,
  computeModelManifestHash,
  validateModelManifest,
  manifestFromHuggingFace,
  manifestFromOpenAI,
  manifestFromAnthropic,
} from "../index.js";
import type { ModelManifest } from "../index.js";

async function sampleManifest(): Promise<ModelManifest> {
  return manifestFromHuggingFace({
    modelId: "meta-llama/Llama-3.1-8B",
    revision: "0e9e39f249a16976918f6564b8830bc894c89659",
    tokenizerHash: "sha256:deadbeef",
  });
}

describe("model-manifest builders", () => {
  it("produces a deterministic manifestHash for identical inputs", async () => {
    const a = await manifestFromHuggingFace({ modelId: "m", revision: "abc" });
    const b = await manifestFromHuggingFace({ modelId: "m", revision: "abc" });
    expect(await computeModelManifestHash(a)).toBe(await computeModelManifestHash(b));
  });

  it("changes the manifestHash when the revision changes", async () => {
    const a = await manifestFromHuggingFace({ modelId: "m", revision: "abc" });
    const c = await manifestFromHuggingFace({ modelId: "m", revision: "def" });
    expect(await computeModelManifestHash(a)).not.toBe(await computeModelManifestHash(c));
  });

  it("records the framework and identity for OpenAI / Anthropic", async () => {
    const openai = await manifestFromOpenAI({ model: "gpt-4o", snapshotId: "gpt-4o-2024-08-06" });
    expect(openai.framework).toBe("openai");
    expect(openai.modelId).toBe("gpt-4o");
    expect(openai.modelHash.startsWith("sha256:")).toBe(true);

    const anthropic = await manifestFromAnthropic({
      model: "claude-3-5-sonnet",
      snapshotId: "claude-3-5-sonnet-20241022",
    });
    expect(anthropic.framework).toBe("anthropic");
    expect(anthropic.revision).toBe("claude-3-5-sonnet-20241022");
  });

  it("hashes a raw system prompt into systemPromptHash", async () => {
    const m = await manifestFromHuggingFace({
      modelId: "m",
      systemPrompt: "You are a helpful assistant.",
    });
    expect(m.systemPromptHash?.startsWith("sha256:")).toBe(true);
  });

  it("validateModelManifest requires a modelHash", () => {
    expect(() => validateModelManifest({ modelHash: "" } as ModelManifest)).toThrow(/modelHash/);
  });
});

describe("createTrace manifest pinning", () => {
  it("pins the manifest hash at creation and freezes the manifest", async () => {
    const manifest = await sampleManifest();
    const run = await createTrace({ agentId: "agent-1", manifest });

    expect(run.modelManifestHash).toBeDefined();
    expect(run.modelManifestHash).toBe(await computeModelManifestHash(manifest));
    expect(run.modelManifest).toBe(manifest);

    // Immutability: mutating the pinned manifest throws (frozen).
    expect(() => {
      (run.modelManifest as unknown as Record<string, unknown>).modelHash = "tampered";
    }).toThrow();
  });

  it("rejects strict createTrace without a manifest", async () => {
    await expect(createTrace({ agentId: "agent-1", strict: true })).rejects.toThrow(
      /strict mode requires/i
    );
  });
});

describe("finalizeTrace manifest enforcement", () => {
  it("carries the manifest onto the bundle and public view, and verifies", async () => {
    const manifest = await manifestFromOpenAI({
      model: "gpt-4o",
      snapshotId: "gpt-4o-2024-08-06",
    });
    const run = await createTrace({ agentId: "agent-1", manifest, strict: true });
    const span = addSpan(run, { name: "infer", visibility: "public" });
    await addEvent(run, span.id, {
      kind: "observation",
      observation: "ok",
      visibility: "public",
    });
    await closeSpan(run, span.id);

    const bundle = await finalizeTrace(run);

    expect(bundle.modelManifestHash).toBe(run.modelManifestHash);
    expect(bundle.modelManifest?.framework).toBe("openai");
    expect(bundle.publicView.modelManifestHash).toBe(run.modelManifestHash);

    const result = await verifyBundle(bundle);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("refuses to finalize a strict run with no manifest", async () => {
    const run = await createTrace({ agentId: "agent-1" });
    run.strict = true; // simulate a run that should have been pinned
    await expect(finalizeTrace(run)).rejects.toThrow(/strict mode requires a model manifest/i);
  });

  it("warns (warn-only path) when finalizing an unpinned non-strict run", async () => {
    const run = await createTrace({ agentId: "agent-1" });
    const span = addSpan(run, { name: "s", visibility: "public" });
    await addEvent(run, span.id, { kind: "observation", observation: "ok", visibility: "public" });
    await closeSpan(run, span.id);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bundle = await finalizeTrace(run);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    expect(bundle.modelManifestHash).toBeUndefined();
  });
});
