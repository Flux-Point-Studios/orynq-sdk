import { array, bytes, choice, literal, map, optional, text, uint, type Shape } from "./dcbor.js";

// The runtime form of docs/params.cddl, mandate-draft.cddl and release.cddl, keyed by CDDL rule
// name. The CDDL is normative; test/vectors holds both to the same verdict on every vector.

// The params and release effect an effect kind adds to $$intent-effect and $$release-effect.
export interface EffectKind {
  readonly params: Shape;
  readonly effect: Shape;
}

const digest = bytes(32);
const commitment = digest;
const u64 = uint();
const positive = uint({ min: 1n });

const didKey = text(265, { pattern: "did:key:z[1-9A-HJ-NP-Za-km-z]{8,256}" });
const executorDomain = text(74, { pattern: "(X|committee):[0-9a-f]{64}" });
const capabilityKind = text(131, { pattern: "[a-z][a-zA-Z0-9]{0,31}(\\.[a-z][a-zA-Z0-9]{0,31}){1,3}" });
const aliasName = text(69, { pattern: "(test:)?[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?" });
const ca1Id = text(64, { pattern: "ca1:[0-9a-f]{60}" });
const counterpartyId = text(64, { pattern: "(oc1|ca1):[0-9a-f]{60}" });
const traceEventId = text(36, { pattern: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" });
const traceTime = text(24, { pattern: "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z" });
const proofId = text(64, { pattern: "[a-z0-9][a-z0-9._:-]{0,63}" });
const base64Text = text(1048576, { minBytes: 4, pattern: "([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?" });

const brokerAsset = choice(literal("lovelace"), literal("midnight:dust"), literal("orynq:call"));

const member = choice(
  map({ cap: map({ kind: capabilityKind, alias: aliasName, ruleDigest: digest }) }),
  map({ ca1: map({ networkId: uint({ max: 15n }), paymentCred: bytes(28), stakeCred: optional(bytes(28)) }) }),
);
const members = array(member, 1, 256);

const mandateDraft = map({
  principalDid: didKey,
  domain: executorDomain,
  supersedes: optional(commitment),
  spendCap: map({ asset: brokerAsset, amount: positive, windowSeconds: positive }),
  members,
  approvedMeasurementSetRoot: digest,
  validityWindow: map({ notBefore: u64, notAfter: u64 }),
  disclosurePolicy: map({ committeeId: text(128, { minBytes: 1 }), threshold: positive, committeeSize: positive }),
});

const assertion = choice(
  map({
    type: literal("webauthn"),
    credentialId: bytes(1, 1023),
    authenticatorData: bytes(37, 1024),
    clientDataJSON: bytes(1, 4096),
    signature: bytes(8, 72),
    userHandle: optional(bytes(1, 64)),
  }),
  map({ type: literal("ctap2"), credentialId: bytes(1, 1023), authenticatorData: bytes(37, 1024), signature: bytes(8, 72) }),
);

const expectation = map({
  calls: uint({ max: 1n }),
  outflows: array(map({ counterparty: ca1Id, amount: positive }), 0, 256),
  fee: u64,
});

const head = map({ guardLog: map({ count: u64, hash: digest }), trace: map({ roll: digest, seq: u64 }) });

const guardEvent = map({
  type: literal("orynq.conduct.guard.action.v1"),
  seq: u64,
  timestamp: u64,
  enforcedAt: u64,
  mandateCommitment: commitment,
  actionDigest: digest,
  actionKind: literal("payment"),
  action: map({ kind: literal("payment"), asset: brokerAsset, amount: positive, counterparty: counterpartyId, timestamp: u64 }),
});

const step = map({
  event: guardEvent,
  traceMeta: map({ id: traceEventId, seq: u64, timestamp: traceTime }),
  proof: optional(map({ circuitId: proofId, classId: proofId, transactionBase64: base64Text, referenceStateBase64: base64Text })),
});

const mandateRelease = map({ C: commitment, head, steps: array(step, 1, 258) });

const releaseRecord = map({
  intentHash: digest,
  effectDigest: digest,
  heads: array(map({ C: commitment, prev: head, next: head }), 1, 8),
  notAfter: u64,
  mode: choice(literal("replay"), literal("replay+zk-shadow"), literal("zk+replay"), literal("zk")),
  proofRefs: optional(array(digest, 1, 258)),
});

export function schemaRules(effects: Readonly<Record<string, EffectKind>>) {
  const kinds = Object.entries(effects);
  const intentSubmit = choice(...kinds.map(([kind, { params }]) => map({
    kind: literal(kind),
    params,
    mandates: array(commitment, 1, 8),
    expect: optional(expectation),
    wait: optional(uint({ max: 30n })),
    note: optional(text(256)),
  })));
  const releaseRequest = choice(...kinds.flatMap(([kind, { effect }]) => {
    const common = { v: literal(1n), intentHash: digest, kind: literal(kind), effect, alias: aliasName, instanceSig: optional(bytes(64)) };
    return [
      map({ ...common, mandates: array(mandateRelease, 1, 8) }),
      map({ ...common, mandates: array(mandateRelease, 0, 0), approval: map({ nonce: bytes(16), assertion }) }),
    ];
  }));
  return {
    "broker-hello-params": map({}),
    "credential-list-params": map({}),
    "mandate-get-params": map({ mandate: commitment }),
    "intent-submit-params": intentSubmit,
    "session-open-params": map({ mandates: array(commitment, 1, 16) }),
    "session-close-params": map({ sessionId: bytes(16) }),
    "mandate-prepare-params": map({ draft: mandateDraft }),
    "mandate-register-params": map({
      cbor: bytes(1, 2048),
      members,
      domain: executorDomain,
      assertion,
      purpose: text(1024, { minBytes: 1 }),
    }),
    "mandate-revoke-params": map({ mandate: commitment, reason: text(256, { minBytes: 1 }) }),
    "release-history-params": map({ C: commitment, fromCount: u64 }),
    "release-request": releaseRequest,
    "release-record": releaseRecord,
    "mandate-draft": mandateDraft,
  } as const satisfies Readonly<Record<string, Shape>>;
}

// Effect kinds register here as their handlers land; until then every effect is refused.
export const SCHEMA_RULES = schemaRules({});

export const METHOD_PARAMS = {
  "broker.hello": "broker-hello-params",
  "credential.list": "credential-list-params",
  "mandate.get": "mandate-get-params",
  "intent.submit": "intent-submit-params",
  "session.open": "session-open-params",
  "session.close": "session-close-params",
  "mandate.prepare": "mandate-prepare-params",
  "mandate.register": "mandate-register-params",
  "mandate.revoke": "mandate-revoke-params",
  "release.commit": "release-request",
  "release.history": "release-history-params",
} as const satisfies Readonly<Record<string, keyof typeof SCHEMA_RULES>>;
