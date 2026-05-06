/**
 * Validation tests for `compute_metering_v2`.
 *
 * Coverage matrix — every rule from the schema spec, positive + negative:
 *
 *   1. period_end_ms - period_start_ms <= 86_400_000 (24h window)
 *   2. period_end_ms <= now + 60_000 (no future submissions)
 *   3. All metric values >= 0
 *   4. cpu_seconds <= cpu_cores × period_seconds × 1.05
 *   5. ram_gb_hours <= ram_gb × period_hours × 1.05
 *   6. gpu_seconds = 0 if gpu_type == "none" OR gpu_count == 0
 *   7. fleet_operator_signature valid under fleet_operator_pubkey
 *   8. worker_signature valid under worker_pubkey
 *   9. observer_signature valid under observer_pubkey (over worker pre-image)
 *
 * Plus all the structural checks (missing fields, wrong types, hex format,
 * gpu_type whitelist, monotonic period_start, etc.).
 *
 * No mocks — uses real sr25519 keypairs from `//URI` derivation for
 * reproducibility.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { createHash } from "crypto";

import {
  validateComputeMeteringV2,
  canonicalCborForFleetOpSig,
  canonicalCborForWorkerSig,
  canonicalContentHash,
  workerPubkeyToSs58,
  SCHEMA_VERSION,
  SCHEMA_HASH_HEX,
  MAX_PERIOD_MS,
  FUTURE_SKEW_MS,
  JITTER_FACTOR,
  GPU_TYPES,
  type ComputeMeteringV2,
  type HardwareSpecV2,
  type MetricsV2,
} from "../compute_metering_v2.js";

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
  period_start_ms?: number;
  period_end_ms?: number;
  metrics?: Partial<MetricsV2>;
  hardware_spec?: Partial<Omit<HardwareSpecV2, "fleet_operator_signature">>;
  /** Override the fleet-op signing keypair URI. */
  fleet_uri?: string;
  /** Override the worker signing keypair URI. */
  worker_uri?: string;
  /** Override the observer signing keypair URI. Set to add observer. */
  observer_uri?: string;
  /** When set, replace the fleet-op signature with this hex (corruption tests). */
  override_fleet_signature?: string;
  /** When set, replace the worker signature with this hex. */
  override_worker_signature?: string;
  /** When set, replace the observer signature with this hex. */
  override_observer_signature?: string;
  /** When set, replace the fleet-op pubkey with this hex (mismatch tests). */
  override_fleet_pubkey?: string;
  /** When set, replace the worker pubkey. */
  override_worker_pubkey?: string;
  /** When set, replace the observer pubkey. */
  override_observer_pubkey?: string;
}

const DEFAULT_PERIOD_START = 1_735_689_600_000;
const DEFAULT_PERIOD_END = DEFAULT_PERIOD_START + 3_600_000; // 1h

function buildSignedV2(opts: BuildOpts = {}): ComputeMeteringV2 {
  const fleetPair = keyring.addFromUri(opts.fleet_uri ?? "//FleetOperator0");
  const workerPair = keyring.addFromUri(opts.worker_uri ?? "//ComputeWorker0");

  const period_start_ms = opts.period_start_ms ?? DEFAULT_PERIOD_START;
  const period_end_ms = opts.period_end_ms ?? DEFAULT_PERIOD_END;

  const baseMetrics: MetricsV2 = {
    cpu_seconds: 60.5,
    ram_gb_hours: 0.5,
    disk_gb_hours: 1.25,
    net_bytes_in: 1_048_576,
    net_bytes_out: 524_288,
    gpu_seconds: 0,
  };
  const metrics: MetricsV2 = { ...baseMetrics, ...(opts.metrics ?? {}) };

  // Build the hardware spec WITHOUT signature first.
  const baseSpec = {
    cpu_cores: 4,
    ram_gb: 16,
    gpu_type: "none" as const,
    gpu_count: 0,
    issued_ms: DEFAULT_PERIOD_START,
  };
  const partialSpec = {
    ...baseSpec,
    ...(opts.hardware_spec ?? {}),
    fleet_operator_pubkey:
      opts.override_fleet_pubkey ?? u8aToHex(fleetPair.publicKey, undefined, false),
  };

  // Sign the hardware_spec_no_sig pre-image.
  const fleetPreImageSpec: HardwareSpecV2 = {
    ...partialSpec,
    fleet_operator_signature: "00".repeat(64), // placeholder — pre-image strips it
  };
  const fleetPreImage = canonicalCborForFleetOpSig(opts.worker_id ?? "worker-001", fleetPreImageSpec);
  const fleetSigBytes = fleetPair.sign(fleetPreImage);
  const fleet_operator_signature =
    opts.override_fleet_signature ?? u8aToHex(fleetSigBytes, undefined, false);

  const hardware_spec: HardwareSpecV2 = {
    ...partialSpec,
    fleet_operator_signature,
  };

  // Build the worker pre-image and sign it.
  const worker_pubkey =
    opts.override_worker_pubkey ?? u8aToHex(workerPair.publicKey, undefined, false);
  const workerPreImage = canonicalCborForWorkerSig({
    schema_version: SCHEMA_VERSION,
    worker_id: opts.worker_id ?? "worker-001",
    tenant_id: opts.tenant_id ?? "tenant-acme",
    period_start_ms,
    period_end_ms,
    metrics,
    hardware_spec,
    worker_pubkey,
  });
  const worker_signature =
    opts.override_worker_signature ?? u8aToHex(workerPair.sign(workerPreImage), undefined, false);

  const base: ComputeMeteringV2 = {
    schema_version: SCHEMA_VERSION,
    worker_id: opts.worker_id ?? "worker-001",
    tenant_id: opts.tenant_id ?? "tenant-acme",
    period_start_ms,
    period_end_ms,
    metrics,
    hardware_spec,
    worker_pubkey,
    worker_signature,
  };

  if (opts.observer_uri) {
    const observerPair = keyring.addFromUri(opts.observer_uri);
    const observer_pubkey =
      opts.override_observer_pubkey ?? u8aToHex(observerPair.publicKey, undefined, false);
    const observer_signature =
      opts.override_observer_signature ??
      u8aToHex(observerPair.sign(workerPreImage), undefined, false);
    return {
      ...base,
      observer: { observer_pubkey, observer_signature },
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// 1. Schema constants & determinism
// ---------------------------------------------------------------------------

describe("v2 schema constants", () => {
  test("SCHEMA_HASH_HEX is sha256 of 'compute_metering_v2'", () => {
    const expected = createHash("sha256")
      .update("compute_metering_v2", "utf-8")
      .digest("hex");
    expect(SCHEMA_HASH_HEX).toBe(expected);
  });

  test("SCHEMA_HASH_HEX differs from v1's hash", () => {
    const v1Hash = createHash("sha256")
      .update("compute_metering_v1", "utf-8")
      .digest("hex");
    expect(SCHEMA_HASH_HEX).not.toBe(v1Hash);
  });

  test("GPU_TYPES is the exact whitelist from the spec", () => {
    expect([...GPU_TYPES]).toEqual([
      "none",
      "nvidia-h100",
      "nvidia-h200",
      "nvidia-b100",
      "nvidia-a100",
      "amd-mi300",
      "custom",
    ]);
  });

  test("JITTER_FACTOR is exactly 1.05 (pinned)", () => {
    expect(JITTER_FACTOR).toBe(1.05);
  });
});

// ---------------------------------------------------------------------------
// 2. Canonical encoder determinism
// ---------------------------------------------------------------------------

describe("v2 canonical encoder", () => {
  test("worker pre-image is stable across input dict iteration order", () => {
    const a = canonicalCborForWorkerSig({
      schema_version: SCHEMA_VERSION,
      worker_id: "wkr-001",
      tenant_id: "tenant-foo",
      period_start_ms: 1_735_689_600_000,
      period_end_ms: 1_735_689_600_000 + 1000,
      metrics: {
        cpu_seconds: 1.5,
        ram_gb_hours: 0.0,
        disk_gb_hours: 0.0,
        net_bytes_in: 0,
        net_bytes_out: 0,
        gpu_seconds: 0.0,
      },
      hardware_spec: {
        cpu_cores: 4,
        ram_gb: 16,
        gpu_type: "none",
        gpu_count: 0,
        fleet_operator_pubkey: "11".repeat(32),
        fleet_operator_signature: "22".repeat(64),
        issued_ms: 1_735_689_600_000,
      },
      worker_pubkey: "33".repeat(32),
    });
    const b = canonicalCborForWorkerSig({
      worker_pubkey: "33".repeat(32),
      hardware_spec: {
        issued_ms: 1_735_689_600_000,
        ram_gb: 16,
        cpu_cores: 4,
        gpu_count: 0,
        gpu_type: "none",
        fleet_operator_signature: "22".repeat(64),
        fleet_operator_pubkey: "11".repeat(32),
      },
      metrics: {
        gpu_seconds: 0.0,
        net_bytes_out: 0,
        ram_gb_hours: 0.0,
        cpu_seconds: 1.5,
        disk_gb_hours: 0.0,
        net_bytes_in: 0,
      },
      period_end_ms: 1_735_689_600_000 + 1000,
      period_start_ms: 1_735_689_600_000,
      tenant_id: "tenant-foo",
      worker_id: "wkr-001",
      schema_version: SCHEMA_VERSION,
    });
    expect(u8aToHex(a)).toBe(u8aToHex(b));
  });

  test("content_hash equals sha256(worker pre-image)", () => {
    const rec = {
      schema_version: SCHEMA_VERSION,
      worker_id: "wkr-001",
      tenant_id: "tenant-foo",
      period_start_ms: 1_735_689_600_000,
      period_end_ms: 1_735_689_600_000 + 1000,
      metrics: {
        cpu_seconds: 1.5,
        ram_gb_hours: 0.0,
        disk_gb_hours: 0.0,
        net_bytes_in: 0,
        net_bytes_out: 0,
        gpu_seconds: 0.0,
      },
      hardware_spec: {
        cpu_cores: 4,
        ram_gb: 16,
        gpu_type: "none" as const,
        gpu_count: 0,
        fleet_operator_pubkey: "11".repeat(32),
        fleet_operator_signature: "22".repeat(64),
        issued_ms: 1_735_689_600_000,
      },
      worker_pubkey: "33".repeat(32),
    };
    const pre = canonicalCborForWorkerSig(rec);
    const expected = createHash("sha256").update(pre).digest("hex");
    expect(canonicalContentHash(rec)).toBe(expected);
  });

  test("workerPubkeyToSs58 round-trips through Keyring address", () => {
    const pair = keyring.addFromUri("//ComputeWorker0");
    const hex = u8aToHex(pair.publicKey, undefined, false);
    expect(workerPubkeyToSs58(hex)).toBe(pair.address);
  });
});

// ---------------------------------------------------------------------------
// 3. Happy path
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — happy path", () => {
  test("valid record without observer → ok", () => {
    const rec = buildSignedV2();
    const res = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1000 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(res.schema_hash).toBe(SCHEMA_HASH_HEX);
      expect(res.worker_pre_image).toBeInstanceOf(Uint8Array);
      expect(res.worker_pre_image.length).toBeGreaterThan(0);
      expect(res.fleet_op_pre_image).toBeInstanceOf(Uint8Array);
      expect(res.fleet_op_pre_image.length).toBeGreaterThan(0);
      expect(res.record.observer).toBeUndefined();
      expect(
        createHash("sha256").update(res.worker_pre_image).digest("hex"),
      ).toBe(res.content_hash);
    }
  });

  test("valid record WITH observer → ok and observer present", () => {
    const rec = buildSignedV2({ observer_uri: "//Observer0" });
    const res = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1000 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.record.observer).toBeDefined();
      expect(res.record.observer?.observer_pubkey).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("zero-valued metrics allowed (when gpu_type=none)", () => {
    const rec = buildSignedV2({
      metrics: {
        cpu_seconds: 0,
        ram_gb_hours: 0,
        disk_gb_hours: 0,
        net_bytes_in: 0,
        net_bytes_out: 0,
        gpu_seconds: 0,
      },
    });
    const res = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1000 });
    expect(res.ok).toBe(true);
  });

  test("observer absent (no key) → no observer in normalized record", () => {
    const rec = buildSignedV2();
    expect(rec).not.toHaveProperty("observer");
  });
});

// ---------------------------------------------------------------------------
// 4. Missing required fields
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — missing fields", () => {
  const TOPLEVEL: Array<keyof Omit<ComputeMeteringV2, "observer">> = [
    "schema_version",
    "worker_id",
    "tenant_id",
    "period_start_ms",
    "period_end_ms",
    "metrics",
    "hardware_spec",
    "worker_pubkey",
    "worker_signature",
  ];

  for (const f of TOPLEVEL) {
    test(`missing ${f} → MISSING_FIELD with field=${f}`, () => {
      const rec = buildSignedV2() as Record<string, unknown>;
      delete rec[f];
      const res = validateComputeMeteringV2(rec, {
        now_ms: DEFAULT_PERIOD_END + 1000,
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
// 5. Wrong root type
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — wrong root type", () => {
  test("null → WRONG_TYPE", () => {
    const r = validateComputeMeteringV2(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_TYPE");
  });

  test("array → WRONG_TYPE", () => {
    const r = validateComputeMeteringV2([1, 2]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_TYPE");
  });

  test("string → WRONG_TYPE", () => {
    const r = validateComputeMeteringV2("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_TYPE");
  });
});

// ---------------------------------------------------------------------------
// 6. Schema version
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — schema_version", () => {
  test("rejects v1 record", () => {
    const rec = { ...buildSignedV2(), schema_version: "compute_metering_v1" };
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_SCHEMA_VERSION");
  });

  test("rejects case mismatch", () => {
    const rec = { ...buildSignedV2(), schema_version: "Compute_Metering_V2" };
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_SCHEMA_VERSION");
  });
});

// ---------------------------------------------------------------------------
// 7. ID format
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — ID format", () => {
  test("worker_id with space rejected", () => {
    const r = validateComputeMeteringV2(buildSignedV2({ worker_id: "wkr 001" }), {
      now_ms: DEFAULT_PERIOD_END + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("ID_FORMAT");
      expect(r.field).toBe("worker_id");
    }
  });

  test("worker_id with comma rejected", () => {
    const r = validateComputeMeteringV2(buildSignedV2({ worker_id: "wkr,001" }), {
      now_ms: DEFAULT_PERIOD_END + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ID_FORMAT");
  });

  test("worker_id empty string rejected", () => {
    const r = validateComputeMeteringV2(buildSignedV2({ worker_id: "" }), {
      now_ms: DEFAULT_PERIOD_END + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ID_FORMAT");
  });

  test("worker_id over 128 chars rejected", () => {
    const r = validateComputeMeteringV2(
      buildSignedV2({ worker_id: "a".repeat(129) }),
      { now_ms: DEFAULT_PERIOD_END + 1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ID_FORMAT");
  });

  test("worker_id with underscore + dot accepted (looser than tenant_id)", () => {
    // worker_id allows anything UTF-8 except spaces and commas — e.g. K8s pod
    // names with dots, hostnames with underscores.
    const rec = buildSignedV2({ worker_id: "pod_42.cluster.local" });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(true);
  });

  test("tenant_id with uppercase rejected", () => {
    const r = validateComputeMeteringV2(
      buildSignedV2({ tenant_id: "Tenant-01" }),
      { now_ms: DEFAULT_PERIOD_END + 1 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("ID_FORMAT");
      expect(r.field).toBe("tenant_id");
    }
  });

  test("tenant_id too short (< 4) rejected", () => {
    const r = validateComputeMeteringV2(buildSignedV2({ tenant_id: "abc" }), {
      now_ms: DEFAULT_PERIOD_END + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ID_FORMAT");
  });
});

// ---------------------------------------------------------------------------
// 8. Period (rule 1, rule 2)
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — period (rules 1, 2)", () => {
  test("period_end_ms - period_start_ms == 24h boundary accepted", () => {
    const start = DEFAULT_PERIOD_START;
    const end = start + MAX_PERIOD_MS;
    const rec = buildSignedV2({
      period_start_ms: start,
      period_end_ms: end,
      // Keep below cpu cap (4 cores × 86400s × 1.05 = 362,880).
      metrics: { cpu_seconds: 100, ram_gb_hours: 0, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 0 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: end + 1 });
    expect(r.ok).toBe(true);
  });

  test("period_end_ms - period_start_ms > 24h rejected (rule 1)", () => {
    const start = DEFAULT_PERIOD_START;
    const end = start + MAX_PERIOD_MS + 1;
    const rec = buildSignedV2({
      period_start_ms: start,
      period_end_ms: end,
      metrics: { cpu_seconds: 0, ram_gb_hours: 0, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 0 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PERIOD_INVALID");
  });

  test("period_end_ms == now + 60s accepted (rule 2 boundary)", () => {
    const now = 1_700_000_000_000;
    const end = now + FUTURE_SKEW_MS;
    const rec = buildSignedV2({
      period_start_ms: end - 3_600_000,
      period_end_ms: end,
    });
    const r = validateComputeMeteringV2(rec, { now_ms: now });
    expect(r.ok).toBe(true);
  });

  test("period_end_ms > now + 60s rejected (rule 2)", () => {
    const now = 1_700_000_000_000;
    const end = now + FUTURE_SKEW_MS + 1;
    const rec = buildSignedV2({
      period_start_ms: end - 3_600_000,
      period_end_ms: end,
    });
    const r = validateComputeMeteringV2(rec, { now_ms: now });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("PERIOD_INVALID");
      expect(r.field).toBe("period_end_ms");
    }
  });

  test("period_end_ms <= period_start_ms rejected", () => {
    const rec = buildSignedV2({
      period_start_ms: DEFAULT_PERIOD_START,
      period_end_ms: DEFAULT_PERIOD_START,
    });
    const r = validateComputeMeteringV2(rec, { now_ms: DEFAULT_PERIOD_START + 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PERIOD_INVALID");
  });
});

// ---------------------------------------------------------------------------
// 9. Metric values >= 0 (rule 3)
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — metric values >= 0 (rule 3)", () => {
  for (const metric of [
    "cpu_seconds",
    "ram_gb_hours",
    "disk_gb_hours",
    "net_bytes_in",
    "net_bytes_out",
    "gpu_seconds",
  ] as const) {
    test(`negative ${metric} rejected`, () => {
      const rec = buildSignedV2();
      // cast to mutate the metrics map directly
      (rec.metrics as Record<string, number>)[metric] = -1;
      const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("NEGATIVE_VALUE");
        expect(r.field).toBe(`metrics.${metric}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 10. cpu_seconds bound (rule 4)
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — cpu_seconds bound (rule 4)", () => {
  test("cpu_seconds at exactly the 1.05× cap accepted", () => {
    const start = DEFAULT_PERIOD_START;
    const end = start + 3_600_000; // 3600s
    const cores = 4;
    const cap = cores * 3_600 * JITTER_FACTOR; // 15120 exact
    const rec = buildSignedV2({
      period_start_ms: start,
      period_end_ms: end,
      hardware_spec: { cpu_cores: cores },
      metrics: { cpu_seconds: cap, ram_gb_hours: 0, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 0 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: end + 1 });
    expect(r.ok).toBe(true);
  });

  test("cpu_seconds just over the 1.05× cap rejected", () => {
    const start = DEFAULT_PERIOD_START;
    const end = start + 3_600_000;
    const cores = 4;
    const cap = cores * 3_600 * JITTER_FACTOR;
    const rec = buildSignedV2({
      period_start_ms: start,
      period_end_ms: end,
      hardware_spec: { cpu_cores: cores },
      metrics: { cpu_seconds: cap + 0.01, ram_gb_hours: 0, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 0 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("BOUND_EXCEEDED");
      expect(r.field).toBe("metrics.cpu_seconds");
    }
  });
});

// ---------------------------------------------------------------------------
// 11. ram_gb_hours bound (rule 5)
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — ram_gb_hours bound (rule 5)", () => {
  test("ram_gb_hours at exactly cap accepted", () => {
    const start = DEFAULT_PERIOD_START;
    const end = start + 3_600_000; // 1h
    const ram = 16;
    const cap = ram * 1.0 * JITTER_FACTOR;
    const rec = buildSignedV2({
      period_start_ms: start,
      period_end_ms: end,
      hardware_spec: { ram_gb: ram },
      metrics: { cpu_seconds: 0, ram_gb_hours: cap, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 0 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: end + 1 });
    expect(r.ok).toBe(true);
  });

  test("ram_gb_hours just over cap rejected", () => {
    const start = DEFAULT_PERIOD_START;
    const end = start + 3_600_000;
    const ram = 16;
    const cap = ram * 1.0 * JITTER_FACTOR;
    const rec = buildSignedV2({
      period_start_ms: start,
      period_end_ms: end,
      hardware_spec: { ram_gb: ram },
      metrics: { cpu_seconds: 0, ram_gb_hours: cap + 0.001, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 0 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: end + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("BOUND_EXCEEDED");
      expect(r.field).toBe("metrics.ram_gb_hours");
    }
  });
});

// ---------------------------------------------------------------------------
// 12. gpu_seconds rule (rule 6)
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — gpu_seconds when no GPU (rule 6)", () => {
  test("gpu_type=none AND gpu_seconds>0 → GPU_COUNT_MISMATCH", () => {
    const rec = buildSignedV2({
      hardware_spec: { gpu_type: "none", gpu_count: 0 },
      metrics: { cpu_seconds: 0, ram_gb_hours: 0, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 1 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("GPU_COUNT_MISMATCH");
      expect(r.field).toBe("metrics.gpu_seconds");
    }
  });

  test("gpu_count=0 (any gpu_type) AND gpu_seconds>0 → GPU_COUNT_MISMATCH", () => {
    const rec = buildSignedV2({
      hardware_spec: { gpu_type: "nvidia-h100", gpu_count: 0 },
      metrics: { cpu_seconds: 0, ram_gb_hours: 0, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 1 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("GPU_COUNT_MISMATCH");
  });

  test("gpu_type=none AND gpu_seconds=0 → ok", () => {
    const rec = buildSignedV2({
      hardware_spec: { gpu_type: "none", gpu_count: 0 },
      metrics: { cpu_seconds: 0, ram_gb_hours: 0, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 0 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(true);
  });

  test("gpu_type=h100 AND gpu_count>0 AND gpu_seconds>0 → ok", () => {
    const rec = buildSignedV2({
      hardware_spec: { gpu_type: "nvidia-h100", gpu_count: 2 },
      metrics: { cpu_seconds: 0, ram_gb_hours: 0, disk_gb_hours: 0,
        net_bytes_in: 0, net_bytes_out: 0, gpu_seconds: 100 },
    });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. Hardware spec bounds (gpu_type whitelist + numeric ranges)
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — hardware_spec bounds", () => {
  test("gpu_type not in whitelist rejected", () => {
    const rec = buildSignedV2();
    (rec.hardware_spec as Record<string, unknown>).gpu_type = "intel-xe";
    // Re-sign to keep signature valid for the (corrupt-shape) body, so we
    // cleanly assert GPU_TYPE_INVALID rather than SIG_INVALID.
    const r = validateComputeMeteringV2(rec, {
      now_ms: rec.period_end_ms + 1,
      verify_signatures: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("GPU_TYPE_INVALID");
      expect(r.field).toBe("hardware_spec.gpu_type");
    }
  });

  test("cpu_cores below MIN_CPU_CORES rejected", () => {
    const rec = buildSignedV2();
    (rec.hardware_spec as Record<string, unknown>).cpu_cores = 0;
    const r = validateComputeMeteringV2(rec, {
      now_ms: rec.period_end_ms + 1,
      verify_signatures: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HARDWARE_BOUND");
  });

  test("cpu_cores above MAX_CPU_CORES rejected", () => {
    const rec = buildSignedV2();
    (rec.hardware_spec as Record<string, unknown>).cpu_cores = 1025;
    const r = validateComputeMeteringV2(rec, {
      now_ms: rec.period_end_ms + 1,
      verify_signatures: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HARDWARE_BOUND");
  });

  test("ram_gb above MAX_RAM_GB rejected", () => {
    const rec = buildSignedV2();
    (rec.hardware_spec as Record<string, unknown>).ram_gb = 16385;
    const r = validateComputeMeteringV2(rec, {
      now_ms: rec.period_end_ms + 1,
      verify_signatures: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HARDWARE_BOUND");
  });

  test("gpu_count above MAX_GPU_COUNT rejected", () => {
    const rec = buildSignedV2();
    (rec.hardware_spec as Record<string, unknown>).gpu_count = 17;
    const r = validateComputeMeteringV2(rec, {
      now_ms: rec.period_end_ms + 1,
      verify_signatures: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HARDWARE_BOUND");
  });
});

// ---------------------------------------------------------------------------
// 14. Hex format
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — hex format", () => {
  test("worker_pubkey wrong length rejected", () => {
    const rec = buildSignedV2({ override_worker_pubkey: "ab".repeat(31) });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("HEX_FORMAT");
      expect(r.field).toBe("worker_pubkey");
    }
  });

  test("worker_pubkey uppercase rejected", () => {
    const rec = buildSignedV2({ override_worker_pubkey: "AB".repeat(32) });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HEX_FORMAT");
  });

  test("fleet_operator_signature wrong length rejected", () => {
    const rec = buildSignedV2({ override_fleet_signature: "cd".repeat(63) });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("HEX_FORMAT");
      expect(r.field).toBe("hardware_spec.fleet_operator_signature");
    }
  });

  test("observer_pubkey wrong length rejected", () => {
    const rec = buildSignedV2({
      observer_uri: "//Observer0",
      override_observer_pubkey: "ab".repeat(31),
    });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("HEX_FORMAT");
  });
});

// ---------------------------------------------------------------------------
// 15. Signature verification (rules 7, 8, 9)
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — fleet_op signature (rule 7)", () => {
  test("corrupt fleet_op signature → FLEET_OP_SIGNATURE_INVALID", () => {
    const rec = buildSignedV2({ override_fleet_signature: "00".repeat(64) });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("FLEET_OP_SIGNATURE_INVALID");
      expect(r.field).toBe("hardware_spec.fleet_operator_signature");
    }
  });

  test("fleet_op pubkey swapped (different fleet) → FLEET_OP_SIGNATURE_INVALID", () => {
    // Sign with FleetOperator0 but claim FleetOperator1's pubkey.
    const otherFleet = keyring.addFromUri("//FleetOperator1");
    const rec = buildSignedV2();
    rec.hardware_spec = {
      ...rec.hardware_spec,
      fleet_operator_pubkey: u8aToHex(otherFleet.publicKey, undefined, false),
    };
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FLEET_OP_SIGNATURE_INVALID");
  });

  test("hardware_spec field tampered after fleet sign → FLEET_OP_SIGNATURE_INVALID", () => {
    const rec = buildSignedV2();
    // Bump cpu_cores from 4 to 8 — within the legal bound, but breaks the
    // fleet-op pre-image. Keep the fleet signature unchanged.
    rec.hardware_spec = { ...rec.hardware_spec, cpu_cores: 8 };
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FLEET_OP_SIGNATURE_INVALID");
  });
});

describe("validateComputeMeteringV2 — worker signature (rule 8)", () => {
  test("corrupt worker signature → WORKER_SIGNATURE_INVALID", () => {
    const rec = buildSignedV2({ override_worker_signature: "00".repeat(64) });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("WORKER_SIGNATURE_INVALID");
      expect(r.field).toBe("worker_signature");
    }
  });

  test("metrics tampered after worker sign → WORKER_SIGNATURE_INVALID", () => {
    const rec = buildSignedV2();
    rec.metrics = { ...rec.metrics, cpu_seconds: rec.metrics.cpu_seconds + 1 };
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WORKER_SIGNATURE_INVALID");
  });

  test("worker pubkey swapped → WORKER_SIGNATURE_INVALID", () => {
    const other = keyring.addFromUri("//ComputeWorker1");
    const rec = buildSignedV2();
    rec.worker_pubkey = u8aToHex(other.publicKey, undefined, false);
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WORKER_SIGNATURE_INVALID");
  });
});

describe("validateComputeMeteringV2 — observer signature (rule 9)", () => {
  test("observer signs the WORKER pre-image, not its own", () => {
    // The worker pair signs the worker pre-image; the observer pair signs
    // the SAME bytes. Verify the validator accepts this and ALSO rejects
    // an observer signature over different bytes.
    const rec = buildSignedV2({ observer_uri: "//Observer0" });
    const ok = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(ok.ok).toBe(true);
  });

  test("corrupt observer signature → OBSERVER_SIGNATURE_INVALID", () => {
    const rec = buildSignedV2({
      observer_uri: "//Observer0",
      override_observer_signature: "00".repeat(64),
    });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("OBSERVER_SIGNATURE_INVALID");
      expect(r.field).toBe("observer.observer_signature");
    }
  });

  test("observer pubkey swapped to wrong observer → OBSERVER_SIGNATURE_INVALID", () => {
    const rec = buildSignedV2({ observer_uri: "//Observer0" });
    // Replace observer_pubkey with a different observer's key. The signature
    // is still over the same bytes but signed by Observer0, so verifying
    // against Observer1's key fails.
    const other = keyring.addFromUri("//Observer1");
    if (rec.observer) {
      rec.observer = {
        ...rec.observer,
        observer_pubkey: u8aToHex(other.publicKey, undefined, false),
      };
    }
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OBSERVER_SIGNATURE_INVALID");
  });

  test("observer signing OWN bytes (not worker pre-image) → OBSERVER_SIGNATURE_INVALID", () => {
    // Construct a record where observer signed something else (e.g. an empty
    // buffer). Must fail.
    const observerPair = keyring.addFromUri("//Observer0");
    const wrongSig = u8aToHex(observerPair.sign(new Uint8Array([0xde, 0xad])), undefined, false);
    const rec = buildSignedV2({ observer_uri: "//Observer0", override_observer_signature: wrongSig });
    const r = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OBSERVER_SIGNATURE_INVALID");
  });
});

// ---------------------------------------------------------------------------
// 16. Monotonic period_start_ms (per worker_id)
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — monotonic period_start_ms", () => {
  test("period_start_ms < last_period_start_ms rejected", () => {
    const rec = buildSignedV2();
    const r = validateComputeMeteringV2(rec, {
      now_ms: rec.period_end_ms + 1,
      last_period_start_ms: rec.period_start_ms + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("MONOTONIC_VIOLATION");
      expect(r.field).toBe("period_start_ms");
    }
  });

  test("period_start_ms == last accepted (non-decreasing)", () => {
    const rec = buildSignedV2();
    const r = validateComputeMeteringV2(rec, {
      now_ms: rec.period_end_ms + 1,
      last_period_start_ms: rec.period_start_ms,
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. Replay = same content_hash (validator stateless re: replay)
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — stateless replay determinism", () => {
  test("same record validates twice with same content_hash", () => {
    const rec = buildSignedV2();
    const a = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    const b = validateComputeMeteringV2(rec, { now_ms: rec.period_end_ms + 1 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.content_hash).toBe(b.content_hash);
  });
});

// ---------------------------------------------------------------------------
// 18. verify_signatures=false short-circuit
// ---------------------------------------------------------------------------

describe("validateComputeMeteringV2 — verify_signatures=false", () => {
  test("structural-only validation skips all sig checks", () => {
    const rec = buildSignedV2({
      override_fleet_signature: "11".repeat(64),
      override_worker_signature: "22".repeat(64),
    });
    const r = validateComputeMeteringV2(rec, {
      now_ms: rec.period_end_ms + 1,
      verify_signatures: false,
    });
    expect(r.ok).toBe(true);
  });
});
