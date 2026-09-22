// Drives the SHIPPED build (dist/index.js) against a real HTTP server on
// 127.0.0.1. Every assertion reads observable output only: requests the server
// received, receipts/<bundleId>.json and state/anchored.json. No decision logic
// from src/ is re-implemented here, so a regression in dist turns this red.
//
//   node packages/recorder-openclaw/test/envelope.probe.mjs
//
// RECORDER_DIST overrides which build is loaded.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = path.resolve(
  process.env.RECORDER_DIST ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js")
);
const { OpenClawRecorder, defaultConfig } = await import(pathToFileURL(DIST).href);
console.log(`build under test: ${DIST}`);

process.env.ORYNQ_PARTNER_KEY = "dummy-partner-key-not-a-secret";

const TX = "9f3bf30e".repeat(8);
const WORKER_FAILURE = {
  status: "ERROR",
  txHash: null,
  error: 'worker_call_failed: Worker returned error: {"success":false,"error":"insufficient funds"}',
  network: "mainnet",
  label: 2222
};

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  -> ${detail}`}`);
}

function reply(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close"
  });
  res.end(body);
}

async function startServer(handler) {
  const log = { posts: [], gets: [] };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const entry = { method: req.method, url: req.url, partner: req.headers["x-partner"], body: raw ? JSON.parse(raw) : null };
    (req.method === "POST" ? log.posts : log.gets).push(entry);
    handler(entry, req, res, log);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    log,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); })
  };
}

async function fixture(agents) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rec-envelope-"));
  const outDir = path.join(root, "out");
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  const lines = agents.map((agentId, i) =>
    JSON.stringify({ ts: `2026-02-03T10:00:0${i}Z`, agentId, type: "user", content: `hi from ${agentId}` })
  );
  await fs.writeFile(path.join(root, "sessions", "s1.jsonl"), lines.join("\n") + "\n");
  return { root, outDir };
}

function recorder(root, outDir, baseUrl) {
  return new OpenClawRecorder(defaultConfig({
    openclawRoot: root,
    outDir,
    anchor: { enabled: true, baseUrl, endpointPath: "/anchors/process-trace", partnerKeyEnv: "ORYNQ_PARTNER_KEY" },
    schedule: { scanEverySeconds: 10, anchorEveryMinutes: 60, jitterSeconds: 0 }
  }));
}

const readJson = async (...p) => JSON.parse(await fs.readFile(path.join(...p), "utf-8"));
const receiptOf = (outDir, id) => readJson(outDir, "receipts", `${id}.json`);
const stateOf = async (outDir) => readJson(outDir, "state", "anchored.json");

async function property(title, body) {
  console.log(`\n${title}`);
  const cleanups = [];
  try {
    await body(cleanups);
  } catch (err) {
    check("property ran to completion", false, err instanceof Error ? err.stack : String(err));
  } finally {
    for (const c of cleanups.reverse()) await c();
  }
}

const realNow = Date.now;

await property("P1 HTTP 200 wrapping an inner ERROR is a failure, not an anchor", async (cleanups) => {
  const srv = await startServer((e, req, res) => reply(res, 200, WORKER_FAILURE));
  cleanups.push(srv.close);
  const { root, outDir } = await fixture(["main"]);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const id = "2026-02-03__main";

  const rec = recorder(root, outDir, srv.baseUrl);
  await rec.scanOnce();
  await rec.anchorLatestBundles();

  const receipt = await receiptOf(outDir, id);
  const st = (await stateOf(outDir))[id];
  check("server received exactly one POST", srv.log.posts.length === 1, srv.log.posts.length);
  check("POST went to /anchors/process-trace with the partner header",
    srv.log.posts[0]?.url === "/anchors/process-trace" && !!srv.log.posts[0]?.partner, srv.log.posts[0]?.url);
  check("receipt.anchored === false", receipt.anchored === false, receipt.anchored);
  check("receipt.state === \"failed\"", receipt.state === "failed", receipt.state);
  check("receipt keeps httpStatus 200 and the worker error",
    receipt.httpStatus === 200 && String(receipt.response?.error).startsWith("worker_call_failed"),
    `${receipt.httpStatus} ${receipt.response?.error}`);
  check("anchored.json state === \"failed\"", st?.state === "failed", st?.state);
  check("anchored.json attempts === 1", st?.attempts === 1, st?.attempts);
  check("anchored.json lastReceipt.anchored === false", st?.lastReceipt?.anchored === false, st?.lastReceipt?.anchored);
});

await property("P2 SUBMITTED with a txHash is submitted, not anchored, and keeps its requestId", async (cleanups) => {
  const srv = await startServer((e, req, res) =>
    reply(res, 200, { requestId: "r1", status: "SUBMITTED", txHash: TX, confirmations: 0 }));
  cleanups.push(srv.close);
  const { root, outDir } = await fixture(["main"]);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const id = "2026-02-03__main";

  const rec = recorder(root, outDir, srv.baseUrl);
  await rec.scanOnce();
  await rec.anchorLatestBundles();

  const receipt = await receiptOf(outDir, id);
  const st = (await stateOf(outDir))[id];
  check("server received exactly one POST", srv.log.posts.length === 1, srv.log.posts.length);
  check("receipt.state === \"submitted\"", receipt.state === "submitted", receipt.state);
  check("receipt.anchored === false despite a txHash", receipt.anchored === false, receipt.anchored);
  check("receipt.txHash is the server's hash", receipt.txHash === TX, receipt.txHash);
  check("anchored.json state === \"submitted\"", st?.state === "submitted", st?.state);
  check("anchored.json requestId === \"r1\"", st?.requestId === "r1", st?.requestId);

  await rec.anchorLatestBundles();
  check("next cycle makes no new POST", srv.log.posts.length === 1, srv.log.posts.length);
  check("next cycle polls GET /anchors/status/r1 with the persisted requestId",
    srv.log.gets.length === 1 && srv.log.gets[0].url === "/anchors/status/r1",
    JSON.stringify(srv.log.gets.map((g) => g.url)));
});

await property("P3 an unknown status carrying a txHash is NOT anchored", async (cleanups) => {
  const body = { requestId: "r3", status: "QUEUED_FOR_REVIEW", txHash: TX, confirmations: 0 };
  const srv = await startServer((e, req, res) => reply(res, 200, body));
  cleanups.push(srv.close);
  const { root, outDir } = await fixture(["main"]);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const id = "2026-02-03__main";

  const rec = recorder(root, outDir, srv.baseUrl);
  await rec.scanOnce();
  await rec.anchorLatestBundles();

  const receipt = await receiptOf(outDir, id);
  const st = (await stateOf(outDir))[id];
  check("receipt.anchored === false", receipt.anchored === false, receipt.anchored);
  check("receipt.state is not \"anchored\"", receipt.state !== "anchored", receipt.state);
  check("anchored.json state is not \"anchored\"", st?.state !== "anchored", st?.state);

  await rec.anchorLatestBundles();
  check("next cycle is not skipped as done: it polls status for r3",
    srv.log.gets.some((g) => g.url === "/anchors/status/r3"),
    JSON.stringify(srv.log.gets.map((g) => g.url)));
});

await property("P4 a failed bundle backs off: no POST 30s later, a POST 3h later", async (cleanups) => {
  let now = Date.parse("2026-09-22T00:00:00Z");
  Date.now = () => now;
  cleanups.push(async () => { Date.now = realNow; });
  const srv = await startServer((e, req, res) => reply(res, 200, WORKER_FAILURE));
  cleanups.push(srv.close);
  const { root, outDir } = await fixture(["main"]);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const id = "2026-02-03__main";

  const rec = recorder(root, outDir, srv.baseUrl);
  await rec.scanOnce();
  const t0 = now;
  await rec.anchorLatestBundles();
  const first = (await stateOf(outDir))[id];
  check("t0: one POST, recorded failed with attempts 1",
    srv.log.posts.length === 1 && first?.state === "failed" && first?.attempts === 1,
    `posts=${srv.log.posts.length} state=${first?.state} attempts=${first?.attempts}`);

  now = t0 + 30_000;
  await rec.anchorLatestBundles();
  const held = (await stateOf(outDir))[id];
  check("t0+30s: NO new POST", srv.log.posts.length === 1, `posts=${srv.log.posts.length}`);
  check("t0+30s: state untouched (attempts 1, lastAttemptAt t0)",
    held?.attempts === 1 && held?.lastAttemptAt === t0,
    `attempts=${held?.attempts} lastAttemptAt=${held?.lastAttemptAt} t0=${t0}`);

  now = t0 + 3 * 60 * 60_000;
  await rec.anchorLatestBundles();
  const retried = (await stateOf(outDir))[id];
  check("t0+3h: exactly one new POST", srv.log.posts.length === 2, `posts=${srv.log.posts.length}`);
  check("t0+3h: attempts 2, lastAttemptAt t0+3h",
    retried?.attempts === 2 && retried?.lastAttemptAt === now,
    `attempts=${retried?.attempts} lastAttemptAt=${retried?.lastAttemptAt}`);

  now += 30_000;
  await rec.anchorLatestBundles();
  check("t0+3h+30s: NO new POST after the second failure", srv.log.posts.length === 2, `posts=${srv.log.posts.length}`);
});

await property("P5 a POST that throws fails its own bundle only; the cycle completes", async (cleanups) => {
  const srv = await startServer((e, req, res, log) => {
    if (log.posts.length === 1) return req.socket.destroy();
    reply(res, 200, { requestId: "r5", status: "SUBMITTED", txHash: TX, confirmations: 0 });
  });
  cleanups.push(srv.close);
  const { root, outDir } = await fixture(["alpha", "beta"]);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

  const rec = recorder(root, outDir, srv.baseUrl);
  await rec.scanOnce();
  let threw = null;
  try {
    await rec.anchorLatestBundles();
  } catch (err) {
    threw = err;
  }
  check("anchorLatestBundles resolved (did not throw)", threw === null, threw?.message);

  const agents = srv.log.posts.map((p) => String(p.body?.manifest?.agentId).replace(/^openclaw:/, ""));
  check("server received a POST for each bundle", srv.log.posts.length === 2 && new Set(agents).size === 2,
    `posts=${srv.log.posts.length} agents=${JSON.stringify(agents)}`);

  const [firstAgent, secondAgent] = agents;
  const failedId = `2026-02-03__${firstAgent}`;
  const okId = `2026-02-03__${secondAgent}`;
  const state = await stateOf(outDir).catch(() => ({}));
  const f = state[failedId];
  check(`first-POSTed bundle ${failedId} recorded failed, attempts 1, with an error`,
    f?.state === "failed" && f?.attempts === 1 && typeof f?.lastReceipt?.error === "string" && f.lastReceipt.error.length > 0,
    `state=${f?.state} attempts=${f?.attempts} error=${f?.lastReceipt?.error}`);
  const fr = await receiptOf(outDir, failedId).catch(() => null);
  check(`receipt for ${failedId} is anchored=false state=failed with the error`,
    fr?.anchored === false && fr?.state === "failed" && typeof fr?.error === "string",
    fr ? `anchored=${fr.anchored} state=${fr.state} error=${fr.error}` : "no receipt");
  const s = state[okId];
  check(`second bundle ${okId} still POSTed and recorded submitted with requestId r5`,
    s?.state === "submitted" && s?.requestId === "r5",
    `state=${s?.state} requestId=${s?.requestId}`);
});

await property("P6 an explicit ERROR outranks a stale txHash: failed, never submitted", async (cleanups) => {
  const srv = await startServer((e, req, res) =>
    reply(res, 200, { requestId: "r6", status: "ERROR", txHash: TX, error: "All inputs are spent" }));
  cleanups.push(srv.close);
  const { root, outDir } = await fixture(["main"]);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const id = "2026-02-03__main";

  const rec = recorder(root, outDir, srv.baseUrl);
  await rec.scanOnce();
  await rec.anchorLatestBundles();

  const receipt = await receiptOf(outDir, id);
  const st = (await stateOf(outDir))[id];
  check("receipt.state === \"failed\" despite the txHash", receipt.state === "failed", receipt.state);
  check("receipt.anchored === false", receipt.anchored === false, receipt.anchored);
  check("anchored.json state === \"failed\", not \"submitted\"", st?.state === "failed", st?.state);

  await rec.anchorLatestBundles();
  check("next cycle does not poll the rejected transaction's requestId",
    srv.log.gets.length === 0, JSON.stringify(srv.log.gets.map((g) => g.url)));
});

await property("P7 an HTTP error is a failure even when its body claims CONFIRMED", async (cleanups) => {
  const srv = await startServer((e, req, res) =>
    reply(res, 500, { requestId: "r7", status: "CONFIRMED", txHash: TX, confirmations: 3 }));
  cleanups.push(srv.close);
  const { root, outDir } = await fixture(["main"]);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const id = "2026-02-03__main";

  const rec = recorder(root, outDir, srv.baseUrl);
  await rec.scanOnce();
  await rec.anchorLatestBundles();

  const receipt = await receiptOf(outDir, id);
  const st = (await stateOf(outDir))[id];
  check("receipt.anchored === false on HTTP 500", receipt.anchored === false, receipt.anchored);
  check("receipt.state === \"failed\"", receipt.state === "failed", receipt.state);
  check("anchored.json state === \"failed\"", st?.state === "failed", st?.state);
});

// The retry schedule is pinned exactly. Math.random is the recorder's only
// source of jitter; fixing it makes each backoff boundary deterministic, and
// every check straddles a boundary so a changed formula moves a POST across it.
async function bundleAnswering(cleanups, { body = WORKER_FAILURE, random = 0.5 } = {}) {
  let now = Date.parse("2026-09-22T00:00:00Z");
  const clock = { get: () => now, set: (v) => { now = v; } };
  Date.now = () => now;
  const realRandom = Math.random;
  Math.random = () => random;
  cleanups.push(async () => { Date.now = realNow; Math.random = realRandom; });
  const srv = await startServer((e, req, res) => reply(res, 200, body));
  cleanups.push(srv.close);
  const { root, outDir } = await fixture(["main"]);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const rec = recorder(root, outDir, srv.baseUrl);
  await rec.scanOnce();
  await rec.anchorLatestBundles();
  return { clock, srv, rec, outDir, id: "2026-02-03__main" };
}

const MIN = 60_000;

await property("P8 backoff doubles per attempt: 2 min after attempt 1, 4 min after attempt 2", async (cleanups) => {
  const { clock, srv, rec, outDir, id } = await bundleAnswering(cleanups); // jitter x1.0
  const t0 = clock.get();
  check("t0: attempt 1 recorded", (await stateOf(outDir))[id]?.attempts === 1);

  clock.set(t0 + 2 * MIN - 10_000);
  await rec.anchorLatestBundles();
  check("t0+1m50s: NO POST (a flat 1-minute backoff would have posted)", srv.log.posts.length === 1, `posts=${srv.log.posts.length}`);

  clock.set(t0 + 2 * MIN + 1_000);
  await rec.anchorLatestBundles();
  check("t0+2m01s: attempt 2 POSTed", srv.log.posts.length === 2, `posts=${srv.log.posts.length}`);
  const t1 = clock.get();

  clock.set(t1 + 4 * MIN - 10_000);
  await rec.anchorLatestBundles();
  check("t1+3m50s: NO POST (the backoff doubled)", srv.log.posts.length === 2, `posts=${srv.log.posts.length}`);

  clock.set(t1 + 4 * MIN + 1_000);
  await rec.anchorLatestBundles();
  check("t1+4m01s: attempt 3 POSTed", srv.log.posts.length === 3, `posts=${srv.log.posts.length}`);
  check("anchored.json attempts === 3", (await stateOf(outDir))[id]?.attempts === 3, (await stateOf(outDir))[id]?.attempts);
});

await property("P9 the 24h cap binds: a bundle on attempt 20 retries after one day, not eleven", async (cleanups) => {
  const { clock, srv, rec, outDir, id } = await bundleAnswering(cleanups);
  const statePath = path.join(outDir, "state", "anchored.json");
  const st = await stateOf(outDir);
  st[id] = { ...st[id], attempts: 20 };
  await fs.writeFile(statePath, JSON.stringify(st, null, 2));
  const t0 = st[id].lastAttemptAt;

  clock.set(t0 + 24 * 60 * MIN - MIN);
  await rec.anchorLatestBundles();
  check("t0+23h59m: NO POST", srv.log.posts.length === 1, `posts=${srv.log.posts.length}`);

  clock.set(t0 + 24 * 60 * MIN + 1_000);
  await rec.anchorLatestBundles();
  check("t0+24h: POSTed (uncapped doubling would wait 2^14 min = 11.4 days)", srv.log.posts.length === 2, `posts=${srv.log.posts.length}`);
});

await property("P10 the lower jitter bound (x0.8) lets the retry through early", async (cleanups) => {
  const low = await bundleAnswering(cleanups, { random: 0 }); // jitter x0.8: 2 min -> 96s
  const tl = low.clock.get();
  low.clock.set(tl + 100_000);
  await low.rec.anchorLatestBundles();
  check("jitter x0.8: attempt 2 POSTed at t0+100s (unjittered 120s would not)", low.srv.log.posts.length === 2, `posts=${low.srv.log.posts.length}`);
});

await property("P11 the upper jitter bound (x1.2) holds the retry back", async (cleanups) => {
  const high = await bundleAnswering(cleanups, { random: 0.9999 }); // jitter ~x1.2: 2 min -> ~144s
  const th = high.clock.get();
  high.clock.set(th + 130_000);
  await high.rec.anchorLatestBundles();
  check("jitter x1.2: NO POST at t0+130s (unjittered 120s would have posted)", high.srv.log.posts.length === 1, `posts=${high.srv.log.posts.length}`);
  high.clock.set(th + 145_000);
  await high.rec.anchorLatestBundles();
  check("jitter x1.2: attempt 2 POSTed at t0+145s", high.srv.log.posts.length === 2, `posts=${high.srv.log.posts.length}`);
});

// t-backend answers the POST from its DB row, which is PENDING with no txHash
// until the worker's best-effort submitted-callback lands. When that callback
// fails the worker has ALREADY put the tx on chain, so a re-post is a duplicate
// anchor. A requestId proves the server accepted the request: poll it.
await property("P12 PENDING with a requestId and no txHash is submitted and polled, never re-posted", async (cleanups) => {
  let now = Date.parse("2026-09-22T00:00:00Z");
  Date.now = () => now;
  cleanups.push(async () => { Date.now = realNow; });
  let landed = false;
  const srv = await startServer((e, req, res) => {
    if (e.method === "POST") return reply(res, 200, { requestId: "r12", status: "PENDING", txHash: null });
    reply(res, 200, landed
      ? { requestId: "r12", status: "CONFIRMED", txHash: TX, confirmations: 1 }
      : { requestId: "r12", status: "PENDING", txHash: null, confirmations: 0 });
  });
  cleanups.push(srv.close);
  const { root, outDir } = await fixture(["main"]);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const id = "2026-02-03__main";

  const rec = recorder(root, outDir, srv.baseUrl);
  await rec.scanOnce();
  await rec.anchorLatestBundles();
  const st = (await stateOf(outDir))[id];
  const receipt = await receiptOf(outDir, id);
  check("anchored.json state === \"submitted\" with requestId r12",
    st?.state === "submitted" && st?.requestId === "r12", `state=${st?.state} requestId=${st?.requestId}`);
  check("receipt is submitted, not anchored", receipt.state === "submitted" && receipt.anchored === false,
    `receipt.state=${receipt.state} anchored=${receipt.anchored}`);

  for (let h = 1; h < 24; h++) {
    now += 60 * 60_000;
    await rec.anchorLatestBundles();
  }
  check("24 hourly cycles: exactly one POST", srv.log.posts.length === 1, `posts=${srv.log.posts.length}`);
  check("cycles 2..24 each polled /anchors/status/r12",
    srv.log.gets.length === 23 && srv.log.gets.every((g) => g.url === "/anchors/status/r12"),
    `gets=${srv.log.gets.length} urls=${[...new Set(srv.log.gets.map((g) => g.url))].join(",")}`);

  landed = true;
  now += 60 * 60_000;
  await rec.anchorLatestBundles();
  const done = await receiptOf(outDir, id);
  check("once the poll confirms, the receipt reads anchored with the txHash the POST never had",
    done.anchored === true && done.state === "anchored" && done.txHash === TX,
    `receipt.anchored=${done.anchored} state=${done.state} txHash=${String(done.txHash).slice(0, 8)}`);
  check("and still only one POST", srv.log.posts.length === 1, `posts=${srv.log.posts.length}`);
});

// Without a requestId there is nothing to poll, so "submitted" would fall
// through to a fresh POST on every cycle, with no log line. The bundle must be
// a failure instead: counted, logged, and retried only on its backoff.
await property("P13 a SUBMITTED reply with no requestId is a failure on backoff, not a silent per-cycle re-post", async (cleanups) => {
  const { clock, srv, rec, outDir, id } = await bundleAnswering(cleanups,
    { body: { status: "SUBMITTED", txHash: TX, confirmations: 0 } });
  const st = (await stateOf(outDir))[id];
  check("anchored.json state === \"failed\" (nothing to poll), attempts 1",
    st?.state === "failed" && st?.attempts === 1, `state=${st?.state} attempts=${st?.attempts} requestId=${st?.requestId}`);

  clock.set(clock.get() + MIN);
  await rec.anchorLatestBundles();
  check("one minute later, inside the backoff: NO new POST", srv.log.posts.length === 1, `posts=${srv.log.posts.length}`);
});

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
