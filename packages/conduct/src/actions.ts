import { bytesToHex, concatBytes } from "./bytes.js";
import { cborEncode, type CborValue } from "./cbor.js";
import { MandateError } from "./errors.js";
import { createHash } from "node:crypto";

export interface PaymentAction {
  readonly kind: "payment";
  readonly asset: string;
  readonly amount: bigint;
  readonly counterparty: string;
  readonly timestamp: bigint;
}

export interface EgressAction {
  readonly kind: "egress";
  readonly destination: string;
  readonly timestamp: bigint;
}

export type GuardAction = PaymentAction | EgressAction;

export const ACTION_DIGEST_DOMAIN = "orynq:conduct:guard:action:v1|";

export function validateAction(action: GuardAction): void {
  if (action.kind !== "payment" && action.kind !== "egress") {
    throw new MandateError("SCHEMA_BAD_TYPE", "unknown action kind");
  }
  const keys = action.kind === "payment"
    ? ["kind", "asset", "amount", "counterparty", "timestamp"]
    : ["kind", "destination", "timestamp"];
  if (Reflect.ownKeys(action).some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new MandateError("SCHEMA_UNKNOWN_KEY", "unknown action key");
  }
  const integers = action.kind === "payment" ? [action.timestamp, action.amount] : [action.timestamp];
  if (integers.some((value) => typeof value !== "bigint" || value < 0n || value >= 1n << 64n)) {
    throw new MandateError("SCHEMA_BAD_TYPE", "action integers must be uint64");
  }
  if (action.kind === "payment" && action.amount === 0n) {
    throw new MandateError("SCHEMA_BAD_AMOUNT", "payment amount must be >= 1");
  }
  const strings = action.kind === "payment" ? [action.asset, action.counterparty] : [action.destination];
  if (strings.some((value) => typeof value !== "string" || value.length === 0 || value.length > 256 || !value.isWellFormed() || Buffer.byteLength(value, "utf8") > 256)
    || (action.kind === "payment" && Buffer.byteLength(action.asset, "utf8") > 128)) {
    throw new MandateError("SCHEMA_BAD_TYPE", "action identifiers must be well-formed UTF-8: asset 1-128 bytes, counterparty/destination 1-256 bytes");
  }
}

export function actionDigest(action: GuardAction): Uint8Array {
  action = { ...action };
  validateAction(action);
  const map = new Map<CborValue, CborValue>(
    action.kind === "payment"
      ? [
          [0n, "payment"],
          [1n, action.asset],
          [2n, action.amount],
          [3n, action.counterparty],
          [4n, action.timestamp],
        ]
      : [
          [0n, "egress"],
          [1n, action.destination],
          [2n, action.timestamp],
        ],
  );
  const domain = new TextEncoder().encode(ACTION_DIGEST_DOMAIN);
  return new Uint8Array(
    createHash("sha256").update(concatBytes(domain, cborEncode(map))).digest(),
  );
}

export function actionDigestHex(action: GuardAction): string {
  return bytesToHex(actionDigest(action));
}
