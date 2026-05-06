/**
 * Unit tests for `compute_metering_v1` schema validator.
 *
 * Exhaustive cell-by-cell coverage of every constraint in the schema spec:
 *   - field present / missing
 *   - type confusion (string-where-int, array-where-object, NaN, Infinity)
 *   - shape (regex on ids / hex)
 *   - bounds (negative, zero, hardware-cap, JS-safe-int, period > 24 h)
 *   - clock skew (period_end > now+60s)
 *   - monotonic per-worker (period_start < last)
 *   - signature verify (valid / corrupt sig / corrupt body / replay)
 *   - canonical CBOR determinism (key-order independence)
 *
 * No mocks for crypto. We use real sr25519 keypairs from @polkadot/keyring.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { createHash } from "crypto";

import {
  validateComputeMeteringV1,
  canonicalBody,
  canonicalContentHash,
  workerPubkeyToSs58,
  SCHEMA_VERSION,
  SCHEMA_HASH_HEX,
  DEFAULT_BOUNDS,
  MAX_PERIOD_MS,
  FUTURE_SKEW_MS,
  JS_SAFE_INT,
  type ComputeMeteringV1,
  type WorkerBounds,
} from "../compute_metering_v1.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let keyring: Keyring;

beforeAll(async () => {
  await cryptoWaitReady();
  keyring = new Keyring({ type: "sr25519" });
});

interface BuildOpts {
  worker_id?: string;
  tenant_id?: string;
  period_start?: number;
  period_end?: number;
  cpu_seconds?: number;
  ram_gb_hours?: number;
  disk_gb_hours?: number;
  net_bytes_in?: number;
  net_bytes_out?: number;
  gpu_seconds?: number;
  /** sr25519 URI seed for the keypair. Default `//ComputeWorker0`. */
  uri?: string;
  /** When set, overrides `worker_pubkey` in the output (for tampering tests). */
  override_pubkey?: string;
  /** When set, overrides `worker_signature` (for tampering tests). */
  override_signature?: string;
}

/**
 * Build a fully-signed valid record. Override any field via `opts`.
 * Returns the JSON object suitable for `validateComputeMeteringV1(rec)`.
 */
function buildSigned(opts: BuildOpts = {}): ComputeMeteringV1 {
  const pair = keyring.addFromUri(opts.uri ?? "//ComputeWorker0");
  // Fixed deterministic period for reproducibility (2025-01-01..+1h):
  const period_start = opts.period_start ?? 1_735_689_600_000;
  const period_end = opts.period_end ?? period_start + 3_600_000;
  const body = {
    schema_version: SCHEMA_VERSION,
    worker_id: opts.worker_id ?? "worker-001",
    tenant_id: opts.tenant_id ?? "tenant-acme",
    period_start,
    period_end,
    cpu_seconds: opts.cpu_seconds ?? 60.5,
    ram_gb_hours: opts.ram_gb_hours ?? 0.5,
    disk_gb_hours: opts.disk_gb_hours ?? 1.25,
    net_bytes_in: opts.net_bytes_in ?? 1_048_576,
    net_bytes_out: opts.net_bytes_out ?? 524_288,
    gpu_seconds: opts.gpu_seconds ?? 0,
    worker_pubkey:
      opts.override_pubkey ?? u8aToHex(pair.publicKey, undefined, false),
  } as const;
  const cb = canonicalBody(body);
  const sig =
    opts.override_signature ?? u8aToHex(pair.sign(cb), undefined, false);
  return { ...body, worker_signature: sig };
}

// ---------------------------------------------------------------------------
// 1. Canonical encoder unit tests
// ---------------------------------------------------------------------------

describe("canonical CBOR encoder — determinism", () => {
  test("key-order independence: input order doesn't change output bytes", () => {
    const body1 = canonicalBody({
      schema_version: SCHEMA_VERSION,
      worker_id: "abcd",
      tenant_id: "efgh",
      period_start: 1_735_689_600_000,
      period_end: 1_735_689_600_000 + 1000,
      cpu_seconds: 1.5,
      ram_gb_hours: 0.0,
      disk_gb_hours: 0.0,
      net_bytes_in: 0,
      net_bytes_out: 0,
      gpu_seconds: 0.0,
      worker_pubkey: "ab".repeat(32),
    });
    // Same logical record, different field-mention order via spread:
    const body2 = canonicalBody({
      worker_pubkey: "ab".repeat(32),
      gpu_seconds: 0.0,
      net_bytes_out: 0,
      net_bytes_in: 0,
      disk_gb_hours: 0.0,
      ram_gb_hours: 0.0,
      cpu_seconds: 1.5,
      period_end: 1_735_689_600_000 + 1000,
      period_start: 1_735_689_600_000,
      tenant_id: "efgh",
      worker_id: "abcd",
      schema_version: SCHEMA_VERSION,
    });
    expect(u8aToHex(body1)).toBe(u8aToHex(body2));
  });

  test("content_hash is sha256 of canonical body", () => {
    const body = canonicalBody({
      schema_version: SCHEMA_VERSION,
      worker_id: "abcd",
      tenant_id: "efgh",
      period_start: 1_735_689_600_000,
      period_end: 1_735_689_600_000 + 1000,
      cpu_seconds: 1.5,
      ram_gb_hours: 0.0,
      disk_gb_hours: 0.0,
      net_bytes_in: 0,
      net_bytes_out: 0,
      gpu_seconds: 0.0,
      worker_pubkey: "ab".repeat(32),
    });
    const hash = createHash("sha256").update(body).digest("hex");
    const helperHash = canonicalContentHash({
      schema_version: SCHEMA_VERSION,
      worker_id: "abcd",
      tenant_id: "efgh",
      period_start: 1_735_689_600_000,
      period_end: 1_735_689_600_000 + 1000,
      cpu_seconds: 1.5,
      ram_gb_hours: 0.0,
      disk_gb_hours: 0.0,
      net_bytes_in: 0,
      net_bytes_out: 0,
      gpu_seconds: 0.0,
      worker_pubkey: "ab".repeat(32),
    });
    expect(helperHash).toBe(hash);
  });

  test("SCHEMA_HASH_HEX is sha256 of the version string", () => {
    const expected = createHash("sha256")
      .update("compute_metering_v1", "utf-8")
      .digest("hex");
    expect(SCHEMA_HASH_HEX).toBe(expected);
  });

  test("workerPubkeyToSs58 round-trips through Keyring address", () => {
    const pair = keyring.addFromUri("//ComputeWorker0");
    const hex = u8aToHex(pair.publicKey, undefined, false);
    const ss58 = workerPubkeyToSs58(hex);
    expect(ss58).toBe(pair.address);
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — happy path", () => {
  test("valid record → ok with content_hash and schema_hash", () => {
    const rec = buildSigned();
    const res = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(res.schema_hash).toBe(SCHEMA_HASH_HEX);
      expect(res.canonical_body).toBeInstanceOf(Uint8Array);
      expect(res.canonical_body.length).toBeGreaterThan(0);
      // Content-hash is reproducible from the canonical body in the result.
      expect(
        createHash("sha256").update(res.canonical_body).digest("hex"),
      ).toBe(res.content_hash);
    }
  });

  test("zero-valued resource fields are allowed", () => {
    const rec = buildSigned({
      cpu_seconds: 0,
      ram_gb_hours: 0,
      disk_gb_hours: 0,
      net_bytes_in: 0,
      net_bytes_out: 0,
      gpu_seconds: 0,
    });
    const res = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1000,
    });
    expect(res.ok).toBe(true);
  });

  test("max-allowed bounds (exact cap) is allowed", () => {
    const period_start = 1_735_689_600_000;
    const period_end = period_start + 3_600_000;
    const periodSec = (period_end - period_start) / 1000;
    const periodHr = (period_end - period_start) / 3_600_000;
    const rec = buildSigned({
      period_start,
      period_end,
      cpu_seconds: periodSec * DEFAULT_BOUNDS.max_cpu_cores,
      ram_gb_hours: periodHr * DEFAULT_BOUNDS.max_ram_gb,
      disk_gb_hours: periodHr * DEFAULT_BOUNDS.max_disk_gb,
      gpu_seconds: periodSec * DEFAULT_BOUNDS.max_gpu_count,
      net_bytes_in: JS_SAFE_INT,
      net_bytes_out: JS_SAFE_INT,
    });
    const res = validateComputeMeteringV1(rec, {
      now_ms: period_end + 1000,
    });
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Missing / wrong type
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — missing fields", () => {
  test("null root → WRONG_TYPE", () => {
    const r = validateComputeMeteringV1(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_TYPE");
  });

  test("array root → WRONG_TYPE", () => {
    const r = validateComputeMeteringV1([1, 2, 3]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_TYPE");
  });

  test("string root → WRONG_TYPE", () => {
    const r = validateComputeMeteringV1("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_TYPE");
  });

  // Each required field, omitted in turn, must produce MISSING_FIELD with the
  // correct field name. Drives one assertion per field — exhaustive coverage.
  const fields: Array<keyof ComputeMeteringV1> = [
    "schema_version",
    "worker_id",
    "tenant_id",
    "period_start",
    "period_end",
    "cpu_seconds",
    "ram_gb_hours",
    "disk_gb_hours",
    "net_bytes_in",
    "net_bytes_out",
    "gpu_seconds",
    "worker_pubkey",
    "worker_signature",
  ];

  for (const f of fields) {
    test(`missing ${f} → MISSING_FIELD with field=${f}`, () => {
      const rec = buildSigned() as Record<string, unknown>;
      delete rec[f];
      const res = validateComputeMeteringV1(rec, {
        now_ms: 1_735_693_200_000 + 1000,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("MISSING_FIELD");
        expect(res.field).toBe(f);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Wrong type per field
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — wrong type per field", () => {
  test("schema_version not string → WRONG_TYPE", () => {
    const rec = { ...buildSigned(), schema_version: 42 };
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("WRONG_TYPE");
      expect(r.field).toBe("schema_version");
    }
  });

  test("worker_id not string → WRONG_TYPE", () => {
    const rec = { ...buildSigned(), worker_id: 1 };
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("WRONG_TYPE");
      expect(r.field).toBe("worker_id");
    }
  });

  test("period_start not integer (float) → WRONG_TYPE", () => {
    const rec = { ...buildSigned(), period_start: 1.5 };
    const r = validateComputeMeteringV1(rec, { now_ms: 1_735_693_200_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("WRONG_TYPE");
      expect(r.field).toBe("period_start");
    }
  });

  test("net_bytes_in non-integer → WRONG_TYPE", () => {
    const rec = { ...buildSigned(), net_bytes_in: 1.7 };
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("WRONG_TYPE");
      expect(r.field).toBe("net_bytes_in");
    }
  });

  test("cpu_seconds NaN → WRONG_TYPE", () => {
    const rec = { ...buildSigned(), cpu_seconds: NaN };
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("WRONG_TYPE");
      expect(r.field).toBe("cpu_seconds");
    }
  });

  test("cpu_seconds Infinity → WRONG_TYPE", () => {
    const rec = { ...buildSigned(), cpu_seconds: Infinity };
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_TYPE");
  });
});

// ---------------------------------------------------------------------------
// 5. Schema version
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — schema_version", () => {
  test("rejects mismatched version", () => {
    const rec = { ...buildSigned(), schema_version: "compute_metering_v2" };
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("WRONG_SCHEMA_VERSION");
      expect(r.field).toBe("schema_version");
    }
  });

  test("rejects close-but-different version (case sensitive)", () => {
    const rec = { ...buildSigned(), schema_version: "Compute_Metering_V1" };
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_SCHEMA_VERSION");
  });
});

// ---------------------------------------------------------------------------
// 6. ID format
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — id format", () => {
  test("worker_id too short (< 4) rejected", () => {
    const r = validateComputeMeteringV1(buildSigned({ worker_id: "abc" }), {
      now_ms: 1_735_700_000_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("ID_FORMAT");
      expect(r.field).toBe("worker_id");
    }
  });

  test("worker_id too long (> 64) rejected", () => {
    const r = validateComputeMeteringV1(buildSigned({ worker_id: "a".repeat(65) }), {
      now_ms: 1_735_700_000_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ID_FORMAT");
  });

  test("worker_id with uppercase rejected", () => {
    const r = validateComputeMeteringV1(buildSigned({ worker_id: "WORKER" }), {
      now_ms: 1_735_700_000_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ID_FORMAT");
  });

  test("worker_id with disallowed chars rejected", () => {
    const r = validateComputeMeteringV1(buildSigned({ worker_id: "worker_001" }), {
      now_ms: 1_735_700_000_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ID_FORMAT");
  });

  test("tenant_id with leading dash and digits accepted", () => {
    const rec = buildSigned({ tenant_id: "tenant-007" });
    const r = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1,
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Period validation
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — period", () => {
  test("period_start <= 0 rejected", () => {
    const rec = buildSigned({
      period_start: 0,
      period_end: 1000,
    });
    const r = validateComputeMeteringV1(rec, { now_ms: 1_735_700_000_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("PERIOD_INVALID");
      expect(r.field).toBe("period_start");
    }
  });

  test("period_start negative rejected", () => {
    const rec = buildSigned({
      period_start: -1,
      period_end: 1000,
    });
    const r = validateComputeMeteringV1(rec, { now_ms: 1_735_700_000_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PERIOD_INVALID");
  });

  test("period_end == period_start rejected", () => {
    const rec = buildSigned({
      period_start: 1_735_689_600_000,
      period_end: 1_735_689_600_000,
    });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("PERIOD_INVALID");
      expect(r.field).toBe("period_end");
    }
  });

  test("period_end < period_start rejected", () => {
    const rec = buildSigned({
      period_start: 1_735_689_600_000,
      period_end: 1_735_689_500_000,
    });
    const r = validateComputeMeteringV1(rec, { now_ms: 1_735_700_000_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PERIOD_INVALID");
  });

  test("period > 24 h rejected", () => {
    const start = 1_735_689_600_000;
    const rec = buildSigned({
      period_start: start,
      period_end: start + MAX_PERIOD_MS + 1,
      // Keep resource fields zero so we don't trip a bound first.
      cpu_seconds: 0,
      ram_gb_hours: 0,
      disk_gb_hours: 0,
      gpu_seconds: 0,
    });
    const r = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PERIOD_INVALID");
  });

  test("period == exactly 24 h accepted", () => {
    const start = 1_735_689_600_000;
    const rec = buildSigned({
      period_start: start,
      period_end: start + MAX_PERIOD_MS,
      cpu_seconds: 0,
      ram_gb_hours: 0,
      disk_gb_hours: 0,
      gpu_seconds: 0,
    });
    const r = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1,
    });
    expect(r.ok).toBe(true);
  });

  test("period_end > now + 60s rejected (clock skew)", () => {
    const now = 1_735_700_000_000;
    const rec = buildSigned({
      period_start: now - 3_600_000,
      period_end: now + FUTURE_SKEW_MS + 1,
    });
    const r = validateComputeMeteringV1(rec, { now_ms: now });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("PERIOD_INVALID");
      expect(r.field).toBe("period_end");
    }
  });

  test("period_end == now + 60s accepted (skew exact)", () => {
    const now = 1_735_700_000_000;
    const rec = buildSigned({
      period_start: now - 3_600_000,
      period_end: now + FUTURE_SKEW_MS,
    });
    const r = validateComputeMeteringV1(rec, { now_ms: now });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Bounds
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — resource bounds", () => {
  test("negative cpu_seconds rejected", () => {
    const rec = buildSigned({ cpu_seconds: -0.001 });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("NEGATIVE_VALUE");
      expect(r.field).toBe("cpu_seconds");
    }
  });

  test("negative net_bytes_in rejected", () => {
    const rec = buildSigned({ net_bytes_in: -1 });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NEGATIVE_VALUE");
  });

  test("cpu_seconds exceeds hardware-implausible cap (default bounds)", () => {
    // 1-hour period × 128 cores = 460800 max cpu_seconds. Push above.
    const rec = buildSigned({ cpu_seconds: 460_801 });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("BOUND_EXCEEDED");
      expect(r.field).toBe("cpu_seconds");
    }
  });

  test("ram_gb_hours exceeds bound", () => {
    // 1-hour period × 2048 GB = 2048 max ram_gb_hours.
    const rec = buildSigned({ ram_gb_hours: 2049 });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BOUND_EXCEEDED");
  });

  test("disk_gb_hours exceeds bound", () => {
    const rec = buildSigned({ disk_gb_hours: 16_385 });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BOUND_EXCEEDED");
  });

  test("gpu_seconds exceeds bound", () => {
    // 1-hour × 8 = 28800
    const rec = buildSigned({ gpu_seconds: 28_801 });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BOUND_EXCEEDED");
  });

  test("net_bytes_in == JS_SAFE_INT accepted; +1 over rejected", () => {
    const rec = buildSigned({ net_bytes_in: JS_SAFE_INT });
    const okRes = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(okRes.ok).toBe(true);

    // For values > 2^53, JS rounds to even — Number.isInteger may still be
    // true (e.g. 2^53 + 2 round-trips). The schema explicitly rejects
    // anything > JS_SAFE_INT regardless. Build the over-cap record by hand
    // (skip buildSigned, which sign-encodes via canonicalBody and would itself
    // refuse the oversized value — that defence-in-depth is desired and
    // separately tested below).
    const oversized = Number.MAX_SAFE_INTEGER + 2; // === 2^53 + 2
    expect(Number.isInteger(oversized)).toBe(true);
    const ok = buildSigned();
    const recBig: ComputeMeteringV1 = {
      ...ok,
      net_bytes_in: oversized,
      // Signature is now invalid for the tampered body — but the validator
      // checks bounds BEFORE signature, so it will fail on INT_OVERFLOW first.
    };
    const overRes = validateComputeMeteringV1(recBig, {
      now_ms: recBig.period_end + 1,
    });
    expect(overRes.ok).toBe(false);
    if (!overRes.ok) expect(overRes.code).toBe("INT_OVERFLOW");
  });

  test("canonicalBody itself refuses to encode > JS_SAFE_INT (defence-in-depth)", () => {
    expect(() =>
      canonicalBody({
        schema_version: SCHEMA_VERSION,
        worker_id: "wkr-001",
        tenant_id: "ten-001",
        period_start: 1,
        period_end: 2,
        cpu_seconds: 0,
        ram_gb_hours: 0,
        disk_gb_hours: 0,
        net_bytes_in: Number.MAX_SAFE_INTEGER + 2,
        net_bytes_out: 0,
        gpu_seconds: 0,
        worker_pubkey: "ab".repeat(32),
      }),
    ).toThrow(/exceeds JS-safe int/);
  });

  test("custom bounds: smaller cap applied", () => {
    const small: WorkerBounds = {
      max_cpu_cores: 1,
      max_ram_gb: 1,
      max_disk_gb: 1,
      max_gpu_count: 1,
    };
    // 1h × 1 core = 3600 cpu_seconds. Default would allow ~460k.
    const rec = buildSigned({ cpu_seconds: 3601 });
    const r = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1,
      bounds: small,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("BOUND_EXCEEDED");
      expect(r.field).toBe("cpu_seconds");
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Hex format
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — hex format", () => {
  test("worker_pubkey wrong length (62) rejected", () => {
    const rec = buildSigned({ override_pubkey: "ab".repeat(31) });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("HEX_FORMAT");
      expect(r.field).toBe("worker_pubkey");
    }
  });

  test("worker_pubkey uppercase hex rejected (canonicalisation)", () => {
    const rec = buildSigned({ override_pubkey: "AB".repeat(32) });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HEX_FORMAT");
  });

  test("worker_pubkey 0x-prefixed rejected (we want raw 64-hex)", () => {
    const rec = buildSigned({ override_pubkey: "0x" + "ab".repeat(32) });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HEX_FORMAT");
  });

  test("worker_signature wrong length rejected", () => {
    const rec = buildSigned({ override_signature: "cd".repeat(63) });
    const r = validateComputeMeteringV1(rec, { now_ms: rec.period_end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("HEX_FORMAT");
      expect(r.field).toBe("worker_signature");
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Signature verify
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — signature verification", () => {
  test("corrupt signature (one bit flipped) → SIGNATURE_INVALID", () => {
    const rec = buildSigned();
    // Flip one nibble in the signature.
    const flipped =
      rec.worker_signature.slice(0, 2) === "00"
        ? "01" + rec.worker_signature.slice(2)
        : "00" + rec.worker_signature.slice(2);
    const tampered = { ...rec, worker_signature: flipped };
    const r = validateComputeMeteringV1(tampered, {
      now_ms: tampered.period_end + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("SIGNATURE_INVALID");
      expect(r.field).toBe("worker_signature");
    }
  });

  test("body tampered after sign (cpu_seconds) → SIGNATURE_INVALID", () => {
    const rec = buildSigned();
    const tampered = { ...rec, cpu_seconds: rec.cpu_seconds + 1 };
    const r = validateComputeMeteringV1(tampered, {
      now_ms: tampered.period_end + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SIGNATURE_INVALID");
  });

  test("pubkey swapped to a different worker → SIGNATURE_INVALID", () => {
    const rec = buildSigned({ uri: "//ComputeWorker0" });
    const otherPair = keyring.addFromUri("//ComputeWorker1");
    const tampered = {
      ...rec,
      worker_pubkey: u8aToHex(otherPair.publicKey, undefined, false),
    };
    const r = validateComputeMeteringV1(tampered, {
      now_ms: tampered.period_end + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SIGNATURE_INVALID");
  });

  test("replay: same record verifies twice (no statefulness in validator)", () => {
    // Validator itself is stateless re: replay — replay protection is the
    // caller's job (chain-level dedup via content_hash + monotonic
    // period_start). This test pins that behaviour so a future refactor
    // doesn't accidentally introduce statefulness here.
    const rec = buildSigned();
    const r1 = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1,
    });
    const r2 = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1,
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.content_hash).toBe(r2.content_hash);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Monotonic period_start
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV1 — monotonic period_start", () => {
  test("period_start < last_period_start rejected", () => {
    const rec = buildSigned({
      period_start: 1_735_689_600_000,
      period_end: 1_735_689_600_000 + 1000,
    });
    const r = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1,
      last_period_start: rec.period_start + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MONOTONIC_VIOLATION");
      expect(r.field).toBe("period_start");
    }
  });

  test("period_start == last_period_start accepted (non-decreasing)", () => {
    const rec = buildSigned({
      period_start: 1_735_689_600_000,
      period_end: 1_735_689_600_000 + 1000,
    });
    const r = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1,
      last_period_start: rec.period_start,
    });
    expect(r.ok).toBe(true);
  });

  test("first record (last_period_start = 0) accepted", () => {
    const rec = buildSigned();
    const r = validateComputeMeteringV1(rec, {
      now_ms: rec.period_end + 1,
      last_period_start: 0,
    });
    expect(r.ok).toBe(true);
  });
});
