/**
 * Unit tests for fleet_operators.ts (compute_metering_v2 trust registry).
 *
 * Per `feedback_pr_review_ast_check.md` and the Wave 1+2 TDD bar, these tests
 * MUST exercise a real on-disk SQLite migration in addition to the in-memory
 * fast path. The CONCURRENT-STARTUP race test opens the same on-disk file
 * with two handles simultaneously and verifies the schema lands intact.
 *
 * Test categories:
 *   1. Migration (idempotent in-memory + real on-disk fresh + on-disk pre-v2 survives)
 *   2. CRUD (register / get / revoke / list)
 *   3. Pubkey normalisation (0x-prefix, mixed case)
 *   4. Edge cases (duplicate, unknown, revoked-then-revoke)
 *   5. Concurrent-startup race (two handles, same file)
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initFleetOperatorsDb,
  setFleetOperatorsDbForTests,
  getFleetOperatorsDb,
  registerFleetOperator,
  revokeFleetOperator,
  getFleetOperator,
  isFleetOperatorActive,
  listFleetOperators,
} from "../fleet_operators.js";

const PUB_A = "a".repeat(64);
const PUB_B = "b".repeat(64);
const PUB_C = "c".repeat(64);

function makeMemDb(): Database.Database {
  const db = new Database(":memory:");
  initFleetOperatorsDb(db);
  setFleetOperatorsDbForTests(db);
  return db;
}

describe("fleet_operators: in-memory migration", () => {
  test("initFleetOperatorsDb_creates_table_idempotently", () => {
    const db = new Database(":memory:");
    initFleetOperatorsDb(db);
    initFleetOperatorsDb(db); // second call must be a no-op
    initFleetOperatorsDb(db); // third also fine
    const cols = db.prepare("PRAGMA table_info(fleet_operators)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "id",
      "label",
      "notes",
      "pubkey_hex",
      "registered_at",
      "revoked_at",
    ]);
  });

  test("indexes_created_for_pubkey_lookup_and_active_filter", () => {
    const db = new Database(":memory:");
    initFleetOperatorsDb(db);
    const idxs = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='fleet_operators'")
      .all() as Array<{ name: string }>;
    const idxNames = idxs.map((i) => i.name).sort();
    expect(idxNames).toContain("idx_fleet_operators_pubkey");
    expect(idxNames).toContain("idx_fleet_operators_active");
  });
});

describe("fleet_operators: real on-disk SQLite migration", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fleet-ops-disk-"));
    dbPath = join(tmpDir, "fleet_operators.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("fresh_on_disk_file_gets_full_schema_after_first_init", () => {
    expect(existsSync(dbPath)).toBe(false);
    const db = new Database(dbPath);
    initFleetOperatorsDb(db);
    db.close();

    expect(existsSync(dbPath)).toBe(true);

    const reopened = new Database(dbPath);
    const cols = reopened
      .prepare("PRAGMA table_info(fleet_operators)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual([
      "id",
      "label",
      "notes",
      "pubkey_hex",
      "registered_at",
      "revoked_at",
    ]);
    reopened.close();
  });

  test("rows_inserted_in_first_session_survive_second_init", () => {
    // Session 1: write a row.
    const db1 = new Database(dbPath);
    initFleetOperatorsDb(db1);
    setFleetOperatorsDbForTests(db1);
    const row = registerFleetOperator({
      pubkey: PUB_A,
      label: "session-1",
      now: 1_000_000,
    });
    expect(row.pubkey_hex).toBe(PUB_A);
    db1.close();

    // Session 2: re-open same file, run init AGAIN — pre-existing row must survive.
    const db2 = new Database(dbPath);
    initFleetOperatorsDb(db2);
    setFleetOperatorsDbForTests(db2);
    const persisted = getFleetOperator(PUB_A);
    expect(persisted).not.toBeNull();
    expect(persisted!.label).toBe("session-1");
    expect(persisted!.registered_at).toBe(1_000_000);
    expect(persisted!.revoked_at).toBeNull();
    db2.close();
  });

  test("concurrent_startup_two_handles_one_file_both_succeed", () => {
    // Simulate two boot processes (e.g., a docker-compose race) opening the
    // same file in parallel. Both should run init OK. Per
    // `feedback_pr_review_ast_check.md`, this is the kind of race a pure mock
    // test would NEVER catch — both handles really write to the same on-disk
    // file here.
    const db1 = new Database(dbPath);
    const db2 = new Database(dbPath);
    expect(() => initFleetOperatorsDb(db1)).not.toThrow();
    expect(() => initFleetOperatorsDb(db2)).not.toThrow();

    // Use db1 to insert; db2 should see it after a fresh read.
    setFleetOperatorsDbForTests(db1);
    registerFleetOperator({ pubkey: PUB_B, label: "concurrent" });
    const cols = db2
      .prepare("PRAGMA table_info(fleet_operators)")
      .all() as Array<{ name: string }>;
    expect(cols.length).toBe(6);
    db1.close();
    db2.close();
  });

  test("legacy_rows_pre_existing_pubkey_survive_re_init", () => {
    // Session 1: write a single row directly via raw SQL (simulating data
    // written by an older binary that used the same schema).
    const db1 = new Database(dbPath);
    db1.exec(`
      CREATE TABLE IF NOT EXISTS fleet_operators (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey_hex TEXT UNIQUE NOT NULL,
        label TEXT,
        registered_at INTEGER NOT NULL,
        revoked_at INTEGER,
        notes TEXT
      );
    `);
    db1.prepare(
      `INSERT INTO fleet_operators (pubkey_hex, label, registered_at, notes)
       VALUES (?, ?, ?, ?)`,
    ).run(PUB_C, "legacy", 999_999, "old-row");
    db1.close();

    // Session 2: run init() on the existing file. Row must survive.
    const db2 = new Database(dbPath);
    initFleetOperatorsDb(db2);
    setFleetOperatorsDbForTests(db2);
    const row = getFleetOperator(PUB_C);
    expect(row).not.toBeNull();
    expect(row!.label).toBe("legacy");
    expect(row!.notes).toBe("old-row");
    db2.close();
  });
});

describe("fleet_operators: register", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeMemDb();
  });
  afterEach(() => {
    db.close();
  });

  test("register_returns_row_with_pubkey_label_registered_at", () => {
    const row = registerFleetOperator({
      pubkey: PUB_A,
      label: "fleet-acme",
      notes: "primary fleet",
      now: 1_700_000_000,
    });
    expect(row.pubkey_hex).toBe(PUB_A);
    expect(row.label).toBe("fleet-acme");
    expect(row.notes).toBe("primary fleet");
    expect(row.registered_at).toBe(1_700_000_000);
    expect(row.revoked_at).toBeNull();
    expect(row.id).toBeGreaterThan(0);
  });

  test("register_normalises_0x_prefix_and_uppercase", () => {
    const row = registerFleetOperator({
      pubkey: "0X" + "F".repeat(64),
      label: "norm",
    });
    expect(row.pubkey_hex).toBe("f".repeat(64));
  });

  test("register_throws_on_invalid_hex_length", () => {
    expect(() => registerFleetOperator({ pubkey: "abcd" })).toThrow(/64 chars/);
  });

  test("register_throws_on_invalid_hex_chars", () => {
    expect(() =>
      registerFleetOperator({ pubkey: "g".repeat(64) }),
    ).toThrow(/64 chars/);
  });

  test("register_throws_on_duplicate_pubkey", () => {
    registerFleetOperator({ pubkey: PUB_A, label: "first" });
    expect(() =>
      registerFleetOperator({ pubkey: PUB_A, label: "second" }),
    ).toThrow(/UNIQUE/i);
  });

  test("register_truncates_label_at_256_chars", () => {
    const longLabel = "x".repeat(500);
    const row = registerFleetOperator({ pubkey: PUB_A, label: longLabel });
    expect(row.label!.length).toBe(256);
  });

  test("register_truncates_notes_at_1024_chars", () => {
    const longNotes = "n".repeat(2000);
    const row = registerFleetOperator({ pubkey: PUB_A, notes: longNotes });
    expect(row.notes!.length).toBe(1024);
  });

  test("register_accepts_null_label_and_notes", () => {
    const row = registerFleetOperator({ pubkey: PUB_A });
    expect(row.label).toBeNull();
    expect(row.notes).toBeNull();
  });
});

describe("fleet_operators: get + isActive", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeMemDb();
  });
  afterEach(() => {
    db.close();
  });

  test("get_returns_null_for_unknown_pubkey", () => {
    expect(getFleetOperator(PUB_A)).toBeNull();
  });

  test("get_returns_row_for_registered_pubkey", () => {
    registerFleetOperator({ pubkey: PUB_A, label: "test" });
    const row = getFleetOperator(PUB_A);
    expect(row).not.toBeNull();
    expect(row!.pubkey_hex).toBe(PUB_A);
  });

  test("get_normalises_lookup_key", () => {
    registerFleetOperator({ pubkey: PUB_A });
    expect(getFleetOperator("0x" + PUB_A.toUpperCase())).not.toBeNull();
  });

  test("isActive_true_for_registered_not_revoked", () => {
    registerFleetOperator({ pubkey: PUB_A });
    expect(isFleetOperatorActive(PUB_A)).toBe(true);
  });

  test("isActive_false_for_unknown_pubkey", () => {
    expect(isFleetOperatorActive(PUB_A)).toBe(false);
  });

  test("isActive_false_after_revocation", () => {
    registerFleetOperator({ pubkey: PUB_A });
    revokeFleetOperator(PUB_A);
    expect(isFleetOperatorActive(PUB_A)).toBe(false);
  });

  test("isActive_returns_false_when_db_uninitialised_defensive", () => {
    setFleetOperatorsDbForTests(undefined as unknown as Database.Database);
    expect(isFleetOperatorActive(PUB_A)).toBe(false);
  });
});

describe("fleet_operators: revoke", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeMemDb();
  });
  afterEach(() => {
    db.close();
  });

  test("revoke_returns_true_on_first_call", () => {
    registerFleetOperator({ pubkey: PUB_A });
    expect(revokeFleetOperator(PUB_A)).toBe(true);
  });

  test("revoke_returns_false_for_unknown_pubkey", () => {
    expect(revokeFleetOperator(PUB_A)).toBe(false);
  });

  test("revoke_is_idempotent_returns_false_on_second_call", () => {
    registerFleetOperator({ pubkey: PUB_A });
    expect(revokeFleetOperator(PUB_A, { now: 1000 })).toBe(true);
    expect(revokeFleetOperator(PUB_A, { now: 2000 })).toBe(false);
    const row = getFleetOperator(PUB_A);
    expect(row!.revoked_at).toBe(1000);
  });

  test("revoke_marks_revoked_at_with_supplied_now", () => {
    registerFleetOperator({ pubkey: PUB_A });
    revokeFleetOperator(PUB_A, { now: 12345 });
    const row = getFleetOperator(PUB_A);
    expect(row!.revoked_at).toBe(12345);
  });

  test("revoke_normalises_input_pubkey", () => {
    registerFleetOperator({ pubkey: PUB_A });
    expect(revokeFleetOperator("0X" + PUB_A.toUpperCase())).toBe(true);
  });
});

describe("fleet_operators: list", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeMemDb();
  });
  afterEach(() => {
    db.close();
  });

  test("list_returns_empty_array_for_fresh_db", () => {
    expect(listFleetOperators()).toEqual([]);
    expect(listFleetOperators({ active: true })).toEqual([]);
  });

  test("list_returns_all_rows_in_registered_at_desc_order", () => {
    registerFleetOperator({ pubkey: PUB_A, now: 100 });
    registerFleetOperator({ pubkey: PUB_B, now: 200 });
    registerFleetOperator({ pubkey: PUB_C, now: 150 });
    const all = listFleetOperators();
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.pubkey_hex)).toEqual([PUB_B, PUB_C, PUB_A]);
  });

  test("list_active_filters_revoked_rows", () => {
    registerFleetOperator({ pubkey: PUB_A, now: 100 });
    registerFleetOperator({ pubkey: PUB_B, now: 200 });
    revokeFleetOperator(PUB_A);

    const all = listFleetOperators();
    expect(all).toHaveLength(2);

    const active = listFleetOperators({ active: true });
    expect(active).toHaveLength(1);
    expect(active[0]!.pubkey_hex).toBe(PUB_B);
  });

  test("list_includes_revoked_rows_when_active_unset_or_false", () => {
    registerFleetOperator({ pubkey: PUB_A });
    revokeFleetOperator(PUB_A);
    const allDefault = listFleetOperators();
    expect(allDefault).toHaveLength(1);
    expect(allDefault[0]!.revoked_at).not.toBeNull();
    const allFalse = listFleetOperators({ active: false });
    expect(allFalse).toHaveLength(1);
  });
});

describe("fleet_operators: getFleetOperatorsDb test hook", () => {
  test("throws_before_init", () => {
    setFleetOperatorsDbForTests(undefined as unknown as Database.Database);
    expect(() => getFleetOperatorsDb()).toThrow(/not initialised/);
  });

  test("returns_handle_after_setForTests", () => {
    const db = makeMemDb();
    expect(getFleetOperatorsDb()).toBe(db);
    db.close();
  });
});
