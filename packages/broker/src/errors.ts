// Every refusal names an entry of this table and nothing else, so no reply can carry request,
// upstream or vault bytes. `field` is a decoder path built from schema names, never from input.
// Spec §6.3: the JSON-RPC standard codes, v1's -32001…-32010 (-32005 covers a denied and an
// expired approval, -32007 every *_UNAVAILABLE dependency) and v2's -32011 and -32012.
export const RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  PEER_UNKNOWN: { code: -32001, message: "Peer unknown" },
  ALIAS_UNAVAILABLE: { code: -32002, message: "Alias unavailable" },
  POLICY_REFUSED: { code: -32003, message: "Policy refused" },
  DECODE_REFUSED: { code: -32004, message: "Decode refused" },
  APPROVAL_DENIED: { code: -32005, message: "Approval denied" },
  APPROVAL_EXPIRED: { code: -32005, message: "Approval expired" },
  UPSTREAM_FAILED: { code: -32006, message: "Upstream failed" },
  JOURNAL_UNAVAILABLE: { code: -32007, message: "Journal unavailable" },
  LOCKED_OUT: { code: -32008, message: "Locked out" },
  RATE_LIMITED: { code: -32009, message: "Rate limited" },
  INTENT_UNKNOWN: { code: -32010, message: "Intent unknown" },
  MANDATE_REFUSED: { code: -32011, message: "Mandate refused" },
  VERIFY_REFUSED: { code: -32012, message: "Verify refused" },
} as const;

export type RpcErrorName = keyof typeof RPC_ERRORS;

export class RpcError extends Error {
  readonly reason: RpcErrorName;
  readonly code: (typeof RPC_ERRORS)[RpcErrorName]["code"];
  readonly field: string | undefined;

  constructor(reason: RpcErrorName, options: { readonly field?: string; readonly cause?: unknown } = {}) {
    super(RPC_ERRORS[reason].message, { cause: options.cause });
    this.name = "RpcError";
    this.reason = reason;
    this.code = RPC_ERRORS[reason].code;
    this.field = options.field;
  }
}
