// Resilience probes against the SHIPPED build (dist/index.js), not a copy of
// its logic: timeouts on both network calls (headers and body), the persisted
// anchor schedule and its clamp, the dedup digest's coverage of sessionId, and
// isolation of a torn spool line and of any other one-bundle failure.
//
// Every observation comes from outside the recorder: requests a real
// 127.0.0.1 server received, and the receipt / state files the recorder wrote.
//
//   node test/resilience.probe.mjs          run every case, exit 0 on pass
//   node test/resilience.probe.mjs P1       run one case
//
// Each case runs in its own child process: runForever() never returns, so the
// schedule cases can only be stopped with process.exit, and the setTimeout
// override must not leak between cases. Workspaces live under a per-case
// directory the parent owns and removes, so a crashed child leaks nothing.
//
// Timer shortening (P1, P2, P6, P7): setTimeout calls made from inside
// dist/index.js with a delay >= 30000 ms are cut to 200 ms. Every other timer,
// including undici's own, runs at real speed. The original delays are recorded
// so the probe also shows which shipped timeout was armed.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const DIST_URL = pathToFileURL(DIST).href;
const BUNDLE = "2026-02-03__main";
const TX = "ab".repeat(32);
const DEADLINE_MS = 10_000;
const WINDOW_MS = 10_000;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  (${detail})`}`);
  return ok;
}

function finish() {
  process.exit(failures === 0 ? 0 : 1);
}

async function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const entry = { method: req.method, url: req.url, at: Date.now(), body: "" };
    requests.push(entry);
    req.setEncoding("utf-8");
    req.on("data", (c) => { entry.body += c; });
    req.on("end", () => handler(entry, res));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    posts: () => requests.filter((r) => r.method === "POST"),
    gets: () => requests.filter((r) => r.method === "GET")
  };
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const neverAnswer = () => {};

async function workspace(lines) {
  const root = await fs.mkdtemp(path.join(process.env.RESILIENCE_TMP ?? os.tmpdir(), "ws-"));
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(root, "sessions", "s1.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
  const outDir = path.join(root, "out");
  await fs.mkdir(path.join(outDir, "state"), { recursive: true });
  return { root, outDir };
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf-8")); } catch { return undefined; }
}

const statePath = (outDir) => path.join(outDir, "state", "anchored.json");
const receiptPath = (outDir) => path.join(outDir, "receipts", `${BUNDLE}.json`);
const schedulePath = (outDir) => path.join(outDir, "state", "schedule.json");

async function recorderFor(root, outDir, baseUrl, schedule) {
  const { OpenClawRecorder, defaultConfig } = await import(DIST_URL);
  process.env.ORYNQ_PARTNER_KEY = "dummy-not-a-secret";
  const cfg = defaultConfig({
    openclawRoot: root,
    outDir,
    anchor: { enabled: true, baseUrl },
    schedule: schedule ?? { scanEverySeconds: 1, anchorEveryMinutes: 1440, jitterSeconds: 0 }
  });
  return new OpenClawRecorder(cfg);
}

const line = (extra = {}) => ({
  ts: "2026-02-03T10:00:00Z", agentId: "main", type: "user", content: "hi", ...extra
});

// Races a promise against a real timer; never rejects.
async function withDeadline(promise, ms) {
  let timer;
  const expired = new Promise((r) => { timer = setTimeout(() => r({ done: false }), ms); });
  const settled = promise.then(
    (value) => ({ done: true, value }),
    (error) => ({ done: true, error })
  );
  const out = await Promise.race([settled, expired]);
  clearTimeout(timer);
  return out;
}

async function waitFor(predicate, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !!(await predicate());
}

function shortenDistTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const shortened = [];
  globalThis.setTimeout = function (fn, ms, ...args) {
    const stack = new Error().stack ?? "";
    if (typeof ms === "number" && ms >= 30_000 && (stack.includes(DIST_URL) || stack.includes(DIST))) {
      shortened.push(ms);
      ms = 200;
    }
    return realSetTimeout.call(this, fn, ms, ...args);
  };
  return shortened;
}

const CASES = {
  // P1: the anchor POST reaches a server that never answers.
  async P1() {
    const srv = await startServer(neverAnswer);
    const { root, outDir } = await workspace([line()]);
    const rec = await recorderFor(root, outDir, srv.url);
    await rec.scanOnce();

    const shortened = shortenDistTimers();
    const t0 = Date.now();
    const r = await withDeadline(rec.anchorLatestBundles(), DEADLINE_MS);
    const elapsed = Date.now() - t0;

    check("P1 anchorLatestBundles completes although the POST is never answered",
      r.done && !r.error, r.done ? `returned after ${elapsed}ms${r.error ? `, threw ${r.error.message}` : ""}` : `still hanging after ${DEADLINE_MS}ms`);
    check("P1 the POST reached the server (the hang is server-side)",
      srv.posts().length === 1, `POSTs=${srv.posts().length}`);
    check("P1 the shipped 60s POST timeout was armed (completion above proves it is wired)",
      shortened.includes(60_000), `dist timers shortened: [${shortened.join(", ")}]`);
    if (!r.done) return;

    const st = (await readJson(statePath(outDir)))?.[BUNDLE];
    const receipt = await readJson(receiptPath(outDir));
    check("P1 anchored.json records the bundle failed",
      st?.state === "failed", `state=${st?.state}`);
    check("P1 the failure counts as attempt 1",
      st?.attempts === 1, `attempts=${st?.attempts}`);
    check("P1 receipt is failed and not anchored",
      receipt?.state === "failed" && receipt?.anchored === false,
      `receipt.state=${receipt?.state} anchored=${receipt?.anchored}`);
    check("P1 receipt error is the abort",
      /abort/i.test(String(receipt?.error)), `receipt.error=${JSON.stringify(receipt?.error)}`);
  },

  // P2: a submitted bundle is polled and the status GET never answers.
  async P2() {
    const srv = await startServer((req, res) => {
      if (req.method === "POST") {
        reply(res, 200, { requestId: "req-p2", status: "SUBMITTED", txHash: TX, confirmations: 0 });
      }
      // GET /anchors/status/*: never answer.
    });
    const { root, outDir } = await workspace([line()]);
    const rec = await recorderFor(root, outDir, srv.url);
    await rec.scanOnce();

    await rec.anchorLatestBundles();
    const before = await fs.readFile(statePath(outDir), "utf-8");
    const st0 = JSON.parse(before)[BUNDLE];
    check("P2 setup: first cycle leaves the bundle submitted with a requestId",
      st0?.state === "submitted" && st0?.requestId === "req-p2",
      `state=${st0?.state} requestId=${st0?.requestId}`);

    const shortened = shortenDistTimers();
    const t0 = Date.now();
    const r = await withDeadline(rec.anchorLatestBundles(), DEADLINE_MS);
    const elapsed = Date.now() - t0;

    check("P2 anchorLatestBundles completes although the status GET is never answered",
      r.done && !r.error, r.done ? `returned after ${elapsed}ms${r.error ? `, threw ${r.error.message}` : ""}` : `still hanging after ${DEADLINE_MS}ms`);
    check("P2 the status GET for the recorded requestId reached the server",
      srv.gets().length === 1 && srv.gets()[0].url === "/anchors/status/req-p2",
      `GETs=${srv.gets().map((g) => g.url).join(",") || "none"}`);
    check("P2 the shipped 30s status timeout was armed (completion above proves it is wired)",
      shortened.includes(30_000), `dist timers shortened: [${shortened.join(", ")}]`);
    check("P2 no re-post: POST count unchanged",
      srv.posts().length === 1, `POSTs=${srv.posts().length}`);
    if (!r.done) return;

    const after = await fs.readFile(statePath(outDir), "utf-8");
    const st1 = JSON.parse(after)[BUNDLE];
    check("P2 bundle stays submitted with the same requestId",
      st1?.state === "submitted" && st1?.requestId === "req-p2",
      `state=${st1?.state} requestId=${st1?.requestId}`);
    check("P2 anchored.json untouched by the failed poll",
      after === before, after === before ? "byte-identical" : "changed");
  },

  // P3: a saved schedule already due fires on the first loop iteration, even
  // though anchorEveryMinutes (24h) would otherwise keep the window silent.
  async P3() {
    const srv = await startServer((req, res) =>
      reply(res, 200, { requestId: "req-p3", status: "CONFIRMED", txHash: TX, confirmations: 1 }));
    const { root, outDir } = await workspace([line()]);
    await fs.writeFile(schedulePath(outDir), JSON.stringify({ nextAnchorAt: Date.now() - 1000 }));
    const rec = await recorderFor(root, outDir, srv.url,
      { scanEverySeconds: 1, anchorEveryMinutes: 1440, jitterSeconds: 0 });

    const t0 = Date.now();
    rec.runForever().catch((e) => { check("P3 runForever does not throw", false, e.message); finish(); });
    const arrived = await waitFor(() => srv.posts().length >= 1, WINDOW_MS);
    check("P3 the saved, already-due schedule is honoured: a POST arrives within the window",
      arrived, arrived ? `first POST after ${srv.posts()[0].at - t0}ms` : `no POST in ${WINDOW_MS}ms`);
    if (!arrived) return;

    const interval = 1440 * 60_000;
    const rescheduled = await waitFor(async () =>
      ((await readJson(schedulePath(outDir)))?.nextAnchorAt ?? 0) > t0 + 60_000, 3000);
    const next = (await readJson(schedulePath(outDir)))?.nextAnchorAt;
    check("P3 after the anchor the persisted schedule moves one interval ahead",
      rescheduled && Math.abs(next - (Date.now() + interval)) < 10_000,
      `nextAnchorAt - now = ${next - Date.now()}ms, interval=${interval}ms`);
    check("P3 exactly one POST in the window",
      srv.posts().length === 1, `POSTs=${srv.posts().length}`);
  },

  // Control for P3: with no saved schedule the same config posts nothing in
  // the same window, so P3's POST is caused by the saved schedule alone.
  async "P3-control"() {
    const srv = await startServer((req, res) =>
      reply(res, 200, { requestId: "req-p3c", status: "CONFIRMED", txHash: TX, confirmations: 1 }));
    const { root, outDir } = await workspace([line()]);
    const rec = await recorderFor(root, outDir, srv.url,
      { scanEverySeconds: 1, anchorEveryMinutes: 1440, jitterSeconds: 0 });

    const t0 = Date.now();
    rec.runForever().catch((e) => { check("P3-control runForever does not throw", false, e.message); finish(); });
    const arrived = await waitFor(() => srv.posts().length >= 1, WINDOW_MS);
    check("P3-control with no saved schedule, no POST in the same window",
      !arrived, `POSTs=${srv.posts().length}`);
    const next = (await readJson(schedulePath(outDir)))?.nextAnchorAt;
    check("P3-control a fresh schedule one interval ahead is persisted",
      typeof next === "number" && Math.abs(next - (t0 + 1440 * 60_000)) < 10_000,
      `nextAnchorAt - start = ${next - t0}ms`);
  },

  // P4: a saved schedule a year out is clamped to one interval (3s).
  async P4() {
    const srv = await startServer((req, res) =>
      reply(res, 200, { requestId: "req-p4", status: "CONFIRMED", txHash: TX, confirmations: 1 }));
    const { root, outDir } = await workspace([line()]);
    const year = 365 * 24 * 60 * 60_000;
    await fs.writeFile(schedulePath(outDir), JSON.stringify({ nextAnchorAt: Date.now() + year }));
    const rec = await recorderFor(root, outDir, srv.url,
      { scanEverySeconds: 1, anchorEveryMinutes: 0.05, jitterSeconds: 0 });

    const t0 = Date.now();
    rec.runForever().catch((e) => { check("P4 runForever does not throw", false, e.message); finish(); });
    const arrived = await waitFor(() => srv.posts().length >= 1, 2 * WINDOW_MS);
    const after = arrived ? srv.posts()[0].at - t0 : undefined;
    check("P4 a year-out saved schedule is clamped: a POST arrives within two windows",
      arrived, arrived ? `first POST after ${after}ms` : `no POST in ${2 * WINDOW_MS}ms`);
    if (!arrived) return;
    check("P4 the clamp is one interval, not zero: the POST waits ~3s",
      after >= 2500, `first POST after ${after}ms, interval=3000ms`);

    const rescheduled = await waitFor(async () =>
      ((await readJson(schedulePath(outDir)))?.nextAnchorAt ?? Infinity) < Date.now() + 2 * 3000, 3000);
    const next = (await readJson(schedulePath(outDir)))?.nextAnchorAt;
    check("P4 the year-out value is gone from schedule.json after the anchor",
      rescheduled, `nextAnchorAt - now = ${next - Date.now()}ms`);
  },

  // P6: the POST's headers arrive, then the body stalls. The anchor timeout
  // must cover reading the body too, or one dead connection holds the whole
  // cycle until undici's own 300s body timeout.
  async P6() {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"requestId":"req-p6","status":"SUB');
    });
    const { root, outDir } = await workspace([line()]);
    const rec = await recorderFor(root, outDir, srv.url);
    await rec.scanOnce();

    const shortened = shortenDistTimers();
    const t0 = Date.now();
    const r = await withDeadline(rec.anchorLatestBundles(), DEADLINE_MS);
    check("P6 anchorLatestBundles completes although the POST body never finishes",
      r.done && !r.error, r.done ? `returned after ${Date.now() - t0}ms` : `still hanging after ${DEADLINE_MS}ms`);
    check("P6 the shipped 60s POST timeout was armed", shortened.includes(60_000), `dist timers shortened: [${shortened.join(", ")}]`);
    if (!r.done) return;
    const st = (await readJson(statePath(outDir)))?.[BUNDLE];
    check("P6 the stalled POST is recorded failed", st?.state === "failed" && st?.attempts === 1,
      `state=${st?.state} attempts=${st?.attempts}`);
  },

  // P7: the POST body trickles one byte a second, which resets undici's idle
  // body timer forever. Only the recorder's own deadline can end it.
  async P7() {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"requestId":"req-p7","status":"SUBMITTED"');
      const drip = setInterval(() => res.write(" "), 1000);
      res.on("close", () => clearInterval(drip));
    });
    const { root, outDir } = await workspace([line()]);
    const rec = await recorderFor(root, outDir, srv.url);
    await rec.scanOnce();

    shortenDistTimers();
    const t0 = Date.now();
    const r = await withDeadline(rec.anchorLatestBundles(), DEADLINE_MS);
    check("P7 anchorLatestBundles completes although the POST body trickles forever",
      r.done && !r.error, r.done ? `returned after ${Date.now() - t0}ms` : `still hanging after ${DEADLINE_MS}ms`);
    if (!r.done) return;
    const st = (await readJson(statePath(outDir)))?.[BUNDLE];
    check("P7 the trickling POST is recorded failed", st?.state === "failed", `state=${st?.state}`);
  },

  // P8: a crash or ENOSPC mid-append leaves a torn last line in one bundle's
  // spool. That must cost at most the torn event: every other bundle anchors,
  // the torn bundle anchors its intact events, and the next append starts on
  // a fresh line instead of gluing itself to the fragment forever.
  async P8() {
    const srv = await startServer((req, res) =>
      reply(res, 200, { requestId: `req-p8-${Date.now()}`, status: "CONFIRMED", txHash: TX, confirmations: 1 }));
    const { root, outDir } = await workspace([line({ agentId: "alpha" }), line({ agentId: "main" })]);
    const rec = await recorderFor(root, outDir, srv.url);
    await rec.scanOnce();
    const alphaSpool = path.join(outDir, "spool", "2026-02-03__alpha.jsonl");
    await fs.appendFile(alphaSpool, '{"ts":"2026-02-03T10:0');

    const r = await withDeadline(rec.anchorLatestBundles(), DEADLINE_MS);
    check("P8 anchorLatestBundles resolves despite the torn line",
      r.done && !r.error, r.error ? `rejected: ${r.error.message}` : r.done ? "resolved" : "hanging");
    const posted = srv.posts().map((p) => JSON.parse(p.body).manifest);
    const byAgent = Object.fromEntries(posted.map((m) => [m.agentId, m]));
    check("P8 the healthy bundle is still anchored",
      byAgent["openclaw:main"] !== undefined, `agents posted=${posted.map((m) => m.agentId).join(",") || "none"}`);
    check("P8 the torn bundle anchors its intact event, skipping only the fragment",
      byAgent["openclaw:alpha"]?.totalEvents === 1, `alpha totalEvents=${byAgent["openclaw:alpha"]?.totalEvents}`);

    await fs.appendFile(path.join(root, "sessions", "s1.jsonl"),
      JSON.stringify(line({ agentId: "alpha", ts: "2026-02-03T11:00:00Z", content: "after the tear" })) + "\n");
    await rec.scanOnce();
    const lines = (await fs.readFile(alphaSpool, "utf-8")).split("\n").filter(Boolean);
    let lastParses = true;
    try { JSON.parse(lines.at(-1)); } catch { lastParses = false; }
    check("P8 the next append lands on its own line, not glued to the fragment",
      lastParses, `last spool line: ${lines.at(-1)?.slice(0, 60)}`);

    const before = srv.posts().length;
    await rec.anchorLatestBundles();
    const again = srv.posts().slice(before).map((p) => JSON.parse(p.body).manifest)
      .find((m) => m.agentId === "openclaw:alpha");
    check("P8 the event written after the tear is anchored on the next pass",
      again?.totalEvents === 2, `alpha totalEvents=${again?.totalEvents}`);
  },

  // P9: a local failure confined to one bundle (here its bundle file path is
  // occupied by a directory, so writing it throws EISDIR) must not stop the
  // others. Any throw outside the network call used to reject the whole pass.
  async P9() {
    const srv = await startServer((req, res) =>
      reply(res, 200, { requestId: `req-p9-${Date.now()}`, status: "CONFIRMED", txHash: TX, confirmations: 1 }));
    const { root, outDir } = await workspace([line({ agentId: "alpha" }), line({ agentId: "main" })]);
    await fs.mkdir(path.join(outDir, "bundles", "2026-02-03__alpha.bundle.json"), { recursive: true });
    const rec = await recorderFor(root, outDir, srv.url);
    await rec.scanOnce();

    const r = await withDeadline(rec.anchorLatestBundles(), DEADLINE_MS);
    check("P9 anchorLatestBundles resolves although one bundle cannot be written",
      r.done && !r.error, r.error ? `rejected: ${r.error.message}` : r.done ? "resolved" : "hanging");
    const agents = srv.posts().map((p) => JSON.parse(p.body).manifest.agentId);
    const st = await readJson(statePath(outDir));
    check("P9 the healthy bundle is POSTed and recorded anchored",
      agents.includes("openclaw:main") && st?.[BUNDLE]?.state === "anchored",
      `agents posted=${agents.join(",") || "none"} main=${st?.[BUNDLE]?.state}`);
    check("P9 the broken bundle has no state recorded, so the next cycle retries it",
      st?.["2026-02-03__alpha"] === undefined, `alpha=${JSON.stringify(st?.["2026-02-03__alpha"])}`);
  },

  // P5: the dedup digest covers sessionId. The recorder sets meta to the
  // constant {source:"openclaw-jsonl"}, so sessionId is the only session-line
  // field that reaches the anchored event data without moving contentHash
  // (a string content is hashed on its own). Runs B and C start from the
  // anchored.json run A wrote; B differs from A only in sessionId, C is
  // identical to A.
  async P5() {
    const srv = await startServer((req, res) =>
      reply(res, 200, { requestId: `req-p5-${Date.now()}`, status: "CONFIRMED", txHash: TX, confirmations: 1 }));

    async function run(sessionId, seed) {
      const { root, outDir } = await workspace([line({ sessionId })]);
      if (seed) await fs.writeFile(statePath(outDir), seed);
      const rec = await recorderFor(root, outDir, srv.url);
      await rec.scanOnce();
      const postsBefore = srv.posts().length;
      await rec.anchorLatestBundles();
      const spool = (await fs.readFile(path.join(outDir, "spool", `${BUNDLE}.jsonl`), "utf-8"))
        .split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return {
        posted: srv.posts().length - postsBefore,
        spool,
        state: (await readJson(statePath(outDir)))?.[BUNDLE],
        stateText: await fs.readFile(statePath(outDir), "utf-8").catch(() => undefined),
        receipt: await readJson(receiptPath(outDir))
      };
    }

    const a = await run("sess-A");
    check("P5 setup: run A posts once and is anchored",
      a.posted === 1 && a.state?.state === "anchored",
      `POSTs=${a.posted} state=${a.state?.state}`);

    const b = await run("sess-B", a.stateText);
    const { sessionId: sa, ...restA } = a.spool[0] ?? {};
    const { sessionId: sb, ...restB } = b.spool[0] ?? {};
    check("P5 inputs A and B differ only in sessionId (same contentHash, same kind, same meta)",
      a.spool.length === 1 && b.spool.length === 1 && sa !== sb &&
        JSON.stringify(restA) === JSON.stringify(restB),
      `A.sessionId=${sa} B.sessionId=${sb} contentHash equal=${restA.contentHash === restB.contentHash}`);
    check("P5 a sessionId change re-POSTs",
      b.posted === 1, `POSTs in run B=${b.posted}`);
    check("P5 the re-POST is recorded under a new contentDigest",
      b.state?.contentDigest && b.state.contentDigest !== a.state?.contentDigest &&
        b.state?.state === "anchored",
      `A=${a.state?.contentDigest?.slice(0, 12)} B=${b.state?.contentDigest?.slice(0, 12)} state=${b.state?.state}`);

    const c = await run("sess-A", a.stateText);
    check("P5 an identical rerun does not re-POST",
      c.posted === 0, `POSTs in run C=${c.posted}`);
    check("P5 the identical rerun leaves no new receipt and an unchanged anchored.json",
      c.receipt === undefined && c.stateText === a.stateText,
      `receipt=${c.receipt === undefined ? "none" : "written"} anchored.json ${c.stateText === a.stateText ? "unchanged" : "changed"}`);
  }
};

async function runCase(name) {
  console.log(`[${name}] dist=${DIST}`);
  await CASES[name]();
  finish();
}

async function orchestrate(names) {
  const results = [];
  for (const name of names) {
    const code = await new Promise((resolve) => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "real-resilience-"));
      const child = spawn(process.execPath, [SELF, "--case", name], {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, RESILIENCE_TMP: tmp }
      });
      const kill = setTimeout(() => { console.log(`  FAIL  ${name} child killed after 60s`); child.kill("SIGKILL"); }, 60_000);
      child.on("exit", (c) => { clearTimeout(kill); rmSync(tmp, { recursive: true, force: true }); resolve(c ?? 1); });
    });
    results.push([name, code]);
  }
  console.log("\nsummary:");
  for (const [name, code] of results) console.log(`  ${code === 0 ? "PASS" : "FAIL"}  ${name}`);
  process.exit(results.every(([, c]) => c === 0) ? 0 : 1);
}

if (process.argv[2] === "--case") {
  await runCase(process.argv[3]);
} else {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((n) => !(n in CASES));
  if (unknown.length) {
    console.error(`unknown case(s): ${unknown.join(", ")}; known: ${Object.keys(CASES).join(", ")}`);
    process.exit(2);
  }
  await orchestrate(wanted.length ? wanted : Object.keys(CASES));
}
