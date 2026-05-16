/**
 * Tests for the multisig_sigs store + HTTP routes (task #286 — M-of-N
 * sig aggregation for pallet-intent-settlement).
 *
 * Mirrors the witness_targets test pattern (in-memory sqlite + ephemeral
 * `app.listen(0)` + fetch). No supertest dep.
 */

import { describe, test, expect, beforeAll } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import {
  cryptoWaitReady,
  sr25519PairFromSeed,
  sr25519Sign,
} from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

import {
  cleanupMultisigSigs,
  initMultisigSigsDb,
  isMultisigKind,
  listMultisigSigs,
  parseAndValidatePayload,
  parsePathSegments,
  setMultisigSigsDbForTests,
  upsertMultisigSig,
} from "../multisig_sigs_store.js";
import { registerMultisigSigsRoutes } from "../routes/multisig_sigs.js";

function makeMemDb(): Database.Database {
  const db = new Database(":memory:");
  initMultisigSigsDb(db);
  setMultisigSigsDbForTests(db);
  return db;
}

interface Ctx {
  app: express.Express;
  db: Database.Database;
}

function setupApp(): Ctx {
  const db = makeMemDb();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerMultisigSigsRoutes(app);
  return { app, db };
}

async function callApp(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
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
      const init: RequestInit = {
        method,
        headers: { "content-type": "application/json" },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      fetch(url, init)
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

interface Signer {
  pubkey_hex: string;
  sign: (digest: Uint8Array) => string; // returns 128-hex
}

function makeSigner(seedHex: string): Signer {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    seed[i] = parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
  }
  const pair = sr25519PairFromSeed(seed);
  return {
    pubkey_hex: u8aToHex(pair.publicKey, undefined, false),
    sign: (digest: Uint8Array): string =>
      u8aToHex(sr25519Sign(digest, pair), undefined, false),
  };
}

beforeAll(async () => {
  await cryptoWaitReady();
});

describe("multisig_sigs path-segment validation", () => {
  test("accepts settle kind + 32-byte key", () => {
    const r = parsePathSegments("settle", "ab".repeat(32));
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.kind).toBe("settle");
      expect(r.key_hex).toBe("ab".repeat(32));
    }
  });

  test("accepts expire kind", () => {
    const r = parsePathSegments("expire", "0xCD".repeat(32).replace(/0x/g, ""));
    expect("error" in r).toBe(false);
  });

  test("rejects unknown kind", () => {
    const r = parsePathSegments("batch", "ab".repeat(32));
    expect("error" in r).toBe(true);
  });

  test("rejects short key", () => {
    const r = parsePathSegments("settle", "ab".repeat(16));
    expect("error" in r).toBe(true);
  });

  test("rejects non-hex key", () => {
    const r = parsePathSegments("settle", "g".repeat(64));
    expect("error" in r).toBe(true);
  });

  test("strips 0x prefix on key", () => {
    const r = parsePathSegments("settle", "0x" + "ab".repeat(32));
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.key_hex).toBe("ab".repeat(32));
  });
});

describe("multisig_sigs payload validation", () => {
  test("happy path", () => {
    const r = parseAndValidatePayload({
      pubkey: "01".repeat(32),
      sig: "02".repeat(64),
      digest: "03".repeat(32),
    });
    expect("error" in r).toBe(false);
  });

  test("rejects missing fields", () => {
    expect("error" in parseAndValidatePayload({ pubkey: "01".repeat(32) })).toBe(true);
  });

  test("rejects wrong sig length", () => {
    const r = parseAndValidatePayload({
      pubkey: "01".repeat(32),
      sig: "02".repeat(32),
      digest: "03".repeat(32),
    });
    expect("error" in r).toBe(true);
  });

  test("rejects non-hex pubkey", () => {
    const r = parseAndValidatePayload({
      pubkey: "z".repeat(64),
      sig: "02".repeat(64),
      digest: "03".repeat(32),
    });
    expect("error" in r).toBe(true);
  });

  test("lowercases hex", () => {
    const r = parseAndValidatePayload({
      pubkey: "AB".repeat(32),
      sig: "02".repeat(64),
      digest: "03".repeat(32),
    });
    if ("error" in r) throw new Error("expected ok");
    expect(r.pubkey_hex).toBe("ab".repeat(32));
  });
});

describe("multisig_sigs store", () => {
  test("upsert preserves created_at on re-insert", () => {
    makeMemDb();
    const row = {
      kind: "settle" as const,
      key_hex: "aa".repeat(32),
      digest_hex: "bb".repeat(32),
      pubkey_hex: "cc".repeat(32),
      sig_hex: "dd".repeat(64),
    };
    const first = upsertMultisigSig(row);
    const second = upsertMultisigSig({ ...row, sig_hex: "ee".repeat(64) });
    expect(second.created_at).toBe(first.created_at);
    const rows = listMultisigSigs("settle", row.key_hex);
    expect(rows.length).toBe(1);
    expect(rows[0].sig_hex).toBe("ee".repeat(64)); // updated
  });

  test("different digests for same (kind,key,pubkey) coexist", () => {
    makeMemDb();
    upsertMultisigSig({
      kind: "settle",
      key_hex: "aa".repeat(32),
      digest_hex: "11".repeat(32),
      pubkey_hex: "cc".repeat(32),
      sig_hex: "dd".repeat(64),
    });
    upsertMultisigSig({
      kind: "settle",
      key_hex: "aa".repeat(32),
      digest_hex: "22".repeat(32),
      pubkey_hex: "cc".repeat(32),
      sig_hex: "ee".repeat(64),
    });
    expect(listMultisigSigs("settle", "aa".repeat(32)).length).toBe(2);
    expect(listMultisigSigs("settle", "aa".repeat(32), "11".repeat(32)).length).toBe(1);
  });

  test("kinds are isolated", () => {
    makeMemDb();
    upsertMultisigSig({
      kind: "settle",
      key_hex: "aa".repeat(32),
      digest_hex: "bb".repeat(32),
      pubkey_hex: "cc".repeat(32),
      sig_hex: "dd".repeat(64),
    });
    upsertMultisigSig({
      kind: "expire",
      key_hex: "aa".repeat(32),
      digest_hex: "bb".repeat(32),
      pubkey_hex: "cc".repeat(32),
      sig_hex: "ee".repeat(64),
    });
    expect(listMultisigSigs("settle", "aa".repeat(32)).length).toBe(1);
    expect(listMultisigSigs("expire", "aa".repeat(32)).length).toBe(1);
  });

  test("cleanup removes stale rows", () => {
    const db = makeMemDb();
    upsertMultisigSig({
      kind: "settle",
      key_hex: "aa".repeat(32),
      digest_hex: "bb".repeat(32),
      pubkey_hex: "cc".repeat(32),
      sig_hex: "dd".repeat(64),
    });
    // Force created_at to be 25h old via direct UPDATE.
    db.prepare(
      `UPDATE multisig_sigs SET created_at = ? WHERE pubkey_hex = ?`,
    ).run(Math.floor(Date.now() / 1000) - 90000, "cc".repeat(32));
    expect(cleanupMultisigSigs(86400)).toBe(1);
    expect(listMultisigSigs("settle", "aa".repeat(32)).length).toBe(0);
  });
});

describe("isMultisigKind", () => {
  test("settle + expire + slash only", () => {
    expect(isMultisigKind("settle")).toBe(true);
    expect(isMultisigKind("expire")).toBe(true);
    // spec-225 / task #84-watcher: FRAU channel for the
    // slash_bad_settlement_evidence watcher path on cert-daemon.
    expect(isMultisigKind("slash")).toBe(true);
    expect(isMultisigKind("batch")).toBe(false);
    expect(isMultisigKind("")).toBe(false);
  });
});

describe("POST /v2/multisig_sigs/:kind/:key", () => {
  test("happy path: valid sig stored, GET returns it", async () => {
    const { app } = setupApp();
    const signer = makeSigner("11".repeat(32));
    const digest = new Uint8Array(32).fill(0x77);
    const digest_hex = u8aToHex(digest, undefined, false);
    const key_hex = "aa".repeat(32);
    const sig_hex = signer.sign(digest);

    const postRes = await callApp(app, "POST", `/v2/multisig_sigs/settle/${key_hex}`, {
      pubkey: signer.pubkey_hex,
      sig: sig_hex,
      digest: digest_hex,
    });
    expect(postRes.status).toBe(200);
    expect((postRes.body as { ok: boolean }).ok).toBe(true);

    const getRes = await callApp(app, "GET", `/v2/multisig_sigs/settle/${key_hex}`);
    expect(getRes.status).toBe(200);
    const body = getRes.body as { sigs: Array<{ pubkey: string; sig: string; digest: string }> };
    expect(body.sigs.length).toBe(1);
    expect(body.sigs[0].pubkey).toBe(signer.pubkey_hex);
    expect(body.sigs[0].digest).toBe(digest_hex);
  });

  test("rejects invalid sig with 401", async () => {
    const { app } = setupApp();
    const signer = makeSigner("11".repeat(32));
    const digest_hex = "77".repeat(32);
    const wrong_sig = "00".repeat(64);

    const postRes = await callApp(app, "POST", `/v2/multisig_sigs/settle/${"aa".repeat(32)}`, {
      pubkey: signer.pubkey_hex,
      sig: wrong_sig,
      digest: digest_hex,
    });
    expect(postRes.status).toBe(401);
  });

  test("rejects sig that verifies against a DIFFERENT digest with 401", async () => {
    // Attacker: substitutes claimed digest after producing a valid sig over
    // a different message. Verify-failure must catch this.
    const { app } = setupApp();
    const signer = makeSigner("11".repeat(32));
    const real_digest = new Uint8Array(32).fill(0x77);
    const fake_digest_hex = "88".repeat(32);
    const sig_hex = signer.sign(real_digest);

    const postRes = await callApp(app, "POST", `/v2/multisig_sigs/settle/${"aa".repeat(32)}`, {
      pubkey: signer.pubkey_hex,
      sig: sig_hex,
      digest: fake_digest_hex,
    });
    expect(postRes.status).toBe(401);
  });

  test("rejects unknown kind with 400", async () => {
    const { app } = setupApp();
    const signer = makeSigner("11".repeat(32));
    const digest = new Uint8Array(32).fill(0x77);
    const sig_hex = signer.sign(digest);
    const postRes = await callApp(app, "POST", `/v2/multisig_sigs/batch/${"aa".repeat(32)}`, {
      pubkey: signer.pubkey_hex,
      sig: sig_hex,
      digest: u8aToHex(digest, undefined, false),
    });
    expect(postRes.status).toBe(400);
  });

  test("idempotent re-POST returns same expires_at_unix", async () => {
    const { app } = setupApp();
    const signer = makeSigner("11".repeat(32));
    const digest = new Uint8Array(32).fill(0x77);
    const digest_hex = u8aToHex(digest, undefined, false);
    const key_hex = "aa".repeat(32);
    const sig_hex = signer.sign(digest);

    const r1 = await callApp(app, "POST", `/v2/multisig_sigs/settle/${key_hex}`, {
      pubkey: signer.pubkey_hex,
      sig: sig_hex,
      digest: digest_hex,
    });
    const r2 = await callApp(app, "POST", `/v2/multisig_sigs/settle/${key_hex}`, {
      pubkey: signer.pubkey_hex,
      sig: sig_hex,
      digest: digest_hex,
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((r1.body as { expires_at_unix: number }).expires_at_unix).toBe(
      (r2.body as { expires_at_unix: number }).expires_at_unix,
    );
  });

  test("M=2 aggregation: two distinct signers, both visible in GET", async () => {
    const { app } = setupApp();
    const a = makeSigner("11".repeat(32));
    const b = makeSigner("22".repeat(32));
    const digest = new Uint8Array(32).fill(0x33);
    const digest_hex = u8aToHex(digest, undefined, false);
    const key_hex = "ab".repeat(32);

    await callApp(app, "POST", `/v2/multisig_sigs/settle/${key_hex}`, {
      pubkey: a.pubkey_hex,
      sig: a.sign(digest),
      digest: digest_hex,
    });
    await callApp(app, "POST", `/v2/multisig_sigs/settle/${key_hex}`, {
      pubkey: b.pubkey_hex,
      sig: b.sign(digest),
      digest: digest_hex,
    });

    const getRes = await callApp(
      app,
      "GET",
      `/v2/multisig_sigs/settle/${key_hex}?digest=${digest_hex}`,
    );
    expect(getRes.status).toBe(200);
    const body = getRes.body as { sigs: Array<{ pubkey: string }>; count: number };
    expect(body.count).toBe(2);
    const pubkeys = new Set(body.sigs.map((s) => s.pubkey));
    expect(pubkeys.has(a.pubkey_hex)).toBe(true);
    expect(pubkeys.has(b.pubkey_hex)).toBe(true);
  });

  test("GET digest filter narrows to one match", async () => {
    const { app } = setupApp();
    const signer = makeSigner("11".repeat(32));
    const dA = new Uint8Array(32).fill(0xaa);
    const dB = new Uint8Array(32).fill(0xbb);
    const key_hex = "ab".repeat(32);

    await callApp(app, "POST", `/v2/multisig_sigs/settle/${key_hex}`, {
      pubkey: signer.pubkey_hex,
      sig: signer.sign(dA),
      digest: u8aToHex(dA, undefined, false),
    });
    await callApp(app, "POST", `/v2/multisig_sigs/settle/${key_hex}`, {
      pubkey: signer.pubkey_hex,
      sig: signer.sign(dB),
      digest: u8aToHex(dB, undefined, false),
    });

    const allRes = await callApp(app, "GET", `/v2/multisig_sigs/settle/${key_hex}`);
    expect((allRes.body as { count: number }).count).toBe(2);

    const filtered = await callApp(
      app,
      "GET",
      `/v2/multisig_sigs/settle/${key_hex}?digest=${u8aToHex(dA, undefined, false)}`,
    );
    expect((filtered.body as { count: number }).count).toBe(1);
  });

  test("GET rejects malformed digest query", async () => {
    const { app } = setupApp();
    const r = await callApp(
      app,
      "GET",
      `/v2/multisig_sigs/settle/${"aa".repeat(32)}?digest=notHex`,
    );
    expect(r.status).toBe(400);
  });
});
