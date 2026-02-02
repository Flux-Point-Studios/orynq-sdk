/**
 * In-memory event buffer for the flight recorder.
 * Buffers events until chunk threshold is reached.
 */

import type { RecorderEvent } from "../types.js";
import { sha256Json } from "../crypto/hashing.js";

export interface BufferedEvent {
  event: RecorderEvent;
  serialized: Uint8Array;
  hash: string;
}

export interface BufferStats {
  eventCount: number;
  byteSize: number;
  oldestEventTs: string | null;
  newestEventTs: string | null;
}

export class EventBuffer {
  private events: BufferedEvent[] = [];
  private byteSize = 0;
  private seq = 0;

  constructor(private readonly maxSizeBytes: number) {}

  /**
   * Add an event to the buffer.
   * Returns true if buffer should be flushed (threshold reached).
   */
  async add(event: Omit<RecorderEvent, "seq">): Promise<boolean> {
    const seqEvent = { ...event, seq: this.seq++ } as RecorderEvent;
    const serialized = new TextEncoder().encode(JSON.stringify(seqEvent));
    const hash = await sha256Json(seqEvent, "event");

    this.events.push({
      event: seqEvent,
      serialized,
      hash,
    });

    this.byteSize += serialized.length;

    return this.byteSize >= this.maxSizeBytes;
  }

  /**
   * Get all buffered events and clear the buffer.
   */
  flush(): BufferedEvent[] {
    const events = this.events;
    this.events = [];
    this.byteSize = 0;
    return events;
  }

  /**
   * Peek at buffered events without clearing.
   */
  peek(): BufferedEvent[] {
    return [...this.events];
  }

  /**
   * Get buffer statistics.
   */
  getStats(): BufferStats {
    return {
      eventCount: this.events.length,
      byteSize: this.byteSize,
      oldestEventTs: this.events[0]?.event.ts ?? null,
      newestEventTs: this.events[this.events.length - 1]?.event.ts ?? null,
    };
  }

  /**
   * Check if buffer is empty.
   */
  isEmpty(): boolean {
    return this.events.length === 0;
  }

  /**
   * Get current sequence number.
   */
  getSeq(): number {
    return this.seq;
  }

  /**
   * Get event range in buffer.
   */
  getEventRange(): [number, number] | null {
    if (this.events.length === 0) return null;
    const first = this.events[0];
    const last = this.events[this.events.length - 1];
    if (!first || !last) return null;
    return [first.event.seq, last.event.seq];
  }

  /**
   * Get unique span IDs in buffer.
   */
  getSpanIds(): string[] {
    const spanIds = new Set<string>();
    for (const { event } of this.events) {
      if (event.spanId) {
        spanIds.add(event.spanId);
      }
    }
    return Array.from(spanIds);
  }

  /**
   * Serialize all events to a single byte array (for chunking).
   */
  serialize(): Uint8Array {
    const lines = this.events.map((e) => JSON.stringify(e.event));
    const jsonl = lines.join("\n");
    return new TextEncoder().encode(jsonl);
  }
}
