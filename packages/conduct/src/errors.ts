export type CborErrorCode =
  | "CBOR_NONMINIMAL"
  | "CBOR_INDEFINITE"
  | "CBOR_MALFORMED"
  | "CBOR_FORBIDDEN"
  | "CBOR_TRUNCATED"
  | "CBOR_KEY_ORDER"
  | "CBOR_DUPLICATE_KEY"
  | "CBOR_TRAILING"
  | "CBOR_DEPTH"
  | "CBOR_UTF8"
  | "CBOR_RANGE"
  | "CBOR_TYPE";

export type SchemaErrorCode =
  | "SCHEMA_BAD_VERSION"
  | "SCHEMA_BAD_MANDATE_ID"
  | "SCHEMA_BAD_DID"
  | "SCHEMA_BAD_DID_FORMAT"
  | "SCHEMA_BAD_ASSET"
  | "SCHEMA_BAD_AMOUNT"
  | "SCHEMA_BAD_WINDOW"
  | "SCHEMA_BAD_ROOT"
  | "SCHEMA_BAD_EGRESS"
  | "SCHEMA_BAD_VALIDITY"
  | "SCHEMA_BAD_DISCLOSURE"
  | "SCHEMA_MISSING_KEY"
  | "SCHEMA_UNKNOWN_KEY"
  | "SCHEMA_BAD_TYPE";

export type MandateErrorCode = CborErrorCode | SchemaErrorCode;

export class MandateError extends Error {
  readonly code: MandateErrorCode;

  constructor(code: MandateErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MandateError";
    this.code = code;
  }
}
