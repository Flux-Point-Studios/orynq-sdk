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
