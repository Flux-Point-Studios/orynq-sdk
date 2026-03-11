// packages/orynq-mcp/src/errors.ts
// Standardized MCP tool response helpers.
// Wraps success/error payloads into the content format expected by
// the MCP SDK, and provides safeTool() for concise error handling
// in tool implementations. Used by all tool handlers.

export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function toolSuccess(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export async function safeTool<T>(
  fn: () => Promise<T> | T,
): Promise<ReturnType<typeof toolSuccess> | ReturnType<typeof toolError>> {
  try {
    const result = await fn();
    return toolSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(message);
  }
}
