/**
 * Adapter for migrating from poi-openclaw to flight-recorder.
 * Bridges legacy trace formats to the new ManifestV2 format.
 */

import type {
  RecorderConfig,
  RecordingResult,
  ManifestV2,
  InferenceStartEvent,
  InferenceEndEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "../types.js";
import { FlightRecorder } from "../recorder/stream-recorder.js";
import { sha256String } from "../crypto/hashing.js";

/**
 * Partial event types without seq and ts (added by recorder).
 */
type PartialInferenceStart = Omit<InferenceStartEvent, "seq" | "ts">;
type PartialInferenceEnd = Omit<InferenceEndEvent, "seq" | "ts">;
type PartialToolCall = Omit<ToolCallEvent, "seq" | "ts">;
type PartialToolResult = Omit<ToolResultEvent, "seq" | "ts">;
type PartialRecorderEvent = PartialInferenceStart | PartialInferenceEnd | PartialToolCall | PartialToolResult;

/**
 * Legacy trace event format from poi-openclaw.
 */
export interface LegacyTraceEvent {
  ts: string;
  kind: "user" | "assistant" | "tool_call" | "tool_result";
  agentId?: string;
  sessionId?: string;
  contentHash: string;
  content?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Legacy trace bundle from poi-openclaw.
 */
export interface LegacyTraceBundle {
  bundleId: string;
  events: LegacyTraceEvent[];
}

/**
 * Legacy manifest format from poi-openclaw.
 */
export interface LegacyManifest {
  formatVersion: string;
  agentId: string;
  rootHash: string;
  manifestHash: string;
  merkleRoot: string;
  totalEvents: number;
  totalSpans: number;
  createdAt: string;
  metadata?: { bundlePath?: string };
}

/**
 * Adapter to bridge poi-openclaw traces to flight-recorder.
 */
export class OpenClawAdapter {
  constructor(private readonly config: RecorderConfig) {}

  /**
   * Convert a legacy trace bundle to a new recording.
   */
  async importLegacyBundle(bundle: LegacyTraceBundle): Promise<RecordingResult> {
    const recorder = new FlightRecorder({
      ...this.config,
      sessionId: bundle.bundleId,
    });

    await recorder.start();

    for (const event of bundle.events) {
      const converted = await this.convertEvent(event);
      if (converted) {
        await recorder.record(converted);
      }
    }

    return recorder.finalize();
  }

  /**
   * Convert a legacy event to a RecorderEvent.
   */
  private convertEvent(event: LegacyTraceEvent): PartialRecorderEvent | null {
    switch (event.kind) {
      case "user": {
        const result: PartialInferenceStart = {
          kind: "inference:start",
          requestId: `req-${Date.now()}`,
          model: "unknown",
          promptHash: event.contentHash,
          params: {},
        };
        if (event.sessionId) result.spanId = event.sessionId;
        return result;
      }

      case "assistant": {
        const result: PartialInferenceEnd = {
          kind: "inference:end",
          requestId: `req-${Date.now()}`,
          outputHash: event.contentHash,
          tokenCounts: { prompt: 0, completion: 0 },
          durationMs: 0,
        };
        if (event.sessionId) result.spanId = event.sessionId;
        return result;
      }

      case "tool_call": {
        const result: PartialToolCall = {
          kind: "tool:call",
          toolName: (event.meta?.toolName as string) || "unknown",
          argsHash: event.contentHash,
          visibility: "private",
        };
        if (event.sessionId) result.spanId = event.sessionId;
        return result;
      }

      case "tool_result": {
        const result: PartialToolResult = {
          kind: "tool:result",
          toolName: (event.meta?.toolName as string) || "unknown",
          resultHash: event.contentHash,
          success: true,
          visibility: "private",
        };
        if (event.sessionId) result.spanId = event.sessionId;
        return result;
      }

      default:
        return null;
    }
  }

  /**
   * Convert a legacy manifest to ManifestV2 format.
   */
  async convertManifest(legacy: LegacyManifest): Promise<ManifestV2> {
    const now = new Date().toISOString();

    return {
      formatVersion: "2.0",
      agentId: legacy.agentId,
      sessionId: legacy.metadata?.bundlePath || `migrated-${Date.now()}`,

      rootHash: legacy.rootHash,
      merkleRoot: legacy.merkleRoot,
      manifestHash: await sha256String(JSON.stringify(legacy)),

      inputs: {
        promptHash: "", // Not available in legacy format
      },

      params: {
        model: "unknown",
      },

      runtime: {
        recorderVersion: "migrated-from-openclaw",
      },

      chunks: [], // Legacy format doesn't have chunks

      outputs: {
        transcriptRollingHash: legacy.rootHash,
        toolCallCount: 0,
        totalTokens: 0,
        completionTokens: 0,
      },

      createdAt: legacy.createdAt,
      startedAt: legacy.createdAt,
      endedAt: now,
      durationMs: 0,

      totalEvents: legacy.totalEvents,
      totalSpans: legacy.totalSpans,
    };
  }

  /**
   * Check if a manifest is in legacy format.
   */
  static isLegacyManifest(manifest: unknown): manifest is LegacyManifest {
    if (!manifest || typeof manifest !== "object") return false;
    const m = manifest as Record<string, unknown>;
    return (
      typeof m.formatVersion === "string" &&
      m.formatVersion.startsWith("1.") &&
      typeof m.agentId === "string" &&
      typeof m.rootHash === "string"
    );
  }
}
