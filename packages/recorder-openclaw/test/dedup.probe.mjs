// Dedup probes against the SHIPPED build (dist/index.js), driven through a real
// 127.0.0.1 HTTP server. No decision logic is re-implemented here: every
// assertion is a count of requests the server received, or the content of a
// receipt/state file the recorder wrote.
//
// Run: node test/dedup.probe.mjs   (exit 0 = all PASS)
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const { OpenClawRecorder, defaultConfig } = await import(DIST);
console.log(`recorder under test: ${DIST}`);

const BUNDLE = "2026-02-03__main";
const TX = "ab".repeat(32);
const HOUR = 3_600_000;
const CYCLES = 24;
process.env.ORYNQ_PARTNER_KEY = "dummy-not-a-secret";

// Recorder decisions that depend on elapsed time read Date.now; advance it one
// hour per cycle, as the hourly daemon would.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

const recorderLog = [];
const realConsoleError = console.error.bind(console);
console.error = (...args) => { recorderLog.push(args.join(" ")); };

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const json = (code, body) => ({ code, body });
const submitted = (requestId) => json(200, { requestId, status: "SUBMITTED", txHash: TX, confirmations: 0 });
const pending = (requestId) => json(200, { requestId, status: "PENDING", txHash: TX, confirmations: 0 });
const confirmed = (requestId) => json(200, { requestId, status: "CONFIRMED", txHash: TX, confirmations: 1 });

async function startServer({ onPost, onStatus }) {
  const log = { posts: [], gets: [], other: [] };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const send = ({ code, body }) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/anchors/process-trace") {
        const { manifest } = JSON.parse(raw);
        const entry = {
          agentId: manifest.agentId,
          totalEvents: manifest.totalEvents,
          rootHash: manifest.rootHash,
          manifestHash: manifest.manifestHash,
          partner: req.headers["x-partner"]
        };
        log.posts.push(entry);
        return send(onPost(entry, log));
      }
      const m = req.method === "GET" ? /^\/anchors\/status\/([^/?]+)$/.exec(req.url) : null;
      if (m) {
        const requestId = decodeURIComponent(m[1]);
        log.gets.push({ requestId, partner: req.headers["x-partner"] });
        return send(onStatus(requestId, log));
      }
      log.other.push(`${req.method} ${req.url}`);
      send(json(404, { detail: "Not Found" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    log,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); })
  };
}

const ev = (ts, agentId, type, content) => JSON.stringify({ ts, agentId, type, content }) + "\n";

async function makeRecorder(server, sessionLines) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "real-dedup-"));
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  const sessionFile = path.join(root, "sessions", "s1.jsonl");
  await fs.writeFile(sessionFile, sessionLines.join(""));
  const outDir = path.join(root, "out");
  const cfg = defaultConfig({ openclawRoot: root, outDir, anchor: { enabled: true, baseUrl: server.baseUrl } });
  const rec = new OpenClawRecorder(cfg);
  const readJson = async (rel) => JSON.parse(await fs.readFile(path.join(outDir, rel), "utf-8"));
  return {
    rec,
    root,
    outDir,
    sessionFile,
    append: (s) => fs.appendFile(sessionFile, s),
    state: () => readJson("state/anchored.json"),
    receipt: (b = BUNDLE) => readJson(`receipts/${b}.json`),
    receiptRaw: (b = BUNDLE) => fs.readFile(path.join(outDir, "receipts", `${b}.json`), "utf-8"),
    // One daemon iteration: tail the sessions, then run the anchor pass.
    cycle: async () => {
      await rec.scanOnce();
      await rec.anchorLatestBundles();
      clockOffset += HOUR;
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

async function probe(name, fn) {
  console.log(`\n== ${name}`);
  recorderLog.length = 0;
  try {
    await fn();
  } catch (err) {
    check(`${name}: probe ran to completion`, false, err?.stack ?? String(err));
  }
  const tags = [...new Set(recorderLog.map((l) => l.replace(/^\[anchor\] \S+ /, "").split(/[ (:]/)[0]))];
  console.log(`   recorder stderr: ${recorderLog.length} line(s)${tags.length ? `, kinds: ${tags.join(", ")}` : ""}`);
}

// ---------------------------------------------------------------------------
// P1. Unchanged spool + SUBMITTED/PENDING: exactly one POST in 24 cycles; the
// other 23 cycles poll the status endpoint instead.
// ---------------------------------------------------------------------------
await probe("P1 unchanged spool, SUBMITTED then PENDING, 24 cycles", async () => {
  const srv = await startServer({ onPost: () => submitted("r1"), onStatus: (id) => pending(id) });
  const r = await makeRecorder(srv, [ev("2026-02-03T10:00:00Z", "main", "user", "hi")]);
  try {
    const perCycle = [];
    let receiptAfterFirst = null;
    for (let i = 1; i <= CYCLES; i++) {
      const p0 = srv.log.posts.length, g0 = srv.log.gets.length;
      await r.cycle();
      perCycle.push({ posts: srv.log.posts.length - p0, gets: srv.log.gets.length - g0 });
      if (i === 1) receiptAfterFirst = await r.receiptRaw();
    }
    const posts = srv.log.posts.length, gets = srv.log.gets.length;
    check("P1 exactly ONE POST reached the server over 24 cycles", posts === 1, `POSTs=${posts}`);
    check("P1 the one POST was in cycle 1", perCycle[0].posts === 1 && perCycle[0].gets === 0,
      `cycle1 posts=${perCycle[0].posts} gets=${perCycle[0].gets}`);
    const laterOk = perCycle.slice(1).every((c) => c.posts === 0 && c.gets === 1);
    check("P1 cycles 2..24 each made 0 POST and exactly 1 status GET", laterOk,
      `cycles 2..24 [posts/gets]=${perCycle.slice(1).map((c) => `${c.posts}/${c.gets}`).join(" ")}`);
    check("P1 every GET polled /anchors/status/r1 with the partner key",
      gets === CYCLES - 1 && srv.log.gets.every((g) => g.requestId === "r1" && g.partner === "dummy-not-a-secret"),
      `GETs=${gets} ids=${[...new Set(srv.log.gets.map((g) => g.requestId))].join(",")}`);
    const s = (await r.state())[BUNDLE];
    check("P1 state/anchored.json holds submitted + requestId r1 + a contentDigest",
      s?.state === "submitted" && s?.requestId === "r1" && /^[0-9a-f]{64}$/.test(s?.contentDigest ?? "") && s?.attempts === 0,
      `state=${s?.state} requestId=${s?.requestId} attempts=${s?.attempts} contentDigest=${String(s?.contentDigest).slice(0, 16)}...`);
    const rc = await r.receipt();
    check("P1 receipt says submitted, not anchored, with the txHash",
      rc.state === "submitted" && rc.anchored === false && rc.txHash === TX,
      `receipt.state=${rc.state} anchored=${rc.anchored} txHash=${String(rc.txHash).slice(0, 8)}...`);
    check("P1 receipt was written once (unchanged after cycle 1)", (await r.receiptRaw()) === receiptAfterFirst,
      `timestamp=${rc.timestamp}`);
    check("P1 no unexpected routes hit", srv.log.other.length === 0, srv.log.other.join("; "));
  } finally {
    await srv.close();
    await r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P2. Once the status GET says CONFIRMED the bundle is "anchored" and gets no
// further POST and no further GET. A second, still-pending bundle is the
// control: it keeps being polled, so silence for the first is not idleness.
// ---------------------------------------------------------------------------
await probe("P2 CONFIRMED via status poll -> anchored -> silent (two bundles)", async () => {
  let mainConfirmed = false;
  const srv = await startServer({
    onPost: (m) => submitted(`r-${m.agentId.split(":")[1]}`),
    onStatus: (id) => (id === "r-main" && mainConfirmed ? confirmed(id) : pending(id))
  });
  const r = await makeRecorder(srv, [
    ev("2026-02-03T10:00:00Z", "main", "user", "hi"),
    ev("2026-02-03T10:00:05Z", "other", "user", "hello")
  ]);
  const OTHER = "2026-02-03__other";
  const postsFor = (agent, from = 0) => srv.log.posts.slice(from).filter((p) => p.agentId === `openclaw:${agent}`).length;
  const getsFor = (id, from = 0) => srv.log.gets.slice(from).filter((g) => g.requestId === id).length;
  try {
    for (let i = 1; i <= 3; i++) await r.cycle();
    check("P2 setup: one POST per bundle, then polling", postsFor("main") === 1 && postsFor("other") === 1 && getsFor("r-main") === 2,
      `posts main=${postsFor("main")} other=${postsFor("other")} gets r-main=${getsFor("r-main")}`);
    mainConfirmed = true;
    await r.cycle(); // cycle 4: the r-main poll answers CONFIRMED
    const s4 = (await r.state())[BUNDLE];
    check("P2 status CONFIRMED promotes the bundle to state=anchored",
      s4?.state === "anchored" && typeof s4?.confirmedAt === "number" && s4?.requestId === "r-main",
      `state=${s4?.state} confirmedAt=${s4?.confirmedAt} requestId=${s4?.requestId}`);
    check("P2 recorder logged the confirmation", recorderLog.some((l) => l.includes(`${BUNDLE} CONFIRMED`)),
      recorderLog.find((l) => l.includes("CONFIRMED")));
    const p0 = srv.log.posts.length, g0 = srv.log.gets.length;
    for (let i = 5; i <= CYCLES; i++) await r.cycle();
    check("P2 cycles 5..24 made NO POST for the anchored bundle", postsFor("main", p0) === 0, `POSTs(main)=${postsFor("main", p0)}`);
    check("P2 cycles 5..24 made NO status GET for the anchored bundle", getsFor("r-main", g0) === 0, `GETs(r-main)=${getsFor("r-main", g0)}`);
    check("P2 control: the pending bundle was still polled every cycle and never re-posted",
      getsFor("r-other", g0) === CYCLES - 4 && postsFor("other", p0) === 0,
      `GETs(r-other)=${getsFor("r-other", g0)} POSTs(other)=${postsFor("other", p0)}`);
    const s = await r.state();
    check("P2 state stays anchored for main, submitted for other",
      s[BUNDLE]?.state === "anchored" && s[OTHER]?.state === "submitted",
      `main=${s[BUNDLE]?.state} other=${s[OTHER]?.state}`);
  } finally {
    await srv.close();
    await r.cleanup();
  }
});

await probe("P2b POST answers CONFIRMED directly -> anchored -> 23 silent cycles", async () => {
  const srv = await startServer({ onPost: () => confirmed("r1"), onStatus: (id) => confirmed(id) });
  const r = await makeRecorder(srv, [ev("2026-02-03T10:00:00Z", "main", "user", "hi")]);
  try {
    await r.cycle();
    const rc = await r.receipt();
    const s1 = (await r.state())[BUNDLE];
    check("P2b first POST with CONFIRMED records anchored in receipt and state",
      rc.anchored === true && rc.state === "anchored" && s1?.state === "anchored",
      `receipt.anchored=${rc.anchored} receipt.state=${rc.state} state=${s1?.state}`);
    for (let i = 2; i <= CYCLES; i++) await r.cycle();
    check("P2b 24 cycles -> 1 POST, 0 GET", srv.log.posts.length === 1 && srv.log.gets.length === 0,
      `POSTs=${srv.log.posts.length} GETs=${srv.log.gets.length}`);
  } finally {
    await srv.close();
    await r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P3. A genuinely new session line must be anchored: the next cycle POSTs a
// manifest covering it. Negative control: bytes that carry no event do not.
// ---------------------------------------------------------------------------
await probe("P3 new content after the bundle was anchored", async () => {
  let n = 0;
  const srv = await startServer({ onPost: () => submitted(`r${++n}`), onStatus: (id) => confirmed(id) });
  const r = await makeRecorder(srv, [ev("2026-02-03T10:00:00Z", "main", "user", "hi")]);
  try {
    await r.cycle(); // POST r1
    await r.cycle(); // GET r1 -> CONFIRMED
    const before = (await r.state())[BUNDLE];
    check("P3 setup: anchored after POST + confirming poll", before?.state === "anchored" && srv.log.posts.length === 1,
      `state=${before?.state} POSTs=${srv.log.posts.length}`);

    // Negative control: a blank line and a malformed line carry no event.
    await r.append("\n{not json\n");
    for (let i = 0; i < 3; i++) await r.cycle();
    check("P3 control: non-event bytes in the session file cause no POST and no GET",
      srv.log.posts.length === 1 && srv.log.gets.length === 1,
      `POSTs=${srv.log.posts.length} GETs=${srv.log.gets.length}`);

    await r.append(ev("2026-02-03T11:00:00Z", "main", "assistant", "a genuinely new reply"));
    const p0 = srv.log.posts.length;
    await r.cycle();
    const newPosts = srv.log.posts.slice(p0);
    check("P3 the next cycle after a new line POSTs exactly once", newPosts.length === 1, `new POSTs=${newPosts.length}`);
    const [first] = srv.log.posts;
    const second = newPosts[0];
    check("P3 the new POST's manifest covers the new event (more events, new root)",
      !!second && second.totalEvents > first.totalEvents && second.rootHash !== first.rootHash,
      `totalEvents ${first.totalEvents} -> ${second?.totalEvents}; rootHash ${first.rootHash.slice(0, 12)} -> ${second?.rootHash?.slice(0, 12)}`);
    const after = (await r.state())[BUNDLE];
    check("P3 state moved to the new submission with a new contentDigest",
      after?.state === "submitted" && after?.requestId === "r2" && after?.contentDigest !== before?.contentDigest,
      `state=${after?.state} requestId=${after?.requestId} digest ${String(before?.contentDigest).slice(0, 12)} -> ${String(after?.contentDigest).slice(0, 12)}`);
    for (let i = 0; i < 5; i++) await r.cycle();
    check("P3 after the re-anchor: polled r2 once, confirmed, then silent (no further POST)",
      srv.log.posts.length === 2 && srv.log.gets.filter((g) => g.requestId === "r2").length === 1 &&
      (await r.state())[BUNDLE]?.state === "anchored",
      `POSTs=${srv.log.posts.length} GETs(r2)=${srv.log.gets.filter((g) => g.requestId === "r2").length}`);
  } finally {
    await srv.close();
    await r.cleanup();
  }
});

await probe("P3b new content while the previous submission is still pending", async () => {
  let n = 0;
  const srv = await startServer({ onPost: () => submitted(`r${++n}`), onStatus: (id) => pending(id) });
  const r = await makeRecorder(srv, [ev("2026-02-03T10:00:00Z", "main", "user", "hi")]);
  try {
    await r.cycle(); // POST r1
    await r.cycle(); // GET r1 (pending)
    await r.append(ev("2026-02-03T11:00:00Z", "main", "assistant", "a genuinely new reply"));
    const p0 = srv.log.posts.length, g0 = srv.log.gets.length;
    await r.cycle();
    check("P3b new content POSTs even though the old anchor is still pending",
      srv.log.posts.length - p0 === 1 && srv.log.posts.at(-1).totalEvents > srv.log.posts[0].totalEvents,
      `new POSTs=${srv.log.posts.length - p0} GETs this cycle=${srv.log.gets.length - g0}`);
    const g1 = srv.log.gets.length;
    for (let i = 0; i < 4; i++) await r.cycle();
    const later = srv.log.gets.slice(g1).map((g) => g.requestId);
    check("P3b later cycles poll the NEW requestId, with no further POST",
      srv.log.posts.length === 2 && later.length === 4 && later.every((id) => id === "r2"),
      `POSTs=${srv.log.posts.length} polled=${later.join(",")}`);
  } finally {
    await srv.close();
    await r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P4. Legacy state (old build: manifestHash + lastReceipt, no contentDigest).
// The first cycle re-posts once; after that the bundle behaves like any other.
// ---------------------------------------------------------------------------
async function seedState(r, entry) {
  await fs.mkdir(path.join(r.outDir, "state"), { recursive: true });
  await fs.writeFile(path.join(r.outDir, "state", "anchored.json"), JSON.stringify({ [BUNDLE]: entry }, null, 2));
}
const LEGACY = { manifestHash: "x", lastReceipt: { anchored: true } };

await probe("P4 legacy entry, POST answers SUBMITTED, poll PENDING then CONFIRMED", async () => {
  let confirmAfter = Infinity;
  const srv = await startServer({
    onPost: () => submitted("r1"),
    onStatus: (id, log) => (log.gets.length >= confirmAfter ? confirmed(id) : pending(id))
  });
  const r = await makeRecorder(srv, [ev("2026-02-03T10:00:00Z", "main", "user", "hi")]);
  try {
    await seedState(r, LEGACY);
    await r.cycle();
    check("P4 first cycle re-posts the legacy bundle exactly once", srv.log.posts.length === 1 && srv.log.gets.length === 0,
      `POSTs=${srv.log.posts.length} GETs=${srv.log.gets.length}`);
    const s1 = (await r.state())[BUNDLE];
    check("P4 the legacy entry is upgraded (contentDigest, requestId, real manifestHash)",
      /^[0-9a-f]{64}$/.test(s1?.contentDigest ?? "") && s1?.requestId === "r1" && s1?.state === "submitted" && s1?.manifestHash !== "x",
      `state=${s1?.state} requestId=${s1?.requestId} manifestHash=${String(s1?.manifestHash).slice(0, 12)} contentDigest=${String(s1?.contentDigest).slice(0, 12)}`);
    confirmAfter = 11; // the 11th status GET (cycle 12) answers CONFIRMED
    const perCycle = [];
    for (let i = 2; i <= CYCLES; i++) {
      const p0 = srv.log.posts.length, g0 = srv.log.gets.length;
      await r.cycle();
      perCycle.push(`${srv.log.posts.length - p0}/${srv.log.gets.length - g0}`);
    }
    check("P4 cycles 2..24 make NO further POST", srv.log.posts.length === 1, `POSTs=${srv.log.posts.length}`);
    check("P4 cycles 2..24 poll until CONFIRMED, then go silent",
      srv.log.gets.length === 11 && perCycle.slice(0, 11).every((c) => c === "0/1") && perCycle.slice(11).every((c) => c === "0/0"),
      `per-cycle [posts/gets]=${perCycle.join(" ")}`);
    check("P4 bundle ends anchored", (await r.state())[BUNDLE]?.state === "anchored", `state=${(await r.state())[BUNDLE]?.state}`);
  } finally {
    await srv.close();
    await r.cleanup();
  }
});

await probe("P4b legacy entry, POST answers CONFIRMED", async () => {
  const srv = await startServer({ onPost: () => confirmed("r1"), onStatus: (id) => confirmed(id) });
  const r = await makeRecorder(srv, [ev("2026-02-03T10:00:00Z", "main", "user", "hi")]);
  try {
    await seedState(r, LEGACY);
    for (let i = 1; i <= CYCLES; i++) await r.cycle();
    check("P4b 24 cycles -> 1 POST, 0 GET", srv.log.posts.length === 1 && srv.log.gets.length === 0,
      `POSTs=${srv.log.posts.length} GETs=${srv.log.gets.length}`);
  } finally {
    await srv.close();
    await r.cleanup();
  }
});

// A submitted entry written by an intermediate build carries contentDigest but
// no requestId. Built from the recorder's own state file, not a local digest.
await probe("P4c submitted entry without requestId (intermediate build)", async () => {
  let n = 0;
  const srv = await startServer({ onPost: () => submitted(`r${++n}`), onStatus: (id) => pending(id) });
  const r = await makeRecorder(srv, [ev("2026-02-03T10:00:00Z", "main", "user", "hi")]);
  try {
    await r.cycle();
    const real = (await r.state())[BUNDLE];
    const { requestId, ...noRequestId } = real;
    await seedState(r, noRequestId);
    const p0 = srv.log.posts.length;
    for (let i = 0; i < CYCLES - 1; i++) await r.cycle();
    const s = (await r.state())[BUNDLE];
    check("P4c re-posts once, then polls the new requestId",
      srv.log.posts.length - p0 === 1 && s?.requestId === "r2" &&
      srv.log.gets.filter((g) => g.requestId === "r2").length === CYCLES - 2,
      `seeded without ${requestId}; new POSTs=${srv.log.posts.length - p0} requestId=${s?.requestId} GETs(r2)=${srv.log.gets.filter((g) => g.requestId === "r2").length}`);
  } finally {
    await srv.close();
    await r.cleanup();
  }
});

console.error = realConsoleError;
Date.now = realNow;
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
