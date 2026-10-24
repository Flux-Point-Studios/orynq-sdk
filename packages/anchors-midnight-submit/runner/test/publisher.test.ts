import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { certHash, decodeReceiptRecord } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { openCensusState } from "../census-state.js";
import { publishCensusPlan } from "../publisher.js";
import type { Census } from "../census.js";
import { openFollowerState } from "../follower-state.js";
import { followerPolicyDigest, type FollowerBlock } from "../follower-block.js";
import { openStandingSession } from "../standing-session.js";
import { openStandingDelivery } from "../standing-delivery.js";
import { openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { finalTransaction } from "../../src/submission.js";
import * as Submission from "../../src/submission.js";
import type { OperatorWallet } from "../../src/wallet.js";
import { batchAuthors, batchBytes, batchScope } from "./batch-fixture.js";

const fixture = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/checkpoint-receipts.json", import.meta.url), "utf8"));
const genesis = fixture.genesis as string, registry = batchScope.registry, receiptId = "ab".repeat(32);
const record = decodeReceiptRecord(Buffer.from(fixture.receipts[0].raw, "hex"));
record.availabilityCertHash = certHash({ format: "scale-v1", chainId: null }, genesis, receiptId, record);
const census: Census = { genesis, finalizedHash: "0x" + "bb".repeat(32), finalizedHeight: 100, entries: [{ receiptId, status: "certified", record }] };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let directory: string, state: ReturnType<typeof openCensusState>, servers: Server[], urls: string[], stored: Map<string, string>[], calls: string[];
let rejectSecond = false, corruptSecond = false, redirectSecond = false;
let holdMemberReads = false;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "orynq-publisher-"));
  state = openCensusState(join(directory, "census.sqlite"), { network: "preprod", genesis, registry }); state.prepare(census, 100n);
  servers = []; urls = []; stored = [new Map(), new Map()]; calls = []; rejectSecond = false; corruptSecond = false; redirectSecond = false;
  holdMemberReads = false;
  const waiting: (() => void)[] = [];
  for (let i = 0; i < 2; i++) {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8"), path = req.url!;
      calls.push(`${i}:${req.method}:${path}`);
      if (req.method === "PUT") {
        expect(req.headers["x-api-key"]).toBe(`fixture-writer-${i}`);
        if (i === 1 && rejectSecond) { res.writeHead(503).end(); return; }
        if (i === 1 && redirectSecond) { res.writeHead(307, { location: urls[0] + path }).end(); return; }
        const expected = path.split("/").at(-1)!; expect(sha(body)).toBe(expected);
        stored[i]!.set(path, body); res.writeHead(200).end("{}"); return;
      }
      expect(req.headers["x-api-key"]).toBeUndefined();
      if (i === 0 && holdMemberReads && path.includes("/members/")) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { res.writeHead(503).end(); resolve(); }, 750);
          waiting.push(() => { clearTimeout(timer); resolve(); });
          if (waiting.length === 2) { holdMemberReads = false; for (const release of waiting) release(); }
        });
        if (res.writableEnded) return;
      }
      const value = stored[i]!.get(path);
      if (value === undefined) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(i === 1 && corruptSecond ? value + " " : value);
    });
    server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); servers.push(server);
    urls.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }
});
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  state.close(); rmSync(directory, { recursive: true, force: true });
});
const options = () => ({ network: "preprod" as const, targets: urls.map((url, i) => ({ url, apiKey: `fixture-writer-${i}` })) });

it("publishes members before plans, reads exact bytes from both copies and only then acknowledges", async () => {
  await publishCensusPlan(state, options());
  expect(state.pendingObjects()).toEqual([]);
  for (let i = 0; i < 2; i++) {
    const puts = calls.filter(call => call.startsWith(`${i}:PUT`)); expect(puts).toHaveLength(2);
    expect(puts[0]).toContain("/members/"); expect(puts[1]).toContain("/plans/");
    expect(stored[i]!.size).toBe(2);
  }
});

it("does not acknowledge a one-copy success and retries unchanged bytes after restart", async () => {
  rejectSecond = true;
  await expect(publishCensusPlan(state, options())).rejects.toThrow(/publication|store/i);
  expect(state.pendingObjects()).toHaveLength(2);
  const original = state.pendingObjects(); state.close();
  state = openCensusState(join(directory, "census.sqlite"), { network: "preprod", genesis, registry });
  rejectSecond = false; await publishCensusPlan(state, options());
  expect(state.pendingObjects()).toEqual([]);
  for (const object of original) for (const copy of stored) expect([...copy.values()]).toContain(object.body);
});

it("rejects corrupt readback even after a successful PUT", async () => {
  corruptSecond = true;
  await expect(publishCensusPlan(state, options())).rejects.toThrow(/digest|readback/i);
  expect(state.pendingObjects()).toHaveLength(2);
});

it("freshly reads all objects after acknowledgements rather than trusting prior delivery", async () => {
  await publishCensusPlan(state, options()); calls.length = 0; corruptSecond = true;
  await expect(publishCensusPlan(state, options())).rejects.toThrow(/digest|readback/i);
  expect(calls.some(call => call.startsWith("1:GET"))).toBe(true);
});

it("refuses redirects before sending a writer credential to another origin", async () => {
  redirectSecond = true;
  await expect(publishCensusPlan(state, options())).rejects.toThrow(/publication|store|redirect/i);
  expect(state.pendingObjects()).toHaveLength(2);
});

it("rejects missing or duplicate copies, unsafe URLs and a different plan network before IO", async () => {
  const valid = options();
  for (const targets of [valid.targets.slice(0, 1), [valid.targets[0]!, valid.targets[0]!], [valid.targets[0]!, { url: "http://example.com", apiKey: "fixture" }], [valid.targets[0]!, { url: urls[1] + "?key=fixture", apiKey: "fixture" }]]) {
    await expect(publishCensusPlan(state, { ...valid, targets })).rejects.toThrow();
  }
  await expect(publishCensusPlan(state, { ...valid, network: "mainnet" })).rejects.toThrow(/network/i);
  expect(calls).toEqual([]);
});

it("mainnet refuses loopback storage and hostname aliases before network IO", async () => {
  state.close();
  state = openCensusState(join(directory, "mainnet.sqlite"), { network: "mainnet", genesis, registry }); state.prepare(census, 100n);
  await expect(publishCensusPlan(state, { ...options(), network: "mainnet" })).rejects.toThrow(/store|configuration|host/i);
  await expect(publishCensusPlan(state, { network: "mainnet", targets: [{ url: "https://proofs.example.com", apiKey: "fixture" }, { url: "https://proofs.example.com.", apiKey: "fixture" }] })).rejects.toThrow(/host|store/i);
  expect(calls).toEqual([]);
});

it("mainnet refuses literal IP and localhost DNS aliases during configuration validation", async () => {
  state.close();
  state = openCensusState(join(directory, "mainnet.sqlite"), { network: "mainnet", genesis, registry }); state.prepare(census, 100n);
  const original = getGlobalDispatcher(), mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
  try {
    for (const host of ["127.0.0.2", "[::ffff:127.0.0.1]", "proofs.localhost", "192.168.0.131"]) {
      await expect(publishCensusPlan(state, { network: "mainnet", targets: [{ url: `https://${host}`, apiKey: "fixture" }, { url: "https://independent.example.invalid", apiKey: "fixture" }] })).rejects.toThrow(/configuration/i);
    }
  } finally { setGlobalDispatcher(original); await mock.close(); }
});

it("reads bounded member groups concurrently and finishes every member before the plan", async () => {
  state.abandon(state.currentPlan()!.commitment);
  state.prepare({ ...census, finalizedHeight: 101, finalizedHash: "0x" + "cc".repeat(32), entries: Array.from({ length: 4097 }, (_, i) => {
    const id = i === 0 ? receiptId : sha(`parallel-receipt-${i}`), fields = { ...record };
    fields.availabilityCertHash = certHash({ format: "scale-v1", chainId: null }, genesis, id, fields);
    return { receiptId: id, status: "certified" as const, record: fields };
  }) }, 100n);
  holdMemberReads = true;
  const result = await publishCensusPlan(state, options());
  expect(result.objects).toBe(3); expect(state.pendingObjects()).toEqual([]);
  const firstPlan = calls.findIndex(call => call.includes("/plans/"));
  for (const call of calls.slice(firstPlan)) expect(call).not.toContain("/members/");
});

describe("standing delivery after retained publication", () => {
  const h = (height: number) => height.toString(16).padStart(64, "0"), minute = 60_000, start = 1_800_000_000_000;
  let follower: ReturnType<typeof openFollowerState>, journal: ReturnType<typeof openJournal>, session: ReturnType<typeof openStandingSession>;
  let delivery: ReturnType<typeof openStandingDelivery>, clock: { wallTime: number; monotonicMillis: number }, policy: ReturnType<typeof batchAuthors>, currentCensus: Census;
  let submit: ReturnType<typeof vi.fn<OperatorWallet["submit"]>>, save: ReturnType<typeof vi.fn<OperatorWallet["saveState"]>>;
  const block = (height: number, timestamp: number): FollowerBlock => ({ network: "preprod", policyDigest: followerPolicyDigest([]), block: { height, hash: h(height) }, parentHash: h(height - 1), timestamp, runtimeSpecVersion: 1000300, sends: [] });
  const bytes = () => batchBytes({ commitment: state.currentPlan()!.commitment, ttl: clock.wallTime + 10 * minute });
  beforeEach(() => {
    follower = openFollowerState(join(directory, "follower.sqlite"), { network: "preprod", genesis, registry, author: batchScope.author, policyDigest: followerPolicyDigest([]), runtimeSpecVersion: 1000300 });
    follower.recordVerifiedBlock(block(10, start - 24 * 60 * minute)); follower.recordVerifiedBlock(block(11, start));
    clock = { wallTime: start, monotonicMillis: 0 }; policy = batchAuthors(); currentCensus = census;
    session = openStandingSession({ state: follower, verifiedStart: block(11, start), authors: () => policy, clock: () => ({ ...clock }) });
    clock.wallTime += 20 * minute + 1000; clock.monotonicMillis += 20 * minute + 1000; follower.recordVerifiedBlock(block(12, clock.wallTime));
    journal = openJournal(join(directory, "attempts.sqlite")); submit = vi.fn<OperatorWallet["submit"]>(async () => {}); save = vi.fn<OperatorWallet["saveState"]>(async () => ({ saved: true as const }));
    delivery = openStandingDelivery({ wallet: { network: "preprod", addresses: { unshielded: "fixture-payer", shielded: "fixture-shielded", dust: "fixture-dust" }, submit, saveState: save }, follower, session, census: state, journal, readCensus: async () => currentCensus, publication: options(), clock: () => ({ ...clock }) });
  });
  afterEach(() => { journal?.close(); follower?.close(); vi.restoreAllMocks(); });

  it("hands copied exact bytes to the wallet only after fresh readbacks, certification and admission", async () => {
    const raw = await bytes(), exact = new Uint8Array(raw), commitment = state.currentPlan()!.commitment;
    const pending = delivery.submit(raw, commitment); raw.fill(0); const row = await pending;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(Buffer.from(submit.mock.calls[0]![0].serialize())).toEqual(Buffer.from(exact));
    expect(row.txHash).toBe(finalTransaction(exact).transactionHash()); expect(row.broadcasts).toBe(1);
    expect(row.ttl.getTime()).toBe(clock.wallTime + 10 * minute);
    expect(state.currentPlan()!.state).toBe("confirmed"); expect(save.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.filter(call => call.includes(":GET:")).length).toBeGreaterThanOrEqual(8);
    follower.assertAdmitted(exact);
  });

  it("refuses delivery when either copy or the fresh certificate is unavailable", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment; rejectSecond = true;
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/store|publication/i);
    expect(submit).not.toHaveBeenCalled(); expect(journal.pending()).toEqual([]);
    rejectSecond = false; currentCensus = { ...census, entries: [{ receiptId, status: "pending", reason: "missing" }] };
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/member|certif/i);
    expect(submit).not.toHaveBeenCalled();
  });

  it("requires fresh copies again when a previous journal call returned without sending", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment;
    const spy = vi.spyOn(journal, "submitOnce").mockResolvedValueOnce({ txHash: finalTransaction(raw).transactionHash(), state: "pending", broadcasts: 1, ttl: new Date(clock.wallTime + 10 * minute) });
    await delivery.submit(raw, commitment); spy.mockRestore(); expect(submit).not.toHaveBeenCalled();
    corruptSecond = true; await expect(delivery.submit(raw, commitment)).rejects.toThrow(/digest|readback/i);
    expect(submit).not.toHaveBeenCalled();
  });

  it("consumes a permit before an awaited guard so a second callback cannot send", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment;
    const spy = vi.spyOn(journal, "submitOnce").mockImplementation(async (_key, how) => {
      const results = await Promise.allSettled([how.broadcast(new Uint8Array(raw)), how.broadcast(new Uint8Array(raw))]);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      throw new Error("Both callbacks incorrectly delivered");
    });
    try { await expect(delivery.submit(raw, commitment)).rejects.toThrow(/permission|permit/i); } finally { spy.mockRestore(); }
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rechecks exact expiry after the final asynchronous reservation returns", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment, reserve = session.reserve.bind(session); let checks = 0;
    const spy = vi.spyOn(session, "reserve").mockImplementation(async (...args) => {
      const result = await reserve(...args);
      if (++checks === 3) { clock.wallTime += 11 * minute; clock.monotonicMillis += 11 * minute; }
      return result;
    });
    try { await expect(delivery.submit(raw, commitment)).rejects.toThrow(/expiry|expired|TTL|permit|stale/i); } finally { spy.mockRestore(); }
    expect(submit).not.toHaveBeenCalled();
  });

  it("latches a host-clock step after the final awaited reservation", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment, reserve = session.reserve.bind(session); let checks = 0;
    const spy = vi.spyOn(session, "reserve").mockImplementation(async (...args) => { const result = await reserve(...args); if (++checks === 3) clock.wallTime -= 2000; return result; });
    try { await expect(delivery.submit(raw, commitment)).rejects.toThrow(/clock|restart/i); } finally { spy.mockRestore(); }
    expect(submit).not.toHaveBeenCalled(); clock.wallTime += 2000;
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/restart/i);
  });

  it("observes a revocation delivered after the final asynchronous reservation", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment, reserve = session.reserve.bind(session); let checks = 0;
    const spy = vi.spyOn(session, "reserve").mockImplementation(async (...args) => { const result = await reserve(...args); if (++checks === 3) policy = batchAuthors({ role: "relay" }, 2); return result; });
    try { await expect(delivery.submit(raw, commitment)).rejects.toThrow(/author|policy/i); } finally { spy.mockRestore(); }
    expect(submit).not.toHaveBeenCalled();
  });

  it("holds new authenticated partial execution observed after the final await", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment, reserve = session.reserve.bind(session); let checks = 0;
    const spy = vi.spyOn(session, "reserve").mockImplementation(async (...args) => {
      const result = await reserve(...args);
      if (++checks === 3) follower.recordVerifiedBlock({ ...block(13, clock.wallTime), sends: [{ bytes: raw, txHash: finalTransaction(raw).transactionHash(), extrinsicIndex: 1, status: "PARTIAL_SUCCESS" }] });
      return result;
    });
    try { await expect(delivery.submit(raw, commitment)).rejects.toThrow(/head|claim|partial/i); } finally { spy.mockRestore(); }
    expect(submit).not.toHaveBeenCalled();
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/claim|partial/i);
  });

  it("checks head freshness again after synchronous reservation work", async () => {
    clock.wallTime += 100_000; clock.monotonicMillis += 100_000;
    const raw = await bytes(), commitment = state.currentPlan()!.commitment, reserve = follower.reserveStandingAttempt.bind(follower); let checks = 0;
    const spy = vi.spyOn(follower, "reserveStandingAttempt").mockImplementation((...args) => {
      const result = reserve(...args); if (++checks === 4) { clock.wallTime += 21_000; clock.monotonicMillis += 21_000; } return result;
    });
    try { await expect(delivery.submit(raw, commitment)).rejects.toThrow(/stale|fresh/i); } finally { spy.mockRestore(); }
    expect(submit).not.toHaveBeenCalled();
  });

  it("checks freshness after deserializing bytes for the final wallet handoff", async () => {
    clock.wallTime += 100_000; clock.monotonicMillis += 100_000;
    const raw = await bytes(), commitment = state.currentPlan()!.commitment, reserve = follower.reserveStandingAttempt.bind(follower), parse = Submission.finalTransaction;
    let checks = 0, insideReservation = false, delayed = false;
    vi.spyOn(follower, "reserveStandingAttempt").mockImplementation((...args) => {
      insideReservation = true;
      try { return reserve(...args); } finally { insideReservation = false; checks++; }
    });
    vi.spyOn(Submission, "finalTransaction").mockImplementation(value => {
      const result = parse(value);
      if (checks >= 3 && !insideReservation && !delayed) { delayed = true; clock.wallTime += 21_000; clock.monotonicMillis += 21_000; }
      return result;
    });
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/stale|fresh/i);
    expect(delayed).toBe(true); expect(submit).not.toHaveBeenCalled();
  });

  it("retains unknown delivery and only retries identical bytes after fresh prerequisites", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment; submit.mockRejectedValueOnce(new Error("fixture transport failure"));
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/transport/);
    expect(journal.pending()).toHaveLength(1); follower.assertAdmitted(raw);
    const before = calls.length; await delivery.submit(raw, commitment);
    expect(submit).toHaveBeenCalledTimes(2); expect(calls.length).toBeGreaterThan(before);
    expect(journal.pending()).toHaveLength(1); expect(follower.admissions()).toHaveLength(1);
  });

  it("never retries bytes explicitly refused and freed by the wallet", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment;
    submit.mockRejectedValueOnce(new Error('preprod node: author_submitExtrinsic failed: {"code":1002,"message":"fixture refusal"}'));
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/refusal/);
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/refus|freed|retry/i);
    expect(submit).toHaveBeenCalledTimes(1); expect(journal.pending()).toHaveLength(1);
  });

  it("latches failed wallet persistence before delivery", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment;
    save.mockResolvedValueOnce({ saved: false, failures: [{ part: "file", error: "fixture failure" }] });
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/save|persist|restart/i);
    await expect(delivery.submit(raw, commitment)).rejects.toThrow(/restart/i); expect(submit).not.toHaveBeenCalled();
  });

  it("holds unknown recovered journal rows before reconciliation can invent absence", async () => {
    const raw = await bytes(), commitment = state.currentPlan()!.commitment;
    await expect(journal.submitOnce({ ...batchScope, commitment, kind: 3, attribute: "00".repeat(32) }, { prepare: async () => ({ bytes: raw, ttl: new Date(clock.wallTime + 10 * minute) }), chain: follower.chainView(), broadcast: async () => { throw new Error("fixture unknown delivery"); } })).rejects.toThrow();
    await expect(delivery.reconcile()).rejects.toThrow(/unknown|provenance/i);
    expect(journal.pending()[0]!.state).toBe("pending"); expect(submit).not.toHaveBeenCalled();
  });
});
