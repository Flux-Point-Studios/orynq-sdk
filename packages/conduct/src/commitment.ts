import { createHash } from "node:crypto";
import { bytesToHex, concatBytes } from "./bytes.js";
import { decodeMandate, encodeMandate } from "./codec.js";
import type { MandateV1 } from "./types.js";

export const MANDATE_COMMITMENT_DOMAIN = "orynq:conduct:mandate:v1|";

export function mandateCommitment(mandate: MandateV1 | Uint8Array): Uint8Array {
  let body: Uint8Array;
  if (mandate instanceof Uint8Array) {
    body = Uint8Array.from(mandate);
    decodeMandate(body);
  } else {
    body = encodeMandate(mandate);
  }
  const domain = new TextEncoder().encode(MANDATE_COMMITMENT_DOMAIN);
  return new Uint8Array(
    createHash("sha256").update(concatBytes(domain, body)).digest(),
  );
}

export function mandateCommitmentHex(mandate: MandateV1 | Uint8Array): string {
  return bytesToHex(mandateCommitment(mandate));
}
