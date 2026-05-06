/**
 * Unit tests for observers.ts (compute_metering_v2 optional observer registry).
 *
 * Mirrors fleet_operators.test.ts in shape — same migration pattern, same CRUD
 * surface, same on-disk SQLite verification. Kept as a separate test file
 * (not parameterised) so a regression in one registry's wire-up doesn't get
 * masked by the other passing.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initObserversDb,
  setObserversDbForTests,
  getObserversDb,
  registerObserver,
  revokeObserver,
  getObserver,
  isObserverActive,
  listObservers,
} from "../observers.js";

const PUB_A = "1".repeat(64);
const PUB_B = "2".repeat(64);
const PUB_C = "3".repeat(64);

function makeMemDb(): Database.Database {
  const db = new Database(":memory:");
  initObserversDb(db);
  setObserversDbForTests(db);
  return db;
}

describe("observers: in-memory migration", () => {
  test("initObserversDb_creates_table_idempotently", () => {
    const db = new Database(":memory:");
    initObserversDb(db);
    initObserversDb(db);
    initObserversDb(db);
    const cols = db.prepare("PRAGMA table_info(observers)").all() as Array<{ name: string }>;
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
    initObserversDb(db);
    const idxs = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='observers'")
      .all() as Array<{ name: string }>;
    const idxNames = idxs.map((i) => i.name).sort();
    expect(idxNames).toContain("idx_observers_pubkey");
    expect(idxNames).toContain("idx_observers_active");
  });
});

describe("observers: real on-disk SQLite migration", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "observers-disk-"));
    dbPath = join(tmpDir, "observers.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("fresh_on_disk_file_gets_full_schema_after_first_init", () => {
    expect(existsSync(dbPath)).toBe(false);
    const db = new Database(dbPath);
    initObserversDb(db);
    db.close();

    expect(existsSync(dbPath)).toBe(true);

    const reopened = new Database(dbPath);
    const cols = reopened
      .prepare("PRAGMA table_info(observers)")
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
    const db1 = new Database(dbPath);
    initObserversDb(db1);
    setObserversDbForTests(db1);
    registerObserver({ pubkey: PUB_A, label: "session-1", now: 555_555 });
    db1.close();

    const db2 = new Database(dbPath);
    initObserversDb(db2);
    setObserversDbForTests(db2);
    const persisted = getObserver(PUB_A);
    expect(persisted).not.toBeNull();
    expect(persisted!.label).toBe("session-1");
    expect(persisted!.registered_at).toBe(555_555);
    db2.close();
  });

  test("concurrent_startup_two_handles_one_file_both_succeed", () => {
    const db1 = new Database(dbPath);
    const db2 = new Database(dbPath);
    expect(() => initObserversDb(db1)).not.toThrow();
    expect(() => initObserversDb(db2)).not.toThrow();

    setObserversDbForTests(db1);
    registerObserver({ pubkey: PUB_B, label: "concurrent" });
    const cols = db2.prepare("PRAGMA table_info(observers)").all() as Array<{ name: string }>;
    expect(cols.length).toBe(6);
    db1.close();
    db2.close();
  });
});

describe("observers: register", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeMemDb();
  });
  afterEach(() => {
    db.close();
  });

  test("register_returns_row_with_pubkey_label_registered_at", () => {
    const row = registerObserver({
      pubkey: PUB_A,
      label: "watchtower-1",
      notes: "third-party witness",
      now: 1_700_000_000,
    });
    expect(row.pubkey_hex).toBe(PUB_A);
    expect(row.label).toBe("watchtower-1");
    expect(row.notes).toBe("third-party witness");
    expect(row.registered_at).toBe(1_700_000_000);
    expect(row.revoked_at).toBeNull();
    expect(row.id).toBeGreaterThan(0);
  });

  test("register_normalises_0x_prefix_and_uppercase", () => {
    const row = registerObserver({
      pubkey: "0X" + "F".repeat(64),
      label: "norm",
    });
    expect(row.pubkey_hex).toBe("f".repeat(64));
  });

  test("register_throws_on_invalid_hex_length", () => {
    expect(() => registerObserver({ pubkey: "abcd" })).toThrow(/64 chars/);
  });

  test("register_throws_on_duplicate_pubkey", () => {
    registerObserver({ pubkey: PUB_A });
    expect(() => registerObserver({ pubkey: PUB_A })).toThrow(/UNIQUE/i);
  });
});

describe("observers: get + isActive", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeMemDb();
  });
  afterEach(() => {
    db.close();
  });

  test("get_returns_null_for_unknown_pubkey", () => {
    expect(getObserver(PUB_A)).toBeNull();
  });

  test("get_returns_row_for_registered_pubkey", () => {
    registerObserver({ pubkey: PUB_A });
    const row = getObserver(PUB_A);
    expect(row).not.toBeNull();
    expect(row!.pubkey_hex).toBe(PUB_A);
  });

  test("isActive_true_for_registered_not_revoked", () => {
    registerObserver({ pubkey: PUB_A });
    expect(isObserverActive(PUB_A)).toBe(true);
  });

  test("isActive_false_for_unknown_pubkey", () => {
    expect(isObserverActive(PUB_A)).toBe(false);
  });

  test("isActive_false_after_revocation", () => {
    registerObserver({ pubkey: PUB_A });
    revokeObserver(PUB_A);
    expect(isObserverActive(PUB_A)).toBe(false);
  });

  test("isActive_returns_false_when_db_uninitialised_defensive", () => {
    setObserversDbForTests(undefined as unknown as Database.Database);
    expect(isObserverActive(PUB_A)).toBe(false);
  });
});

describe("observers: revoke", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeMemDb();
  });
  afterEach(() => {
    db.close();
  });

  test("revoke_returns_true_on_first_call", () => {
    registerObserver({ pubkey: PUB_A });
    expect(revokeObserver(PUB_A)).toBe(true);
  });

  test("revoke_returns_false_for_unknown_pubkey", () => {
    expect(revokeObserver(PUB_A)).toBe(false);
  });

  test("revoke_is_idempotent_returns_false_on_second_call", () => {
    registerObserver({ pubkey: PUB_A });
    expect(revokeObserver(PUB_A, { now: 5000 })).toBe(true);
    expect(revokeObserver(PUB_A, { now: 6000 })).toBe(false);
    const row = getObserver(PUB_A);
    expect(row!.revoked_at).toBe(5000);
  });
});

describe("observers: list", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeMemDb();
  });
  afterEach(() => {
    db.close();
  });

  test("list_returns_empty_array_for_fresh_db", () => {
    expect(listObservers()).toEqual([]);
  });

  test("list_returns_all_rows_desc_order_and_active_filters_revoked", () => {
    registerObserver({ pubkey: PUB_A, now: 100 });
    registerObserver({ pubkey: PUB_B, now: 300 });
    registerObserver({ pubkey: PUB_C, now: 200 });
    revokeObserver(PUB_A);

    const all = listObservers();
    expect(all.map((r) => r.pubkey_hex)).toEqual([PUB_B, PUB_C, PUB_A]);

    const active = listObservers({ active: true });
    expect(active.map((r) => r.pubkey_hex)).toEqual([PUB_B, PUB_C]);
  });
});

describe("observers: getObserversDb test hook", () => {
  test("throws_before_init", () => {
    setObserversDbForTests(undefined as unknown as Database.Database);
    expect(() => getObserversDb()).toThrow(/not initialised/);
  });

  test("returns_handle_after_setForTests", () => {
    const db = makeMemDb();
    expect(getObserversDb()).toBe(db);
    db.close();
  });
});
