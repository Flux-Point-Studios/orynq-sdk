// The submitted-state poll and its 404 door, driven through the SHIPPED build.
//
// Every assertion here is on what an outside observer can see: requests a real
// 127.0.0.1 server received, and the receipt and state files the recorder wrote.
// Nothing in this file decides what the recorder should do with a poll answer —
// the dist does that, and the probe only counts the consequences.
//
// Usage: node test/poll.probe.mjs [P1 P2 ...]   (default: every property)
// RECORDER_DIST overrides the build under test (default: ../dist/index.js).
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = process.env.RECORDER_DIST
  ?? fileURLToPath(new URL("../dist/index.js", import.meta.url));
const { OpenClawRecorder, defaultConfig } = await import(pathToFileURL(DIST).href);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUNDLE = "2026-02-03__main";
const TX = "ab".repeat(32);
const T0 = Date.UTC(2026, 1, 3, 12, 0, 0);

// Time is the probe's to set: the recorder measures "waited" with Date.now, and
// it is held constant inside a cycle so no in-flight request sees a jump.
const realDateNow = Date.now;
let fakeNow = T0;
Date.now = () => fakeNow;

// stderr is the recorder's only operator-facing channel; capture it whole.
const realStderrWrite = process.stderr.write.bind(process.stderr);
let stderrLines = [];
process.stderr.write = (chunk) => {
  stderrLines.push(...String(chunk).split("\n").filter(Boolean));
  return true;
};

let failures = 0;
let passes = 0;
function check(name, ok, evidence) {
  if (ok) passes++; else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${evidence ? `  [${evidence}]` : ""}`);
}

const json = (status, obj) => ({ status, type: "application/json", body: JSON.stringify(obj) });
const PENDING = json(200, { requestId: "r1", status: "PENDING", txHash: TX, confirmations: 0 });
const NOT_FOUND_EXACT = json(404, { detail: "anchor_request_not_found" });

/**
 * One isolated world: a session file, a real HTTP server standing in for the
 * t-backend, and a recorder pointed at it. The server's POST always answers
 * SUBMITTED with a fresh requestId (r1, r2, ...); the status GET answers
 * whatever `statusFor(requestId)` returns at that moment.
 */
async function world(statusFor) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "real-poll-"));
  const outDir = path.join(root, "orynq", "recorder");
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(root, "sessions", "s1.jsonl"),
    JSON.stringify({ ts: "2026-02-03T10:00:00Z", agentId: "main", type: "user", content: "hi" }) + "\n"
  );

  const seen = { posts: [], gets: [], other: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const send = ({ status, type, body: out }) => {
        const headers = { connection: "close", "content-length": Buffer.byteLength(out) };
        if (type) headers["content-type"] = type;
        res.writeHead(status, headers);
        res.end(out);
      };
      if (req.method === "POST" && req.url === "/anchors/process-trace") {
        seen.posts.push({ xPartner: req.headers["x-partner"] ?? null, hasManifest: !!JSON.parse(body).manifest });
        const requestId = `r${seen.posts.length}`;
        send(json(200, { requestId, status: "SUBMITTED", txHash: TX, confirmations: 0 }));
        return;
      }
      const m = req.method === "GET" && /^\/anchors\/status\/([^/?]+)$/.exec(req.url);
      if (m) {
        const requestId = decodeURIComponent(m[1]);
        seen.gets.push({ requestId, xPartner: req.headers["x-partner"] ?? null });
        send(statusFor(requestId));
        return;
      }
      seen.other.push(`${req.method} ${req.url}`);
      send({ status: 418, type: "text/plain", body: "unexpected route" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  process.env.ORYNQ_PARTNER_KEY = "dummy-partner-key-not-a-secret";
  const rec = new OpenClawRecorder(defaultConfig({
    openclawRoot: root,
    outDir,
    anchor: { enabled: true, baseUrl },
    schedule: { scanEverySeconds: 10, anchorEveryMinutes: 60, jitterSeconds: 0 }
  }));

  const readJson = async (p) => JSON.parse(await fs.readFile(path.join(outDir, p), "utf-8"));

  /** Run one anchor cycle at T0 + offset; report what the outside world saw. */
  async function cycle(offsetMs) {
    fakeNow = T0 + offsetMs;
    stderrLines = [];
    await rec.anchorLatestBundles();
    const state = (await readJson("state/anchored.json"))[BUNDLE];
    const receiptRaw = await fs.readFile(path.join(outDir, "receipts", `${BUNDLE}.json`), "utf-8");
    return {
      posts: seen.posts.length,
      gets: seen.gets.map((g) => g.requestId),
      state,
      receipt: JSON.parse(receiptRaw),
      receiptRaw,
      stderr: [...stderrLines]
    };
  }

  async function seed() {
    fakeNow = T0;
    await rec.scanOnce();
    return cycle(0);
  }

  async function close() {
    await new Promise((r) => server.close(r));
    await fs.rm(root, { recursive: true, force: true });
  }

  return { seed, cycle, close, seen };
}

/** Every scenario starts from the same place: one POST answered SUBMITTED/r1. */
async function seeded(tag, statusFor) {
  const w = await world(statusFor);
  const s = await w.seed();
  check(`${tag} seed: first cycle POSTs once and records submitted/r1`,
    s.posts === 1 && s.gets.length === 0 && s.state?.state === "submitted" &&
      s.state?.requestId === "r1" && s.receipt.state === "submitted" && s.receipt.txHash === TX,
    `posts=${s.posts} gets=${s.gets.length} state=${s.state?.state} requestId=${s.state?.requestId} receipt.state=${s.receipt.state}`);
  return { w, s };
}

const warnings = (c) => c.stderr.filter((l) => l.includes("STILL UNCONFIRMED"));

const PROPS = {
  async P1() {
    const { w, s } = await seeded("P1", () => PENDING);
    try {
      const expectGets = [];
      for (const [label, off] of [["+1h", HOUR], ["+7h", 7 * HOUR], ["+30d", 30 * DAY]]) {
        const c = await w.cycle(off);
        expectGets.push("r1");
        check(`P1 PENDING at ${label}: no re-post`,
          c.posts === 1,
          `posts=${c.posts}`);
        check(`P1 PENDING at ${label}: the status endpoint was asked about r1`,
          JSON.stringify(c.gets) === JSON.stringify(expectGets),
          `gets=${JSON.stringify(c.gets)}`);
        check(`P1 PENDING at ${label}: state stays submitted/r1 and the receipt is untouched`,
          c.state.state === "submitted" && c.state.requestId === "r1" && c.receiptRaw === s.receiptRaw,
          `state=${c.state.state} requestId=${c.state.requestId} receiptUnchanged=${c.receiptRaw === s.receiptRaw}`);
        // Guards the probe itself: a transport failure would also "not re-post".
        check(`P1 PENDING at ${label}: recorder did not see a poll error`,
          !c.stderr.some((l) => l.includes("poll=error")),
          c.stderr.join(" | ").slice(0, 160) || "stderr empty");
      }
      check("P1 status GETs carried the partner key", w.seen.gets.every((g) => g.xPartner),
        `x-partner present on ${w.seen.gets.filter((g) => g.xPartner).length}/${w.seen.gets.length}`);
    } finally { await w.close(); }
  },

  async P2() {
    const { w } = await seeded("P2", (rid) => (rid === "r1" ? NOT_FOUND_EXACT : PENDING));
    try {
      const c1 = await w.cycle(HOUR);
      check("P2 exact not-found at +1h: the next cycle re-posts",
        c1.posts === 2 && JSON.stringify(c1.gets) === '["r1"]',
        `posts=${c1.posts} gets=${JSON.stringify(c1.gets)}`);
      check("P2 re-post recorded as submitted under the new requestId r2",
        c1.state.state === "submitted" && c1.state.requestId === "r2" && c1.receipt.response?.requestId === "r2",
        `state=${c1.state.state} requestId=${c1.state.requestId} receipt.requestId=${c1.receipt.response?.requestId}`);
      const c2 = await w.cycle(2 * HOUR);
      check("P2 once re-posted, the new request is polled, not re-posted again",
        c2.posts === 2 && JSON.stringify(c2.gets) === '["r1","r2"]',
        `posts=${c2.posts} gets=${JSON.stringify(c2.gets)}`);
    } finally { await w.close(); }
  },

  async P3() {
    const variants = {
      "HTML proxy page": {
        status: 404,
        type: "text/html",
        body: "<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>"
      },
      'JSON {"detail":"Not Found"}': json(404, { detail: "Not Found" }),
      "empty body": { status: 404, type: null, body: "" }
    };
    for (const [name, answer] of Object.entries(variants)) {
      const { w } = await seeded(`P3 (${name})`, () => answer);
      try {
        for (const [label, off] of [["+1h", HOUR], ["+7h", 7 * HOUR]]) {
          const c = await w.cycle(off);
          check(`P3 404 ${name} at ${label}: no re-post`,
            c.posts === 1 && c.gets.length === (label === "+1h" ? 1 : 2) &&
              c.state.state === "submitted" && c.state.requestId === "r1",
            `posts=${c.posts} gets=${c.gets.length} state=${c.state.state} requestId=${c.state.requestId}`);
        }
      } finally { await w.close(); }
    }
  },

  async P4() {
    const variants = {
      "500 JSON": json(500, { detail: "Internal Server Error" }),
      "500 text": { status: 500, type: "text/plain", body: "Internal Server Error" }
    };
    for (const [name, answer] of Object.entries(variants)) {
      const { w } = await seeded(`P4 (${name})`, () => answer);
      try {
        for (const [label, off] of [["+1h", HOUR], ["+7h", 7 * HOUR]]) {
          const c = await w.cycle(off);
          check(`P4 ${name} at ${label}: no re-post`,
            c.posts === 1 && c.gets.length === (label === "+1h" ? 1 : 2) &&
              c.state.state === "submitted" && c.state.requestId === "r1",
            `posts=${c.posts} gets=${c.gets.length} state=${c.state.state} requestId=${c.state.requestId}`);
        }
      } finally { await w.close(); }
    }
  },

  async P5() {
    const variants = {
      "CONFIRMED, confirmations=1": json(200, { requestId: "r1", status: "CONFIRMED", txHash: TX, confirmations: 1 }),
      "CONFIRMED, confirmations absent": json(200, { requestId: "r1", status: "CONFIRMED", txHash: TX })
    };
    for (const [name, answer] of Object.entries(variants)) {
      const { w, s } = await seeded(`P5 (${name})`, () => answer);
      try {
        const c1 = await w.cycle(HOUR);
        check(`P5 ${name} at +1h: state promoted to anchored`,
          c1.posts === 1 && JSON.stringify(c1.gets) === '["r1"]' &&
            c1.state.state === "anchored" && typeof c1.state.confirmedAt === "number" &&
            c1.state.contentDigest === s.state.contentDigest && c1.state.requestId === "r1",
          `posts=${c1.posts} gets=${JSON.stringify(c1.gets)} state=${c1.state.state} confirmedAt=${c1.state.confirmedAt}`);
        for (const [label, off] of [["+2h", 2 * HOUR], ["+3d", 3 * DAY]]) {
          const c = await w.cycle(off);
          check(`P5 ${name} at ${label}: no further POST or GET`,
            c.posts === 1 && c.gets.length === 1 && c.state.state === "anchored",
            `posts=${c.posts} gets=${c.gets.length} state=${c.state.state}`);
        }
      } finally { await w.close(); }
    }
  },

  async P6() {
    const variants = {
      PENDING: () => PENDING,
      "500 poll error": () => json(500, { detail: "Internal Server Error" })
    };
    for (const [name, statusFor] of Object.entries(variants)) {
      const { w } = await seeded(`P6 (${name})`, statusFor);
      try {
        for (const [label, off] of [["+1h", HOUR], ["+5h59m", 6 * HOUR - MINUTE]]) {
          const c = await w.cycle(off);
          check(`P6 ${name} at ${label}: no STILL UNCONFIRMED warning yet`,
            warnings(c).length === 0 && c.gets.length > 0,
            `warnings=${warnings(c).length} gets=${c.gets.length}`);
        }
        for (const [label, off] of [["+6h01m", 6 * HOUR + MINUTE], ["+30d", 30 * DAY]]) {
          const c = await w.cycle(off);
          const hit = warnings(c);
          check(`P6 ${name} at ${label}: STILL UNCONFIRMED written to stderr, naming bundle and requestId`,
            hit.length === 1 && hit[0].includes(BUNDLE) && hit[0].includes("r1") && c.posts === 1,
            hit[0] ?? `stderr=${JSON.stringify(c.stderr)}`);
        }
      } finally { await w.close(); }
    }
  }
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PROPS);
console.log(`recorder under test: ${DIST}`);
try {
  for (const p of wanted) {
    if (!PROPS[p]) { check(`unknown property ${p}`, false); continue; }
    await PROPS[p]();
  }
} catch (err) {
  check("probe ran to completion", false, err?.stack ?? String(err));
} finally {
  process.stderr.write = realStderrWrite;
  Date.now = realDateNow;
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
