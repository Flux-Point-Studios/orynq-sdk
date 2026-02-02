/**
 * Main streaming flight recorder.
 * Captures inference events, manages chunking, and builds manifests.
 */

import { randomUUID } from "node:crypto";
import type {
  RecorderConfig,
  RecorderEvent,
  RecordingSession,
  RecordingResult,
  ManifestV2,
  AnchorEntry,
  InferenceParams,
} from "../types.js";
import { FlightRecorderException, FlightRecorderError } from "../types.js";
import { EventBuffer } from "./event-buffer.js";
import { ChunkManager } from "./chunk-manager.js";
import { rollingHash, buildMerkleRoot, sha256Json, sha256String } from "../crypto/hashing.js";

const RECORDER_VERSION = "0.1.0";

export class FlightRecorder {
  private session: RecordingSession | null = null;
  private buffer: EventBuffer;
  private chunkManager: ChunkManager;

  private rollingHashState = "";
  private startTime: Date | null = null;

  // Tracking for outputs
  private toolCallCount = 0;
  private totalTokens = 0;
  private completionTokens = 0;
  private transcriptHashes: string[] = [];

  // Tracking for inputs
  private promptHash: string | null = null;
  private systemPromptHash: string | null = null;
  private modelName: string | null = null;
  private inferenceParams: InferenceParams | null = null;

  // Spans
  private activeSpans = new Map<string, { name: string; startTime: Date }>();
  private completedSpanCount = 0;

  // Timeout for auto-chunking
  private chunkTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: RecorderConfig) {
    this.buffer = new EventBuffer(config.chunkSizeBytes);
    this.chunkManager = new ChunkManager(
      config.storage,
      config.encryption,
      "gzip"
    );
  }

  /**
   * Start a recording session.
   */
  async start(): Promise<RecordingSession> {
    if (this.session) {
      throw new FlightRecorderException(
        FlightRecorderError.RECORDING_ALREADY_FINALIZED,
        "Recording session already started"
      );
    }

    // Initialize encryption
    await this.chunkManager.initializeKey();

    // Initialize rolling hash with genesis
    this.rollingHashState = await sha256String("poi-flight-recorder:genesis:v2");

    this.startTime = new Date();

    this.session = {
      sessionId: this.config.sessionId || randomUUID(),
      agentId: this.config.agentId,
      startedAt: this.startTime.toISOString(),
      status: "recording",
    };

    // Start chunk timeout if configured
    if (this.config.chunkTimeoutMs) {
      this.startChunkTimeout();
    }

    return this.session;
  }

  /**
   * Record an event.
   */
  async record(event: Omit<RecorderEvent, "seq" | "ts">): Promise<void> {
    if (!this.session || this.session.status !== "recording") {
      throw new FlightRecorderException(
        FlightRecorderError.RECORDING_NOT_STARTED,
        "Recording not started or already finalized"
      );
    }

    // Add timestamp
    const eventWithTs = {
      ...event,
      ts: new Date().toISOString(),
    } as Omit<RecorderEvent, "seq">;

    // Track event-specific data
    await this.trackEventData(eventWithTs as RecorderEvent);

    // Add to buffer
    const shouldFlush = await this.buffer.add(eventWithTs);

    // Update rolling hash
    const eventJson = JSON.stringify(eventWithTs);
    this.rollingHashState = await rollingHash(
      this.rollingHashState,
      new TextEncoder().encode(eventJson)
    );

    // Flush if threshold reached
    if (shouldFlush) {
      await this.flushBuffer();
    }

    // Reset chunk timeout
    if (this.config.chunkTimeoutMs) {
      this.resetChunkTimeout();
    }
  }

  /**
   * Start a span for grouping related events.
   */
  startSpan(name: string): string {
    const spanId = randomUUID();
    this.activeSpans.set(spanId, { name, startTime: new Date() });
    return spanId;
  }

  /**
   * End a span.
   */
  endSpan(spanId: string): void {
    if (this.activeSpans.has(spanId)) {
      this.activeSpans.delete(spanId);
      this.completedSpanCount++;
    }
  }

  /**
   * Record an event within a span.
   */
  async recordInSpan<T>(
    _spanId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    // Note: spanId is used for grouping but not directly in this method
    const result = await fn();
    return result;
  }

  /**
   * Finalize the recording and produce a manifest.
   */
  async finalize(): Promise<RecordingResult> {
    if (!this.session || this.session.status !== "recording") {
      throw new FlightRecorderException(
        FlightRecorderError.RECORDING_NOT_STARTED,
        "Recording not started or already finalized"
      );
    }

    this.session.status = "finalizing";

    // Clear timeout
    if (this.chunkTimeout) {
      clearTimeout(this.chunkTimeout);
      this.chunkTimeout = null;
    }

    // Flush any remaining events
    if (!this.buffer.isEmpty()) {
      await this.flushBuffer();
    }

    // Build Merkle root from chunk hashes
    const leafHashes = this.chunkManager.getLeafHashes();
    const merkleRoot = await buildMerkleRoot(leafHashes);

    // Compute transcript rolling hash
    const transcriptRollingHash = this.transcriptHashes.length > 0
      ? await buildMerkleRoot(this.transcriptHashes)
      : await sha256String("empty-transcript");

    // Build manifest
    const manifest = await this.buildManifest(merkleRoot, transcriptRollingHash);

    // Compute manifest hash (excluding the manifestHash field itself)
    const manifestWithoutHash = { ...manifest, manifestHash: "" };
    const manifestHash = await sha256Json(manifestWithoutHash, "manifest");
    manifest.manifestHash = manifestHash;

    // Store manifest
    const manifestRef = await this.config.storage.storeManifest(manifest);

    // Get attestation if available
    let attestation;
    if (this.config.attestor?.isAttested()) {
      attestation = await this.config.attestor.attest(manifest.rootHash);
    }

    // Build anchor entry
    const anchorEntry: AnchorEntry = {
      schema: "poi-anchor-v2",
      rootHash: manifest.rootHash,
      merkleRoot: manifest.merkleRoot,
      manifestHash: manifest.manifestHash,
      storageUri: manifestRef.uri,
      agentId: this.config.agentId,
      sessionId: this.session.sessionId,
      timestamp: new Date().toISOString(),
    };

    this.session.status = "finalized";

    const result: RecordingResult = {
      rootHash: manifest.rootHash,
      merkleRoot: manifest.merkleRoot,
      manifestHash: manifest.manifestHash,
      manifest,
      chunkRefs: this.chunkManager.getChunks(),
      anchorEntry,
    };

    if (attestation) {
      result.attestation = attestation;
    }

    return result;
  }

  /**
   * Abort the recording.
   */
  async abort(reason?: string): Promise<void> {
    if (this.chunkTimeout) {
      clearTimeout(this.chunkTimeout);
      this.chunkTimeout = null;
    }

    if (this.session) {
      this.session.status = "aborted";
    }

    // Optionally log abort reason
    if (reason) {
      console.warn(`Recording aborted: ${reason}`);
    }
  }

  /**
   * Get current session info.
   */
  getSession(): RecordingSession | null {
    return this.session;
  }

  // === Private methods ===

  private async flushBuffer(): Promise<void> {
    const events = this.buffer.flush();
    if (events.length === 0) return;

    const first = events[0];
    const last = events[events.length - 1];
    if (!first || !last) return;

    const eventRange: [number, number] = [first.event.seq, last.event.seq];
    const spanIds = this.buffer.getSpanIds();

    try {
      await this.chunkManager.createChunk(events, eventRange, spanIds);
    } catch (error) {
      throw new FlightRecorderException(
        FlightRecorderError.CHUNK_CREATION_FAILED,
        "Failed to create chunk",
        error instanceof Error ? error : undefined
      );
    }
  }

  private async trackEventData(event: RecorderEvent): Promise<void> {
    switch (event.kind) {
      case "inference:start":
        this.promptHash = event.promptHash;
        this.systemPromptHash = event.systemPromptHash ?? null;
        this.modelName = event.model;
        this.inferenceParams = event.params;
        break;

      case "inference:end":
        this.totalTokens += event.tokenCounts.prompt + event.tokenCounts.completion;
        this.completionTokens += event.tokenCounts.completion;
        this.transcriptHashes.push(event.outputHash);
        break;

      case "tool:call":
        this.toolCallCount++;
        break;

      case "stream:chunk":
        this.transcriptHashes.push(event.chunkHash);
        break;
    }
  }

  private async buildManifest(
    merkleRoot: string,
    transcriptRollingHash: string
  ): Promise<ManifestV2> {
    const now = new Date();
    const durationMs = this.startTime
      ? now.getTime() - this.startTime.getTime()
      : 0;

    return {
      formatVersion: "2.0",
      agentId: this.config.agentId,
      sessionId: this.session!.sessionId,

      rootHash: this.rollingHashState,
      merkleRoot,
      manifestHash: "", // Filled in after computing

      inputs: this.buildInputs(),

      params: this.buildParams(),

      runtime: {
        recorderVersion: RECORDER_VERSION,
        nodeVersion: process.version,
        ...(this.config.captureRuntime ? this.captureRuntimeInfo() : {}),
      },

      chunks: this.chunkManager.getChunks(),

      outputs: {
        transcriptRollingHash,
        toolCallCount: this.toolCallCount,
        totalTokens: this.totalTokens,
        completionTokens: this.completionTokens,
      },

      createdAt: now.toISOString(),
      startedAt: this.startTime?.toISOString() || now.toISOString(),
      endedAt: now.toISOString(),
      durationMs,

      totalEvents: this.buffer.getSeq(),
      totalSpans: this.completedSpanCount,
    };
  }

  private captureRuntimeInfo(): Partial<ManifestV2["runtime"]> {
    // Basic runtime capture - can be extended
    return {
      nodeVersion: process.version,
    };
  }

  private buildInputs(): ManifestV2["inputs"] {
    const inputs: ManifestV2["inputs"] = {
      promptHash: this.promptHash || "",
    };
    if (this.systemPromptHash) {
      inputs.systemPromptHash = this.systemPromptHash;
    }
    return inputs;
  }

  private buildParams(): ManifestV2["params"] {
    const params: ManifestV2["params"] = {
      model: this.modelName || "unknown",
    };
    if (this.inferenceParams?.temperature !== undefined) {
      params.temperature = this.inferenceParams.temperature;
    }
    if (this.inferenceParams?.topP !== undefined) {
      params.topP = this.inferenceParams.topP;
    }
    if (this.inferenceParams?.topK !== undefined) {
      params.topK = this.inferenceParams.topK;
    }
    if (this.inferenceParams?.maxTokens !== undefined) {
      params.maxTokens = this.inferenceParams.maxTokens;
    }
    if (this.inferenceParams?.stopStrings !== undefined) {
      params.stopStrings = this.inferenceParams.stopStrings;
    }
    if (this.inferenceParams?.frequencyPenalty !== undefined) {
      params.frequencyPenalty = this.inferenceParams.frequencyPenalty;
    }
    if (this.inferenceParams?.presencePenalty !== undefined) {
      params.presencePenalty = this.inferenceParams.presencePenalty;
    }
    return params;
  }

  private startChunkTimeout(): void {
    this.chunkTimeout = setTimeout(async () => {
      if (!this.buffer.isEmpty()) {
        await this.flushBuffer();
      }
      this.startChunkTimeout();
    }, this.config.chunkTimeoutMs);
  }

  private resetChunkTimeout(): void {
    if (this.chunkTimeout) {
      clearTimeout(this.chunkTimeout);
      this.startChunkTimeout();
    }
  }
}
