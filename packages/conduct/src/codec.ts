import { equalBytes } from "./bytes.js";
import {
  cborDecode,
  cborEncode,
  type CborMap,
  type CborValue,
} from "./cbor.js";
import { MandateError } from "./errors.js";
import {
  DID_FORMAT_DID_KEY,
  EGRESS_ALLOWLIST,
  EGRESS_DENY_ALL,
  MANDATE_SCHEMA_VERSION,
  ZERO_ROOT_32,
  type MandateV1,
} from "./types.js";
const K_SCHEMA_VERSION = 0n;
const K_MANDATE_ID = 1n;
const K_PRINCIPAL_DID = 2n;
const K_AGENT_DID = 3n;
const K_DID_FORMAT_VERSION = 4n;
const K_SPEND_CAP = 5n;
const K_COUNTERPARTY_ROOT = 6n;
const K_EGRESS_POLICY = 7n;
const K_MEASUREMENT_ROOT = 8n;
const K_VALIDITY_WINDOW = 9n;
const K_DISCLOSURE_POLICY = 10n;

const TOP_KEYS = [
  K_SCHEMA_VERSION,
  K_MANDATE_ID,
  K_PRINCIPAL_DID,
  K_AGENT_DID,
  K_DID_FORMAT_VERSION,
  K_SPEND_CAP,
  K_COUNTERPARTY_ROOT,
  K_EGRESS_POLICY,
  K_MEASUREMENT_ROOT,
  K_VALIDITY_WINDOW,
  K_DISCLOSURE_POLICY,
];

const DID_KEY_PATTERN = /^did:key:z[1-9A-HJ-NP-Za-km-z]{8,256}$/;
const ASSET_PATTERN = /^[\x21-\x7e]{1,128}$/;
const U64_MAX = (1n << 64n) - 1n;

function checkUint(value: bigint, code: MandateError["code"], what: string): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new MandateError(code, `${what} must be a uint64`);
  }
}

function checkRoot(root: Uint8Array, what: string): void {
  if (!(root instanceof Uint8Array) || root.length !== 32) {
    throw new MandateError("SCHEMA_BAD_ROOT", `${what} must be exactly 32 bytes`);
  }
}

function copyBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new MandateError("SCHEMA_BAD_TYPE", "mandate byte fields must be Uint8Array");
  return Uint8Array.from(value);
}

export function validateMandate(m: MandateV1): void {
  if (m.schemaVersion !== MANDATE_SCHEMA_VERSION) {
    throw new MandateError(
      "SCHEMA_BAD_VERSION",
      `schemaVersion must be ${MANDATE_SCHEMA_VERSION}, got ${m.schemaVersion}`,
    );
  }
  if (!(m.mandateId instanceof Uint8Array) || m.mandateId.length !== 16) {
    throw new MandateError("SCHEMA_BAD_MANDATE_ID", "mandateId must be 16 bytes");
  }
  for (const [did, who] of [
    [m.principalDid, "principalDid"],
    [m.agentDid, "agentDid"],
  ] as const) {
    if (typeof did !== "string" || !DID_KEY_PATTERN.test(did)) {
      throw new MandateError("SCHEMA_BAD_DID", `${who} must match did:key:z<base58btc>`);
    }
  }
  if (m.didFormatVersion !== DID_FORMAT_DID_KEY) {
    throw new MandateError(
      "SCHEMA_BAD_DID_FORMAT",
      `didFormatVersion must be ${DID_FORMAT_DID_KEY} (did:key)`,
    );
  }
  if (typeof m.spendCap.asset !== "string" || !ASSET_PATTERN.test(m.spendCap.asset)) {
    throw new MandateError(
      "SCHEMA_BAD_ASSET",
      "spendCap.asset must be 1-128 printable ASCII characters without spaces",
    );
  }
  checkUint(m.spendCap.amount, "SCHEMA_BAD_AMOUNT", "spendCap.amount");
  checkUint(m.spendCap.windowSeconds, "SCHEMA_BAD_WINDOW", "spendCap.windowSeconds");
  if (m.spendCap.windowSeconds < 1n) {
    throw new MandateError("SCHEMA_BAD_WINDOW", "spendCap.windowSeconds must be >= 1");
  }
  checkRoot(m.counterpartyAllowlistRoot, "counterpartyAllowlistRoot");
  checkRoot(m.approvedMeasurementSetRoot, "approvedMeasurementSetRoot");
  checkRoot(m.egressPolicy.allowlistRoot, "egressPolicy.allowlistRoot");
  if (
    m.egressPolicy.mode !== EGRESS_DENY_ALL &&
    m.egressPolicy.mode !== EGRESS_ALLOWLIST
  ) {
    throw new MandateError("SCHEMA_BAD_EGRESS", "egressPolicy.mode must be 0 or 1");
  }
  if (
    m.egressPolicy.mode === EGRESS_DENY_ALL &&
    !equalBytes(m.egressPolicy.allowlistRoot, ZERO_ROOT_32)
  ) {
    throw new MandateError(
      "SCHEMA_BAD_EGRESS",
      "deny-all egress requires an all-zero allowlistRoot",
    );
  }
  checkUint(m.validityWindow.notBefore, "SCHEMA_BAD_VALIDITY", "validityWindow.notBefore");
  checkUint(m.validityWindow.notAfter, "SCHEMA_BAD_VALIDITY", "validityWindow.notAfter");
  if (m.validityWindow.notAfter <= m.validityWindow.notBefore) {
    throw new MandateError(
      "SCHEMA_BAD_VALIDITY",
      "validityWindow.notAfter must be > notBefore",
    );
  }
  const d = m.disclosurePolicy;
  if (
    typeof d.committeeId !== "string" ||
    d.committeeId.length < 1 ||
    Buffer.byteLength(d.committeeId, "utf8") > 128 ||
    !d.committeeId.isWellFormed()
  ) {
    throw new MandateError(
      "SCHEMA_BAD_DISCLOSURE",
      "disclosurePolicy.committeeId must be 1-128 well-formed UTF-8 bytes",
    );
  }
  checkUint(d.threshold, "SCHEMA_BAD_DISCLOSURE", "disclosurePolicy.threshold");
  checkUint(d.committeeSize, "SCHEMA_BAD_DISCLOSURE", "disclosurePolicy.committeeSize");
  if (d.threshold < 1n || d.committeeSize < d.threshold) {
    throw new MandateError(
      "SCHEMA_BAD_DISCLOSURE",
      "disclosurePolicy requires 1 <= threshold <= committeeSize",
    );
  }
}

export function mandateToCborMap(m: MandateV1): CborMap {
  const { spendCap: inputSpendCap, egressPolicy, validityWindow, disclosurePolicy, ...fields } = m;
  const { allowlistRoot, ...egressFields } = egressPolicy;
  m = {
    ...fields,
    mandateId: copyBytes(fields.mandateId),
    counterpartyAllowlistRoot: copyBytes(fields.counterpartyAllowlistRoot),
    approvedMeasurementSetRoot: copyBytes(fields.approvedMeasurementSetRoot),
    spendCap: { ...inputSpendCap },
    egressPolicy: { ...egressFields, allowlistRoot: copyBytes(allowlistRoot) },
    validityWindow: { ...validityWindow },
    disclosurePolicy: { ...disclosurePolicy },
  };
  validateMandate(m);
  const spendCap: CborMap = new Map<CborValue, CborValue>([
    [0n, m.spendCap.asset],
    [1n, m.spendCap.amount],
    [2n, m.spendCap.windowSeconds],
  ]);
  const egress: CborMap = new Map<CborValue, CborValue>([
    [0n, m.egressPolicy.mode],
    [1n, m.egressPolicy.allowlistRoot],
  ]);
  const validity: CborMap = new Map<CborValue, CborValue>([
    [0n, m.validityWindow.notBefore],
    [1n, m.validityWindow.notAfter],
  ]);
  const disclosure: CborMap = new Map<CborValue, CborValue>([
    [0n, m.disclosurePolicy.committeeId],
    [1n, m.disclosurePolicy.threshold],
    [2n, m.disclosurePolicy.committeeSize],
  ]);
  return new Map<CborValue, CborValue>([
    [K_SCHEMA_VERSION, m.schemaVersion],
    [K_MANDATE_ID, m.mandateId],
    [K_PRINCIPAL_DID, m.principalDid],
    [K_AGENT_DID, m.agentDid],
    [K_DID_FORMAT_VERSION, m.didFormatVersion],
    [K_SPEND_CAP, spendCap],
    [K_COUNTERPARTY_ROOT, m.counterpartyAllowlistRoot],
    [K_EGRESS_POLICY, egress],
    [K_MEASUREMENT_ROOT, m.approvedMeasurementSetRoot],
    [K_VALIDITY_WINDOW, validity],
    [K_DISCLOSURE_POLICY, disclosure],
  ]);
}

export function encodeMandate(m: MandateV1): Uint8Array {
  return cborEncode(mandateToCborMap(m));
}

function expectMap(v: CborValue, what: string): CborMap {
  if (!(v instanceof Map)) {
    throw new MandateError("SCHEMA_BAD_TYPE", `${what} must be a CBOR map`);
  }
  return v;
}

function expectUint(v: CborValue | undefined, what: string): bigint {
  if (typeof v !== "bigint") {
    throw new MandateError("SCHEMA_BAD_TYPE", `${what} must be a uint`);
  }
  return v;
}

function expectText(v: CborValue | undefined, what: string): string {
  if (typeof v !== "string") {
    throw new MandateError("SCHEMA_BAD_TYPE", `${what} must be a text string`);
  }
  return v;
}

function expectBytes(v: CborValue | undefined, what: string): Uint8Array {
  if (!(v instanceof Uint8Array)) {
    throw new MandateError("SCHEMA_BAD_TYPE", `${what} must be a byte string`);
  }
  return v;
}

function checkKeySet(map: CborMap, expected: bigint[], what: string): void {
  for (const key of expected) {
    if (!map.has(key)) {
      throw new MandateError("SCHEMA_MISSING_KEY", `${what} missing key ${key}`);
    }
  }
  if (map.size !== expected.length) {
    for (const key of map.keys()) {
      if (typeof key !== "bigint" || !expected.includes(key)) {
        throw new MandateError("SCHEMA_UNKNOWN_KEY", `${what} has unknown key ${String(key)}`);
      }
    }
  }
}

export function cborMapToMandate(top: CborValue): MandateV1 {
  const map = expectMap(top, "mandate");
  checkKeySet(map, TOP_KEYS, "mandate");

  const spendCapMap = expectMap(map.get(K_SPEND_CAP) as CborValue, "spendCap");
  checkKeySet(spendCapMap, [0n, 1n, 2n], "spendCap");
  const egressMap = expectMap(map.get(K_EGRESS_POLICY) as CborValue, "egressPolicy");
  checkKeySet(egressMap, [0n, 1n], "egressPolicy");
  const validityMap = expectMap(map.get(K_VALIDITY_WINDOW) as CborValue, "validityWindow");
  checkKeySet(validityMap, [0n, 1n], "validityWindow");
  const disclosureMap = expectMap(
    map.get(K_DISCLOSURE_POLICY) as CborValue,
    "disclosurePolicy",
  );
  checkKeySet(disclosureMap, [0n, 1n, 2n], "disclosurePolicy");

  const mandate: MandateV1 = {
    schemaVersion: expectUint(map.get(K_SCHEMA_VERSION), "schemaVersion"),
    mandateId: expectBytes(map.get(K_MANDATE_ID), "mandateId"),
    principalDid: expectText(map.get(K_PRINCIPAL_DID), "principalDid"),
    agentDid: expectText(map.get(K_AGENT_DID), "agentDid"),
    didFormatVersion: expectUint(map.get(K_DID_FORMAT_VERSION), "didFormatVersion"),
    spendCap: {
      asset: expectText(spendCapMap.get(0n), "spendCap.asset"),
      amount: expectUint(spendCapMap.get(1n), "spendCap.amount"),
      windowSeconds: expectUint(spendCapMap.get(2n), "spendCap.windowSeconds"),
    },
    counterpartyAllowlistRoot: expectBytes(
      map.get(K_COUNTERPARTY_ROOT),
      "counterpartyAllowlistRoot",
    ),
    egressPolicy: {
      mode: expectUint(egressMap.get(0n), "egressPolicy.mode"),
      allowlistRoot: expectBytes(egressMap.get(1n), "egressPolicy.allowlistRoot"),
    },
    approvedMeasurementSetRoot: expectBytes(
      map.get(K_MEASUREMENT_ROOT),
      "approvedMeasurementSetRoot",
    ),
    validityWindow: {
      notBefore: expectUint(validityMap.get(0n), "validityWindow.notBefore"),
      notAfter: expectUint(validityMap.get(1n), "validityWindow.notAfter"),
    },
    disclosurePolicy: {
      committeeId: expectText(disclosureMap.get(0n), "disclosurePolicy.committeeId"),
      threshold: expectUint(disclosureMap.get(1n), "disclosurePolicy.threshold"),
      committeeSize: expectUint(disclosureMap.get(2n), "disclosurePolicy.committeeSize"),
    },
  };
  validateMandate(mandate);
  return mandate;
}

export function decodeMandate(bytes: Uint8Array): MandateV1 {
  return cborMapToMandate(cborDecode(Uint8Array.from(bytes)));
}
