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
  const integers = action.kind === "payment" ? [action.timestamp, action.amount] : [action.timestamp];
  if (integers.some((value) => typeof value !== "bigint" || value < 0n || value >= 1n << 64n)) {
    throw new MandateError("SCHEMA_BAD_TYPE", "action integers must be uint64");
  }
  const strings = action.kind === "payment" ? [action.asset, action.counterparty] : [action.destination];
  if (strings.some((value) => typeof value !== "string" || value.length === 0 || !value.isWellFormed())) {
    throw new MandateError("SCHEMA_BAD_TYPE", "action identifiers must be non-empty well-formed strings");
  }
}

export function actionDigest(action: GuardAction): Uint8Array {
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
