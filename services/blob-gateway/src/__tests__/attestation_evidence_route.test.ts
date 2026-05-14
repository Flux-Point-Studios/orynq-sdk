/**
 * End-to-end tests for `POST /v2/attestation_evidence` (Wave 3 Phase 2).
 *
 * Real express server. Real on-disk storage layout (so the manifest-lookup
 * + receipt-id-index code paths are exercised). Real in-memory SQLite for
 * the attestor + evidence registries. Real sr25519 keypairs (no mocked
 * verifies).
 *
 * Coverage matrix — every spec rule, positive + negative + edge:
 *
 *   1. Happy-path: register attestor, mint a v2 receipt, POST evidence with
 *      valid nonce + sig → 200 + correct evidence_count = 1,
 *      attestation_evidence_hash matches manual recompute.
 *   2. Replay: same evidence body twice → second returns 200 status:replay,
 *      no double-store.
 *   3. Two attestors submit DIFFERENT evidence_types for the same receipt
 *      → both stored, count = 2, vec sorted by evidence_type discriminant.
 *   4. Bad nonce → 422 NONCE_MISMATCH.
 *   5. Unknown attestor → 403.
 *   6. Wrong signature → 401.
 *   7. Missing receipt_id → 404.
 *   8. attestation_evidence_hash for empty vec is the canonical-CBOR-hash
 *      of `[]` (NOT zeros — sha256(0x80)).
 *
 * Plus: bearer auth required (no token → 401 from middleware).
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

import { config } from "../config.js";
import { attestationEvidenceRouter } from "../routes/attestation_evidence.js";
import {
  initAttestationEvidenceAttestorsDb,
  setAttestationEvidenceAttestorsDbForTests,
  registerAttestationEvidenceAttestor,
  revokeAttestationEvidenceAttestor,
} from "../attestation_evidence_attestors.js";
import {
  initReceiptAttestationEvidenceDb,
  setReceiptAttestationEvidenceDbForTests,
  recomputeReceiptEvidenceHash,
} from "../receipt_attestation_evidence.js";
import { initApiTokensDb, issueToken, setApiTokensDb } from "../api-tokens.js";
import {
  deriveEvidenceNonce,
  evidenceEntryToCborValue,
  encodeCbor,
  attestationEvidenceHash,
  type EvidenceType,
} from "../schemas/compute_metering_v2.js";
import { saveManifest, computeReceiptId } from "../storage.js";

let keyring: Keyring;

beforeAll(async () => {
  await cryptoWaitReady();
  keyring = new Keyring({ type: "sr25519" });
});

interface Ctx {
  app: express.Express;
  storage: string;
  prevStorage: string;
  attestorsDb: Database.Database;
  evidenceDb: Database.Database;
  apiTokensDb: Database.Database;
  /** A bearer token good enough to satisfy `bearerAuth()`. */
  bearerToken: string;
}

async function setupApp(): Promise<Ctx> {
  const storage = mkdtempSync(join(tmpdir(), "att-evidence-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  const attestorsDb = new Database(":memory:");
  initAttestationEvidenceAttestorsDb(attestorsDb);
  setAttestationEvidenceAttestorsDbForTests(attestorsDb);

  const evidenceDb = new Database(":memory:");
  initReceiptAttestationEvidenceDb(evidenceDb);
  setReceiptAttestationEvidenceDbForTests(evidenceDb);

  // The route uses bearerAuth() which requires the api-tokens db to be
  // initialised so it can resolve a Bearer token. Mint a test token here.
  const apiTokensDb = initApiTokensDb(new Database(":memory:"));
  setApiTokensDb(apiTokensDb);
  const { token: bearerToken } = issueToken(apiTokensDb, {
    accountSs58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    label: "test-token",
  });

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(attestationEvidenceRouter);

  return {
    app,
    storage,
    prevStorage,
    attestorsDb,
    evidenceDb,
    apiTokensDb,
    bearerToken,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  config.storagePath = ctx.prevStorage;
  rmSync(ctx.storage, { recursive: true, force: true });
  ctx.attestorsDb.close();
  ctx.evidenceDb.close();
  ctx.apiTokensDb.close();
}

async function postJson(
  app: express.Express,
  path: string,
  body: unknown,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const text = await res.text();
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          server.close();
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

/**
 * Mint a v2 manifest at a fixed content_hash and return both the
 * content_hash and the canonical receipt_id (no `0x` prefix). The manifest
 * shape mimics what `routes/metering_v2.handleV2Submit` writes (schema +
 * record + chunks=[] + rootHash=content_hash).
 */
async function mintV2Manifest(opts: {
  content_hash: string;
  worker_id?: string;
}): Promise<{ contentHash: string; receiptIdClean: string }> {
  const manifest = {
    schema: "compute_metering_v2",
    record: {
      schema_version: "compute_metering_v2",
      worker_id: opts.worker_id ?? "wkr-test",
      tenant_id: "tenant-test",
    },
    chunks: [],
    rootHash: opts.content_hash,
  };
  await saveManifest(opts.content_hash, manifest);
  const receiptId = computeReceiptId(opts.content_hash);
  const receiptIdClean = receiptId.startsWith("0x")
    ? receiptId.slice(2)
    : receiptId;
  return { contentHash: opts.content_hash, receiptIdClean };
}

/**
 * Mint a PLAIN BLOB manifest at a fixed content_hash — what `POST
 * /blobs/:contentHash/manifest` writes. NO `schema` field. Used to verify
 * the v2-schema gate in `lookupV2Manifest`: a plain blob manifest must
 * NOT be accepted as an attestation_evidence target.
 */
async function mintPlainBlobManifest(opts: {
  content_hash: string;
}): Promise<{ contentHash: string; receiptIdClean: string }> {
  const manifest = {
    chunks: [],
    rootHash: opts.content_hash,
  };
  await saveManifest(opts.content_hash, manifest);
  const receiptId = computeReceiptId(opts.content_hash);
  const receiptIdClean = receiptId.startsWith("0x")
    ? receiptId.slice(2)
    : receiptId;
  return { contentHash: opts.content_hash, receiptIdClean };
}

/**
 * Build a signed evidence-submit body. The attestor signs canonical CBOR
 * of the payload (NOT the wrapping evidence map).
 */
function buildSignedEvidence(opts: {
  receiptIdClean: string;
  contentHash: string;
  evidenceType: EvidenceType;
  payload: Record<string, unknown>;
  attestorUri: string;
}): {
  receipt_id: string;
  evidence_type: string;
  nonce: string;
  payload: Record<string, unknown>;
  attestor_pubkey: string;
  signature: string;
  attestorPubHex: string;
} {
  const pair = keyring.addFromUri(opts.attestorUri);
  const tagged = evidenceEntryToCborValue({
    evidence_type: opts.evidenceType,
    nonce: deriveEvidenceNonce(opts.contentHash, opts.evidenceType),
    payload: opts.payload,
  });
  if (tagged.type !== "map") throw new Error("unexpected tagged shape");
  const payloadEntry = tagged.v.find(([k]) => k === "payload");
  if (!payloadEntry) throw new Error("payload key missing");
  const payloadBytes = encodeCbor(payloadEntry[1]);
  const sig = pair.sign(payloadBytes);
  const pubHex = u8aToHex(pair.publicKey, undefined, false);
  return {
    receipt_id: opts.receiptIdClean,
    evidence_type: opts.evidenceType,
    nonce: deriveEvidenceNonce(opts.contentHash, opts.evidenceType),
    payload: opts.payload,
    attestor_pubkey: pubHex,
    signature: u8aToHex(sig, undefined, false),
    attestorPubHex: pubHex,
  };
}

// Default test content_hash — synthetic 32-byte hex. Reused throughout.
const SYNTH_CONTENT_HASH = "ab".repeat(32);

// ===========================================================================
// Auth
// ===========================================================================

describe("POST /v2/attestation_evidence — bearer auth gating", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("missing_bearer_returns_401", async () => {
    const res = await postJson(ctx.app, "/v2/attestation_evidence", {
      receipt_id: "0".repeat(64),
    });
    expect(res.status).toBe(401);
  });

  test("invalid_bearer_returns_401", async () => {
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      { receipt_id: "0".repeat(64) },
      { headers: { authorization: "Bearer matra_not_a_real_token" } },
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// Body shape — 400 on malformed input
// ===========================================================================

describe("POST /v2/attestation_evidence — body shape", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("missing_receipt_id_returns_400", async () => {
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        evidence_type: "arm_trustzone",
        nonce: "ff".repeat(32),
        payload: {},
        attestor_pubkey: "ff".repeat(32),
        signature: "ff".repeat(64),
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("MISSING_FIELD");
  });

  test("invalid_evidence_type_returns_400", async () => {
    await mintV2Manifest({ content_hash: SYNTH_CONTENT_HASH });
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        receipt_id: SYNTH_CONTENT_HASH,
        evidence_type: "made_up",
        nonce: "ff".repeat(32),
        payload: {},
        attestor_pubkey: "ff".repeat(32),
        signature: "ff".repeat(64),
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("EVIDENCE_TYPE_INVALID");
  });

  test("non_object_payload_returns_400", async () => {
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        receipt_id: SYNTH_CONTENT_HASH,
        evidence_type: "arm_trustzone",
        nonce: "ff".repeat(32),
        payload: "not-an-object",
        attestor_pubkey: "ff".repeat(32),
        signature: "ff".repeat(64),
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("WRONG_TYPE");
  });

  test("bad_hex_returns_400", async () => {
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        receipt_id: "not-hex",
        evidence_type: "arm_trustzone",
        nonce: "ff".repeat(32),
        payload: {},
        attestor_pubkey: "ff".repeat(32),
        signature: "ff".repeat(64),
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("HEX_FORMAT");
  });
});

// ===========================================================================
// Spec rule 7 — missing receipt_id → 404
// ===========================================================================

describe("POST /v2/attestation_evidence — receipt_not_found", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("unknown_receipt_returns_404", async () => {
    const body = buildSignedEvidence({
      receiptIdClean: "00".repeat(32),
      contentHash: "00".repeat(32),
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//Attestor0",
    });
    registerAttestationEvidenceAttestor({ pubkey: body.attestorPubHex });
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      body,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("RECEIPT_NOT_FOUND");
  });

  // PR #34 M-1: lookupV2Manifest must check the manifest's schema field.
  // A plain blob manifest (no `schema` field) must NOT be accepted as a
  // target for /v2/attestation_evidence — the docstring + inline comment
  // claim only v2/v2.1 manifests pass.
  test("submit_evidence_for_non_v2_manifest_returns_404", async () => {
    // Note: deliberately uses a DIFFERENT content_hash than SYNTH_CONTENT_HASH
    // so that prior tests' state can't leak. Plain blob manifest = no `schema`.
    const PLAIN_HASH = "cd".repeat(32);
    const { contentHash, receiptIdClean } = await mintPlainBlobManifest({
      content_hash: PLAIN_HASH,
    });
    const body = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//AttestorPlainBlob",
    });
    registerAttestationEvidenceAttestor({ pubkey: body.attestorPubHex });
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      body,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe("RECEIPT_NOT_FOUND");
  });
});

// ===========================================================================
// Spec rule — bad nonce → 422 NONCE_MISMATCH
// ===========================================================================

describe("POST /v2/attestation_evidence — nonce_mismatch", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("wrong_nonce_returns_422", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: SYNTH_CONTENT_HASH,
    });
    const correct = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//Attestor0",
    });
    registerAttestationEvidenceAttestor({ pubkey: correct.attestorPubHex });
    // Tamper with the nonce.
    const body = { ...correct, nonce: "00".repeat(32) };
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      body,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(422);
    expect((res.body as { code: string }).code).toBe("NONCE_MISMATCH");
  });
});

// ===========================================================================
// Spec rule — unknown attestor → 403 ATTESTOR_UNKNOWN
// ===========================================================================

describe("POST /v2/attestation_evidence — attestor_unknown", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("unregistered_attestor_returns_403", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: SYNTH_CONTENT_HASH,
    });
    const body = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//AttestorUnknown",
    });
    // DO NOT register.
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      body,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe("ATTESTOR_UNKNOWN");
  });

  test("revoked_attestor_returns_403", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: SYNTH_CONTENT_HASH,
    });
    const body = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//AttestorRevoked",
    });
    registerAttestationEvidenceAttestor({ pubkey: body.attestorPubHex });
    revokeAttestationEvidenceAttestor(body.attestorPubHex);
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      body,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe("ATTESTOR_UNKNOWN");
  });
});

// ===========================================================================
// Spec rule — wrong signature → 401 SIGNATURE_INVALID
// ===========================================================================

describe("POST /v2/attestation_evidence — signature_invalid", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("tampered_signature_returns_401", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: SYNTH_CONTENT_HASH,
    });
    const correct = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//Attestor1",
    });
    registerAttestationEvidenceAttestor({ pubkey: correct.attestorPubHex });
    const body = { ...correct, signature: "00".repeat(64) };
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      body,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe("SIGNATURE_INVALID");
  });
});

// ===========================================================================
// Happy path — accept, store, recompute hash, return shape
// ===========================================================================

describe("POST /v2/attestation_evidence — happy path", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("accepts_first_evidence_and_returns_recomputed_hash", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: SYNTH_CONTENT_HASH,
    });
    const body = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: {
        device_model: "Pixel-8",
        security_level: "TrustedEnvironment",
        key_attestation_chain_b64: "AAECAw==",
      },
      attestorUri: "//Attestor2",
    });
    registerAttestationEvidenceAttestor({
      pubkey: body.attestorPubHex,
      label: "happy-path-attestor",
    });

    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      body,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const j = res.body as {
      ok: boolean;
      status: string;
      receipt_id: string;
      attestation_evidence_hash: string;
      evidence_count: number;
      evidence_types: string[];
    };
    expect(j.ok).toBe(true);
    expect(j.status).toBe("accepted");
    expect(j.receipt_id).toBe(receiptIdClean);
    expect(j.evidence_count).toBe(1);
    expect(j.evidence_types).toEqual(["arm_trustzone"]);
    expect(j.attestation_evidence_hash).toMatch(/^[0-9a-f]{64}$/);

    // The hash matches a manual recompute from the evidence DB.
    const summary = recomputeReceiptEvidenceHash(receiptIdClean);
    expect(summary.hash).toBe(j.attestation_evidence_hash);
    expect(summary.count).toBe(1);
  });
});

// ===========================================================================
// Spec rule — replay → 200 status:replay (no double-store)
// ===========================================================================

describe("POST /v2/attestation_evidence — replay", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("same_evidence_body_twice_returns_replay_no_double_store", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: SYNTH_CONTENT_HASH,
    });
    const body = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//Attestor3",
    });
    registerAttestationEvidenceAttestor({ pubkey: body.attestorPubHex });

    const r1 = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      body,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(r1.status).toBe(200);
    expect((r1.body as { status: string }).status).toBe("accepted");
    expect((r1.body as { evidence_count: number }).evidence_count).toBe(1);

    const r2 = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      body,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(r2.status).toBe(200);
    expect((r2.body as { status: string }).status).toBe("replay");
    expect((r2.body as { evidence_count: number }).evidence_count).toBe(1);
  });
});

// ===========================================================================
// Spec rule — two attestors, different evidence_types → both stored,
// vec sorted by evidence_type discriminant.
// ===========================================================================

describe("POST /v2/attestation_evidence — multi-attestor multi-type", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("two_attestors_different_types_both_stored_sorted_by_discriminant", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: SYNTH_CONTENT_HASH,
    });
    // First attestor: reproducible_build (discriminant 3)
    const buildBody = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "reproducible_build",
      payload: { nar_hash_b64: "AAECAw==" },
      attestorUri: "//AttestorBuild",
    });
    registerAttestationEvidenceAttestor({ pubkey: buildBody.attestorPubHex });
    // Second attestor: arm_trustzone (discriminant 2)
    const armBody = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//AttestorArm",
    });
    registerAttestationEvidenceAttestor({ pubkey: armBody.attestorPubHex });

    // Submit the build evidence FIRST, then arm. Even though arm has lower
    // discriminant, the storage layer's recompute MUST sort by discriminant.
    const r1 = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      buildBody,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(r1.status).toBe(200);
    expect((r1.body as { evidence_count: number }).evidence_count).toBe(1);

    const r2 = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      armBody,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(r2.status).toBe(200);
    const j2 = r2.body as {
      evidence_count: number;
      evidence_types: string[];
      attestation_evidence_hash: string;
    };
    expect(j2.evidence_count).toBe(2);
    // Sorted by discriminant: arm_trustzone (2) before reproducible_build (3)
    expect(j2.evidence_types).toEqual(["arm_trustzone", "reproducible_build"]);

    // Manual recompute matches what the route returned.
    const manual = attestationEvidenceHash([
      {
        evidence_type: "arm_trustzone",
        nonce: deriveEvidenceNonce(contentHash, "arm_trustzone"),
        payload: { device_model: "Pixel-8" },
      },
      {
        evidence_type: "reproducible_build",
        nonce: deriveEvidenceNonce(contentHash, "reproducible_build"),
        payload: { nar_hash_b64: "AAECAw==" },
      },
    ]);
    expect(j2.attestation_evidence_hash).toBe(manual);
  });
});

// ===========================================================================
// PR #34 M-2 — pinned secondary sort key on same-discriminant entries.
// Two attestors submit the SAME evidence_type for the same receipt;
// attestation_evidence_hash MUST be deterministic regardless of insertion
// order, pinned on (discriminant, attestor_pubkey_hex) lex-ascending.
// ===========================================================================

describe("POST /v2/attestation_evidence — multi-attestor SAME-type tiebreak", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("multi_attestor_same_evidence_type_hash_is_deterministic_by_pubkey_order", async () => {
    // ----- Pass 1: register A (//AttA), submit; register B (//AttB), submit. -----
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: SYNTH_CONTENT_HASH,
    });
    const aBody = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//AttA",
    });
    const bBody = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Galaxy-S24" },
      attestorUri: "//AttB",
    });
    registerAttestationEvidenceAttestor({ pubkey: aBody.attestorPubHex });
    registerAttestationEvidenceAttestor({ pubkey: bBody.attestorPubHex });

    // Submit A first, then B.
    const r1a = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      aBody,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(r1a.status).toBe(200);
    const r1b = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      bBody,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(r1b.status).toBe(200);
    const hashAB = (r1b.body as { attestation_evidence_hash: string })
      .attestation_evidence_hash;
    expect((r1b.body as { evidence_count: number }).evidence_count).toBe(2);

    // ----- Pass 2: Drop the evidence DB; register B first, then A; submit B then A. -----
    // Replicates the cross-instance scenario the security review flagged: same
    // logical evidence set, different on-disk insertion order, must hash same.
    ctx.evidenceDb.close();
    const evidenceDb2 = new Database(":memory:");
    initReceiptAttestationEvidenceDb(evidenceDb2);
    setReceiptAttestationEvidenceDbForTests(evidenceDb2);
    ctx.evidenceDb = evidenceDb2;

    const r2b = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      bBody,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(r2b.status).toBe(200);
    const r2a = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      aBody,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(r2a.status).toBe(200);
    const hashBA = (r2a.body as { attestation_evidence_hash: string })
      .attestation_evidence_hash;
    expect((r2a.body as { evidence_count: number }).evidence_count).toBe(2);

    // The KEY assertion: hashes must match across reversed insertion orders.
    expect(hashBA).toBe(hashAB);
  });

  // PINNED VECTOR — locks the convention "(discriminant, attestor_pubkey_hex)
  // lex-ascending" forever. If anyone ever flips the comparator, this test
  // catches it on first PR.
  test("multi_attestor_same_type_pinned_vector", async () => {
    // Two evidence entries, identical evidence_type=arm_trustzone, different
    // pubkeys/payloads. We KNOW the pubkeys for //AttA and //AttB are stable
    // sr25519 derivations of those URIs.
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: SYNTH_CONTENT_HASH,
    });
    const aBody = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Pixel-8" },
      attestorUri: "//AttA",
    });
    const bBody = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device_model: "Galaxy-S24" },
      attestorUri: "//AttB",
    });
    registerAttestationEvidenceAttestor({ pubkey: aBody.attestorPubHex });
    registerAttestationEvidenceAttestor({ pubkey: bBody.attestorPubHex });

    // Submit them in REVERSE pubkey-lex order to prove the route's recompute
    // applies the pinned tiebreak (and not insertion order).
    const lowerPubFirst = aBody.attestorPubHex < bBody.attestorPubHex
      ? aBody
      : bBody;
    const higherPubFirst = aBody.attestorPubHex < bBody.attestorPubHex
      ? bBody
      : aBody;

    const insertHigherFirst = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      higherPubFirst,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(insertHigherFirst.status).toBe(200);

    const insertLowerSecond = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      lowerPubFirst,
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(insertLowerSecond.status).toBe(200);

    const apiHash = (insertLowerSecond.body as {
      attestation_evidence_hash: string;
    }).attestation_evidence_hash;

    // Recompute by hand, in the canonical pinned order: lower pubkey first.
    const lowerPub = aBody.attestorPubHex < bBody.attestorPubHex
      ? aBody
      : bBody;
    const higherPub = aBody.attestorPubHex < bBody.attestorPubHex
      ? bBody
      : aBody;

    const expected = attestationEvidenceHash([
      {
        evidence_type: "arm_trustzone",
        nonce: deriveEvidenceNonce(contentHash, "arm_trustzone"),
        payload: lowerPub.payload,
      },
      {
        evidence_type: "arm_trustzone",
        nonce: deriveEvidenceNonce(contentHash, "arm_trustzone"),
        payload: higherPub.payload,
      },
    ]);
    expect(apiHash).toBe(expected);
  });
});

// ===========================================================================
// Empty-vec hash spec pin (route returns the canonical empty-vec hash for
// receipts that have no evidence yet).
// ===========================================================================

describe("attestation_evidence_hash — empty vec spec pin", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("empty_evidence_hash_is_sha256_of_cbor_byte_0x80_not_zeros", () => {
    const summary = recomputeReceiptEvidenceHash("ee".repeat(32));
    const expected = createHash("sha256").update(Buffer.from([0x80])).digest("hex");
    expect(summary.hash).toBe(expected);
    expect(summary.hash).toBe(
      "76be8b528d0075f7aae98d6fa57a6d3c83ae480a8469e668d7b0af968995ac71",
    );
    expect(summary.hash).not.toBe("00".repeat(32));
    expect(summary.count).toBe(0);
    expect(summary.types).toEqual([]);
  });
});

// ===========================================================================
// ed25519 attestor support (task #242)
//
// Acurast Android phones expose only ed25519 as a TEE-protected signing
// primitive (`_STD_.signers.ed25519.sign`). The gateway must accept
// ed25519-attested evidence from registered attestors whose `sig_algo` is
// `ed25519`. Existing sr25519 attestors stay green via the ALTER TABLE
// default.
//
// These tests cover the polyalg dispatch in the route's verifier and the
// new `sig_algo` field on the admin POST.
// ===========================================================================

describe("POST /v2/attestation_evidence — ed25519 attestor (task #242)", () => {
  let ctx: Ctx;
  let ed25519Keyring: Keyring;
  beforeAll(async () => {
    await cryptoWaitReady();
    ed25519Keyring = new Keyring({ type: "ed25519" });
  });
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  /**
   * ed25519 variant of `buildSignedEvidence`. Same byte-pinned pre-image
   * (canonical CBOR of the payload), but signs with an ed25519 keypair so
   * the route's dispatch needs to verify with ed25519Verify, not sr25519Verify.
   */
  function buildSignedEvidenceEd25519(opts: {
    receiptIdClean: string;
    contentHash: string;
    evidenceType: EvidenceType;
    payload: Record<string, unknown>;
    attestorUri: string;
  }): {
    receipt_id: string;
    evidence_type: string;
    nonce: string;
    payload: Record<string, unknown>;
    attestor_pubkey: string;
    signature: string;
    attestorPubHex: string;
  } {
    // ed25519 doesn't support soft-derivation paths (`//Foo` is soft); use
    // a raw 32-byte seed derived from the attestorUri so each test gets a
    // distinct, deterministic ed25519 keypair without needing a mnemonic.
    const seed = createHash("sha256")
      .update(Buffer.from(opts.attestorUri, "utf8"))
      .digest();
    const pair = ed25519Keyring.addFromSeed(seed);
    const tagged = evidenceEntryToCborValue({
      evidence_type: opts.evidenceType,
      nonce: deriveEvidenceNonce(opts.contentHash, opts.evidenceType),
      payload: opts.payload,
    });
    if (tagged.type !== "map") throw new Error("unexpected tagged shape");
    const payloadEntry = tagged.v.find(([k]) => k === "payload");
    if (!payloadEntry) throw new Error("payload key missing");
    const payloadBytes = encodeCbor(payloadEntry[1]);
    const sig = pair.sign(payloadBytes);
    const pubHex = u8aToHex(pair.publicKey, undefined, false);
    return {
      receipt_id: opts.receiptIdClean,
      evidence_type: opts.evidenceType,
      nonce: deriveEvidenceNonce(opts.contentHash, opts.evidenceType),
      payload: opts.payload,
      attestor_pubkey: pubHex,
      signature: u8aToHex(sig, undefined, false),
      attestorPubHex: pubHex,
    };
  }

  test("happy_path_ed25519_accepted_when_attestor_registered_as_ed25519", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: "ed".repeat(32),
    });
    const signed = buildSignedEvidenceEd25519({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device: "acurast-mock", chain_chain_id: "preprod-001" },
      attestorUri: "//Acurast/Phone1",
    });
    registerAttestationEvidenceAttestor({
      pubkey: signed.attestorPubHex,
      label: "acurast-phone-test",
      sig_algo: "ed25519",
    });

    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        receipt_id: signed.receipt_id,
        evidence_type: signed.evidence_type,
        nonce: signed.nonce,
        payload: signed.payload,
        attestor_pubkey: signed.attestor_pubkey,
        signature: signed.signature,
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = res.body as { status: string };
    expect(body.status).toBe("accepted");
  });

  test("ed25519_sig_rejected_when_attestor_registered_as_sr25519", async () => {
    // The pubkey is ed25519 but the registry says this attestor uses
    // sr25519 — the dispatch should pick sr25519Verify, which will fail on
    // the ed25519 signature. Single 401 SIGNATURE_INVALID, no algo leak.
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: "ec".repeat(32),
    });
    const signed = buildSignedEvidenceEd25519({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device: "mismatched-algo" },
      attestorUri: "//Acurast/Phone2",
    });
    registerAttestationEvidenceAttestor({
      pubkey: signed.attestorPubHex,
      label: "registered-as-wrong-algo",
      // omit sig_algo → default sr25519
    });

    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        receipt_id: signed.receipt_id,
        evidence_type: signed.evidence_type,
        nonce: signed.nonce,
        payload: signed.payload,
        attestor_pubkey: signed.attestor_pubkey,
        signature: signed.signature,
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(401);
    const body = res.body as { code: string };
    expect(body.code).toBe("SIGNATURE_INVALID");
  });

  test("sr25519_sig_rejected_when_attestor_registered_as_ed25519", async () => {
    // Mirror image of the above — sr25519 sig, registry says ed25519.
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: "eb".repeat(32),
    });
    const signed = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device: "wrong-direction" },
      attestorUri: "//SrToEd",
    });
    registerAttestationEvidenceAttestor({
      pubkey: signed.attestorPubHex,
      label: "ed25519-registered",
      sig_algo: "ed25519",
    });

    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        receipt_id: signed.receipt_id,
        evidence_type: signed.evidence_type,
        nonce: signed.nonce,
        payload: signed.payload,
        attestor_pubkey: signed.attestor_pubkey,
        signature: signed.signature,
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(401);
    const body = res.body as { code: string };
    expect(body.code).toBe("SIGNATURE_INVALID");
  });

  test("sr25519_attestor_unchanged_by_polyalg_extension", async () => {
    // Regression guard: a pre-migration sr25519 attestor (sig_algo set by
    // the ALTER TABLE default) still verifies correctly. Locks in
    // backward-compat for the existing fleet-operator deployments.
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: "ea".repeat(32),
    });
    const signed = buildSignedEvidence({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device: "legacy-fleet-operator" },
      attestorUri: "//LegacySr",
    });
    registerAttestationEvidenceAttestor({
      pubkey: signed.attestorPubHex,
      label: "legacy-sr25519",
      // No sig_algo passed → registers as sr25519 (the default the
      // ALTER TABLE migration writes for pre-existing rows).
    });

    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        receipt_id: signed.receipt_id,
        evidence_type: signed.evidence_type,
        nonce: signed.nonce,
        payload: signed.payload,
        attestor_pubkey: signed.attestor_pubkey,
        signature: signed.signature,
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// secp256r1 attestor support (task #139 / Witness Network)
//
// Android KeyMint produces ECDSA over P-256 (a.k.a. secp256r1, prime256v1).
// The Materios Witness Network MVP has phones direct-sign gateway POSTs with
// the same KeyMint-attested key whose chain ships in the payload — the gateway
// must accept that signature path natively.
//
// Wire format pinned:
//   pubkey   = 33 bytes compressed P-256 point (66 hex chars)
//   signature = 64 bytes raw r||s (128 hex chars; phone strips DER ASN.1)
//   preimage = canonical-CBOR(payload), SHA-256 inside verify
// ===========================================================================

describe("POST /v2/attestation_evidence — secp256r1 (KeyMint) attestor", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await setupApp(); });
  afterEach(async () => { await teardown(ctx); });

  /**
   * P-256 variant of buildSignedEvidence. Signs canonical-CBOR(payload) with
   * a fresh ECDSA-P256 key and returns the 33-byte compressed pubkey + 64-byte
   * raw r||s signature in the same wire shape sr25519/ed25519 use.
   */
  async function buildSignedEvidenceP256(opts: {
    receiptIdClean: string;
    contentHash: string;
    evidenceType: EvidenceType;
    payload: Record<string, unknown>;
  }): Promise<{
    receipt_id: string;
    evidence_type: string;
    nonce: string;
    payload: Record<string, unknown>;
    attestor_pubkey: string;
    signature: string;
    attestorPubHex: string;
  }> {
    const { p256 } = await import("@noble/curves/p256");
    const priv = p256.utils.randomPrivateKey();
    const pub33 = p256.getPublicKey(priv, true); // compressed
    const tagged = evidenceEntryToCborValue({
      evidence_type: opts.evidenceType,
      nonce: deriveEvidenceNonce(opts.contentHash, opts.evidenceType),
      payload: opts.payload,
    });
    if (tagged.type !== "map") throw new Error("encoder shape");
    const payloadEntry = tagged.v.find(([k]) => k === "payload");
    if (!payloadEntry) throw new Error("payload key missing");
    const payloadBytes = encodeCbor(payloadEntry[1]);
    const sigObj = p256.sign(payloadBytes, priv, { prehash: true });
    const sigRaw = sigObj.toCompactRawBytes(); // 64-byte r||s
    const pubHex = Buffer.from(pub33).toString("hex");
    return {
      receipt_id: opts.receiptIdClean,
      evidence_type: opts.evidenceType,
      nonce: deriveEvidenceNonce(opts.contentHash, opts.evidenceType),
      payload: opts.payload,
      attestor_pubkey: pubHex,
      signature: Buffer.from(sigRaw).toString("hex"),
      attestorPubHex: pubHex,
    };
  }

  test("happy_path_secp256r1_accepted_when_attestor_registered_as_secp256r1", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: "ee".repeat(32),
    });
    const signed = await buildSignedEvidenceP256({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device: "keymint-p256-test", chain_chain_id: "preprod-001" },
    });
    registerAttestationEvidenceAttestor({
      pubkey: signed.attestorPubHex,
      label: "keymint-p256-witness-test",
      sig_algo: "secp256r1",
    });

    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        receipt_id: signed.receipt_id,
        evidence_type: signed.evidence_type,
        nonce: signed.nonce,
        payload: signed.payload,
        attestor_pubkey: signed.attestor_pubkey,
        signature: signed.signature,
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(200);
    const body = res.body as { status: string };
    expect(body.status).toBe("accepted");
  });

  test("storage_layer_rejects_33_byte_pubkey_under_non_secp256r1_algo", async () => {
    // Defense-in-depth: the storage layer rejects 33-byte (P-256) pubkeys
    // when sig_algo != secp256r1. The route never even sees the wrong combo
    // because registration throws first. This locks that contract in.
    const { p256 } = await import("@noble/curves/p256");
    const priv = p256.utils.randomPrivateKey();
    const pub33 = Buffer.from(p256.getPublicKey(priv, true)).toString("hex");
    expect(() =>
      registerAttestationEvidenceAttestor({
        pubkey: pub33,
        label: "wrong-algo-p256",
        sig_algo: "ed25519",
      }),
    ).toThrow(/32 bytes hex/);
  });

  test("secp256r1_rejects_tampered_payload", async () => {
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: "ec".repeat(32),
    });
    const signed = await buildSignedEvidenceP256({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device: "original-payload" },
    });
    registerAttestationEvidenceAttestor({
      pubkey: signed.attestorPubHex,
      label: "tamper-test",
      sig_algo: "secp256r1",
    });

    // Tamper: swap the payload but keep the original signature
    const tamperedPayload = { device: "TAMPERED-payload" };
    const res = await postJson(
      ctx.app,
      "/v2/attestation_evidence",
      {
        receipt_id: signed.receipt_id,
        evidence_type: signed.evidence_type,
        nonce: signed.nonce,
        payload: tamperedPayload,
        attestor_pubkey: signed.attestor_pubkey,
        signature: signed.signature,
      },
      { headers: { authorization: `Bearer ${ctx.bearerToken}` } },
    );
    expect(res.status).toBe(401);
    const body = res.body as { code: string };
    expect(body.code).toBe("SIGNATURE_INVALID");
  });

  test("wire_format_pinned_33_byte_pubkey_64_byte_sig", async () => {
    // Lock the wire-format constants: prevent a future change from silently
    // breaking phone-side clients.
    const { contentHash, receiptIdClean } = await mintV2Manifest({
      content_hash: "eb".repeat(32),
    });
    const signed = await buildSignedEvidenceP256({
      receiptIdClean,
      contentHash,
      evidenceType: "arm_trustzone",
      payload: { device: "wire-format-check" },
    });
    // 33 bytes = 66 hex chars
    expect(signed.attestor_pubkey.length).toBe(66);
    // 64 bytes = 128 hex chars (r||s, NOT DER)
    expect(signed.signature.length).toBe(128);
  });
});
