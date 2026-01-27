/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/client/src/stream-parser.ts
 * @summary NDJSON streaming parser for handling streamed payment responses.
 *
 * This module provides an async generator for parsing newline-delimited JSON
 * (NDJSON) streams. NDJSON is commonly used for streaming responses where each
 * line is a complete JSON object.
 *
 * The parser handles:
 * - Chunked stream data with proper buffering
 * - UTF-8 decoding with stream continuation support
 * - Empty lines and whitespace handling
 * - Final buffer processing after stream ends
 *
 * Used by:
 * - PoiClient.stream() for streaming API responses
 * - Any component needing to parse NDJSON streams
 */

// ---------------------------------------------------------------------------
// NDJSON Stream Parser
// ---------------------------------------------------------------------------

/**
 * Parse an NDJSON stream into individual JSON objects.
 *
 * This async generator reads from a ReadableStream of bytes, decodes UTF-8,
 * and yields each complete JSON line as a parsed object. Lines are buffered
 * until a newline is encountered to handle chunk boundaries.
 *
 * @template T - Type of parsed JSON objects
 * @param stream - ReadableStream of Uint8Array chunks
 * @yields Parsed JSON objects of type T
 * @throws Error if JSON parsing fails for any line
 *
 * @example
 * ```typescript
 * const response = await fetch("/api/stream");
 * if (response.body) {
 *   for await (const event of parseNDJsonStream<MyEvent>(response.body)) {
 *     console.log(event.type, event.data);
 *   }
 * }
 * ```
 */
export async function* parseNDJsonStream<T>(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<T, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // Decode the chunk with stream mode to handle multi-byte characters
      // that may be split across chunks
      buffer += decoder.decode(value, { stream: true });

      // Split on newlines to get complete lines
      const lines = buffer.split("\n");

      // The last element may be incomplete, keep it in the buffer
      const remaining = lines.pop();
      buffer = remaining ?? "";

      // Process complete lines
      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines
        if (trimmed === "") {
          continue;
        }

        // Parse and yield the JSON object
        try {
          yield JSON.parse(trimmed) as T;
        } catch (parseError) {
          throw new Error(
            `Failed to parse NDJSON line: ${parseError instanceof Error ? parseError.message : "unknown error"}. Line: "${trimmed.slice(0, 100)}${trimmed.length > 100 ? "..." : ""}"`
          );
        }
      }
    }

    // Process any remaining data in the buffer after stream ends
    const finalContent = buffer.trim();
    if (finalContent !== "") {
      try {
        yield JSON.parse(finalContent) as T;
      } catch (parseError) {
        throw new Error(
          `Failed to parse final NDJSON line: ${parseError instanceof Error ? parseError.message : "unknown error"}. Line: "${finalContent.slice(0, 100)}${finalContent.length > 100 ? "..." : ""}"`
        );
      }
    }
  } finally {
    // Always release the reader lock
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Stream Utilities
// ---------------------------------------------------------------------------

/**
 * Check if a content type indicates NDJSON streaming.
 *
 * @param contentType - Content-Type header value
 * @returns true if the content type is NDJSON
 */
export function isNDJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes("application/x-ndjson") ||
    normalized.includes("application/ndjson") ||
    normalized.includes("application/x-json-stream")
  );
}

/**
 * Create a simple pass-through transform for logging stream chunks.
 *
 * This is useful for debugging stream parsing issues.
 *
 * @param logger - Function to call with each chunk (default: console.log)
 * @returns TransformStream that passes data through unchanged
 */
export function createDebugTransform(
  logger: (chunk: Uint8Array) => void = (chunk) =>
    console.log("Stream chunk:", new TextDecoder().decode(chunk))
): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      logger(chunk);
      controller.enqueue(chunk);
    },
  });
}

/**
 * Collect all items from an async generator into an array.
 *
 * Useful for testing or when you need all items at once.
 *
 * @template T - Type of items in the generator
 * @param generator - Async generator to collect from
 * @returns Promise resolving to array of all items
 */
export async function collectStream<T>(
  generator: AsyncGenerator<T, void, undefined>
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of generator) {
    items.push(item);
  }
  return items;
}
