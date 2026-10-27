export interface SpendCap {
  readonly asset: string;
  readonly amount: bigint;
  readonly windowSeconds: bigint;
}

export const EGRESS_DENY_ALL = 0n;
export const EGRESS_ALLOWLIST = 1n;

export interface EgressPolicy {
  readonly mode: bigint;
  readonly allowlistRoot: Uint8Array;
}

export interface ValidityWindow {
  readonly notBefore: bigint;
  readonly notAfter: bigint;
}

export interface DisclosurePolicy {
  readonly committeeId: string;
  readonly threshold: bigint;
  readonly committeeSize: bigint;
}

export interface MandateV1 {
  readonly schemaVersion: bigint;
  readonly mandateId: Uint8Array;
  readonly principalDid: string;
  readonly agentDid: string;
  readonly didFormatVersion: bigint;
  readonly spendCap: SpendCap;
  readonly counterpartyAllowlistRoot: Uint8Array;
  readonly egressPolicy: EgressPolicy;
  readonly approvedMeasurementSetRoot: Uint8Array;
  readonly validityWindow: ValidityWindow;
  readonly disclosurePolicy: DisclosurePolicy;
}

export const MANDATE_SCHEMA_VERSION = 1n;
export const DID_FORMAT_DID_KEY = 0n;
export const ZERO_ROOT_32: Uint8Array = new Uint8Array(32);
