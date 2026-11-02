// Every refusal names an entry of this table and nothing else, so no reply can carry request,
// upstream or vault bytes. `field` is a decoder path built from schema names, never from input.
const ERRORS = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid Request" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
} as const;

export type RpcErrorName = keyof typeof ERRORS;

export class RpcError extends Error {
  readonly code: (typeof ERRORS)[RpcErrorName]["code"];
  readonly field: string | undefined;

  constructor(name: RpcErrorName, options: { readonly field?: string; readonly cause?: unknown } = {}) {
    super(ERRORS[name].message, { cause: options.cause });
    this.name = "RpcError";
    this.code = ERRORS[name].code;
    this.field = options.field;
  }
}
