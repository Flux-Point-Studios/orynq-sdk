/**
 * Manifest builder for flight recorder.
 * Constructs ManifestV2 from recording data.
 */

import type { ManifestV2, ChunkRef, VerifierPolicy, TeeType } from "../types.js";
import { sha256Json } from "../crypto/hashing.js";

export interface ManifestInput {
  agentId: string;
  sessionId: string;
  rootHash: string;
  merkleRoot: string;
  chunks: ChunkRef[];

  inputs: {
    promptHash: string;
    systemPromptHash?: string;
    toolContextHash?: string;
  };

  params: {
    model: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
  };

  runtime: {
    recorderVersion: string;
    nodeVersion?: string;
    containerDigest?: string;
    gitCommit?: string;
  };

  outputs: {
    transcriptRollingHash: string;
    toolCallCount: number;
    totalTokens: number;
    completionTokens: number;
  };

  timing: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
  };

  stats: {
    totalEvents: number;
    totalSpans: number;
  };

  attestation?: {
    teeType: TeeType;
    evidenceHash: string;
    evidenceUri?: string;
    verifierPolicy: VerifierPolicy;
    boundHash: "rootHash" | "manifestHash" | "merkleRoot";
  };
}

export class ManifestBuilder {
  /**
   * Build a ManifestV2 from input data.
   */
  async build(input: ManifestInput): Promise<ManifestV2> {
    const manifest: ManifestV2 = {
      formatVersion: "2.0",

      agentId: input.agentId,
      sessionId: input.sessionId,

      rootHash: input.rootHash,
      merkleRoot: input.merkleRoot,
      manifestHash: "", // Computed below

      inputs: input.inputs,
      params: input.params,
      runtime: input.runtime,
      chunks: input.chunks,
      outputs: input.outputs,

      createdAt: new Date().toISOString(),
      startedAt: input.timing.startedAt,
      endedAt: input.timing.endedAt,
      durationMs: input.timing.durationMs,

      totalEvents: input.stats.totalEvents,
      totalSpans: input.stats.totalSpans,
    };

    // Add attestation if provided
    if (input.attestation) {
      manifest.attestation = input.attestation;
    }

    // Compute manifest hash
    manifest.manifestHash = await this.computeManifestHash(manifest);

    return manifest;
  }

  /**
   * Compute the manifest hash.
   * Hash is computed over the manifest with manifestHash set to empty string.
   */
  async computeManifestHash(manifest: ManifestV2): Promise<string> {
    const toHash = { ...manifest, manifestHash: "" };
    return sha256Json(toHash, "manifest");
  }

  /**
   * Verify a manifest's integrity.
   */
  async verify(manifest: ManifestV2): Promise<boolean> {
    const expectedHash = await this.computeManifestHash(manifest);
    return manifest.manifestHash === expectedHash;
  }

  /**
   * Create a minimal manifest for testing.
   */
  static createMinimal(agentId: string, sessionId: string): ManifestV2 {
    const now = new Date().toISOString();
    return {
      formatVersion: "2.0",
      agentId,
      sessionId,
      rootHash: "",
      merkleRoot: "",
      manifestHash: "",
      inputs: { promptHash: "" },
      params: { model: "unknown" },
      runtime: { recorderVersion: "0.1.0" },
      chunks: [],
      outputs: {
        transcriptRollingHash: "",
        toolCallCount: 0,
        totalTokens: 0,
        completionTokens: 0,
      },
      createdAt: now,
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      totalEvents: 0,
      totalSpans: 0,
    };
  }
}
