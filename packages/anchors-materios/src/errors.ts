import type { CertifiedReceiptResult } from "./types.js";

export type MateriosConnectionErrorCode = "connect-timeout" | "connect-failed" | "connect-aborted" | "read-timeout";

const CONNECTION_FAILURES: Record<MateriosConnectionErrorCode, string> = {
  "connect-timeout": "Materios connection timed out",
  "connect-failed": "Materios connection failed",
  "connect-aborted": "Materios connection aborted by disconnect()",
  "read-timeout": "Materios read timed out",
};

export class MateriosConnectionError extends Error {
  override readonly name = "MateriosConnectionError";

  constructor(
    readonly code: MateriosConnectionErrorCode,
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    const cause = options?.cause;
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
    super(`${CONNECTION_FAILURES[code]} (budget ${timeoutMs} ms)${detail}`, options);
  }
}

export type MateriosFeeShortfallReason = "unregistered-account" | "insufficient-motra";

/**
 * Why the chain refused to charge `account` a fee. `CheckNonce` refuses an account with neither a
 * provider nor a sufficient reference with `InvalidTransaction::Payment`, the code a MOTRA
 * shortfall also gets, so the account's reference counts tell the two apart.
 */
export interface MateriosFeeShortfall {
  reason: MateriosFeeShortfallReason;
  account: string;
  providers: number;
  sufficients: number;
}

const FEE_SHORTFALL_ADVICE: Record<MateriosFeeShortfallReason, string> = {
  "unregistered-account": "is not registered: it has no provider or sufficient reference, so the chain refuses every " +
    "transaction it signs. Register cMATRA for it on Cardano, or ask the Materios operator for capacity.",
  "insufficient-motra": "is registered but holds too little MOTRA to pay the fee. Wait for its MOTRA to generate " +
    "(waitForMotra), or ask the Materios operator for capacity.",
};

export function describeFeeShortfall(shortfall: MateriosFeeShortfall): string {
  return `Materios account ${shortfall.account} ${FEE_SHORTFALL_ADVICE[shortfall.reason]}`;
}

/** `waitForMotra` timed out below `minBalance`; `shortfall` says whether the account can ever pay. */
export class MateriosFeeError extends Error {
  override readonly name = "MateriosFeeError";

  constructor(
    readonly shortfall: MateriosFeeShortfall,
    readonly balance: bigint,
    readonly minBalance: bigint,
    timeout: string,
  ) {
    super(`${timeout} with ${balance} of the ${minBalance} MOTRA base units required. ${describeFeeShortfall(shortfall)}`);
  }
}

export type MateriosSubmissionErrorCode = "not-landed" | "inclusion-unknown" | "dispatch";

/** The on-chain record a submission writes; `resolveInclusion` matches storage against it. */
export interface ExpectedRecord {
  kind: "receipt" | "anchor";
  /** Stored fields by camelCase name: lowercase 0x hex, or null for an absent Option. */
  fields: Readonly<Record<string, string | null>>;
}

/** The signed extrinsic one submission produced. */
export interface SubmittedExtrinsic {
  txHash: string;
  /** SS58 address of the signer. */
  signer: string;
  /** Account nonce the extrinsic was signed with. */
  nonce: number;
  /** Last block number that can include the extrinsic; null when it is immortal. */
  mortalityEnd: number | null;
}

export interface ObservedHead {
  number: number;
  hash: string;
}

export interface MateriosSubmissionErrorOptions {
  cause?: unknown;
  expected?: ExpectedRecord | undefined;
  extrinsic?: SubmittedExtrinsic | undefined;
  lastHead?: ObservedHead | undefined;
  feeShortfall?: MateriosFeeShortfall | undefined;
}

export class MateriosSubmissionError extends Error {
  override readonly name = "MateriosSubmissionError";
  readonly safeToResubmit: boolean;
  readonly expected?: ExpectedRecord;
  readonly txHash?: string;
  readonly signer?: string;
  readonly nonce?: number;
  readonly mortalityEnd?: number | null;
  /** The last head whose storage was read without finding the record. */
  readonly lastHead?: ObservedHead;
  /** Set on a pool refusal for fees: whether the signer is unregistered or short of MOTRA. */
  readonly feeShortfall?: MateriosFeeShortfall;

  constructor(
    readonly code: MateriosSubmissionErrorCode,
    readonly id: string,
    message: string,
    { cause, expected, extrinsic, lastHead, feeShortfall }: MateriosSubmissionErrorOptions = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.safeToResubmit = code === "not-landed";
    if (expected) this.expected = expected;
    if (extrinsic) {
      this.txHash = extrinsic.txHash;
      this.signer = extrinsic.signer;
      this.nonce = extrinsic.nonce;
      this.mortalityEnd = extrinsic.mortalityEnd;
    }
    if (lastHead) this.lastHead = lastHead;
    if (feeShortfall) this.feeShortfall = feeShortfall;
  }
}

/** The receipt is on chain, but waiting for its certification or anchor failed: never resubmit it. */
export class MateriosCertificationError extends Error {
  override readonly name = "MateriosCertificationError";
  readonly stage: "certification" | "anchor";

  constructor(readonly result: CertifiedReceiptResult, options: ErrorOptions) {
    const stage = result.certHash === undefined ? "certification" : "anchor";
    const cause = options.cause instanceof Error ? `: ${options.cause.message}` : "";
    super(`Receipt ${result.receiptId} is on chain at block ${result.blockHash}, but waiting for its ${stage} failed${cause}`, options);
    this.stage = stage;
  }
}
