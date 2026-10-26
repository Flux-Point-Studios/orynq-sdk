// This credential-bearing program imports builtins only. CI verifies its bytes against a
// reviewed digest and imports the verified snapshot, never workspace code or installed SDKs.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "Flux-Point-Studios/orynq-sdk";
const PATH = "docs/checkpoints/mainnet.json", MAX = 64 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function list(value) {
  if (!Array.isArray(value) || value.length > 4096) throw new Error("Invalid checkpoint publication list");
  const seen = new Set();
  for (const row of value) {
    if (!row || row.format !== "orynq-midnight-checkpoint-advance/v1" || row.network !== "mainnet" || !/^[a-f0-9]{64}$/.test(row.rootId) || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || seen.has(`${row.rootId}:${row.sequence}`)) throw new Error("Invalid checkpoint publication identity");
    seen.add(`${row.rootId}:${row.sequence}`);
  }
  return value;
}
export async function publishCheckpointCandidate({ file, token, fetcher = fetch }) {
  if (typeof token !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(token)) throw new Error("Checkpoint publication credential is unavailable");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX) throw new Error("Checkpoint publication file exceeds its bounds");
    bytes = readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error("Checkpoint publication file changed");
  } finally { closeSync(fd); }
  const candidate = list(JSON.parse(bytes.toString("utf8")));
  if (!candidate.length) throw new Error("Checkpoint publication candidate is empty");
  const digest = hash(bytes), branch = `maintenance/checkpoints/mainnet-${digest}`;
  const request = async (method, path, body, allowed = [200, 201]) => {
    const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/${path}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "orynq-checkpoint-maintenance/1", "x-github-api-version": "2022-11-28" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!allowed.includes(response.status) || response.status === 404) {
      await response.body?.cancel();
      if (response.status === 404 && allowed.includes(404)) return null;
      throw new Error(`Checkpoint publication HTTP status ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Checkpoint publication response has no body");
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.length;
        if (size > Math.ceil(MAX * 4 / 3) + 1024 * 1024) throw new Error("Checkpoint publication response exceeds its bounds");
        chunks.push(Buffer.from(next.value));
      }
    } catch (error) { await reader.cancel(); throw error; }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Checkpoint publication response is not JSON"); }
  };
  const ref = await request("GET", "git/ref/heads/main");
  const base = ref?.object?.sha;
  if (typeof base !== "string" || !/^[a-f0-9]{40}$/.test(base)) throw new Error("Invalid checkpoint publication base");
  const current = await request("GET", `contents/${PATH}?ref=${base}`);
  const readBlob = async info => {
    if (typeof info?.sha !== "string" || !/^[a-f0-9]{40}$/.test(info.sha) || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX) throw new Error("Invalid checkpoint publication content identity");
    const blob = await request("GET", `git/blobs/${info.sha}`);
    if (blob?.encoding !== "base64" || typeof blob.content !== "string" || blob.size !== info.size) throw new Error("Invalid checkpoint publication base content");
    const content = Buffer.from(blob.content, "base64");
    if (content.length !== info.size) throw new Error("Checkpoint publication blob length differs");
    return content;
  };
  const previous = list(JSON.parse((await readBlob(current)).toString("utf8")));
  const indexed = new Map(candidate.map(row => [`${row.rootId}:${row.sequence}`, JSON.stringify(row)]));
  if (previous.some(row => indexed.get(`${row.rootId}:${row.sequence}`) !== JSON.stringify(row)) || candidate.length <= previous.length) throw new Error("Checkpoint publication must preserve and extend current main");
  const existing = await request("GET", `git/ref/heads/${branch}`, undefined, [200, 404]);
  let reused = false;
  if (existing) {
    const held = await request("GET", `contents/${PATH}?ref=${branch}`);
    if (hash(await readBlob(held)) !== digest) throw new Error("Checkpoint proposal branch already exists with other content");
    reused = true;
  } else {
    await request("POST", "git/refs", { ref: `refs/heads/${branch}`, sha: base });
    await request("PUT", `contents/${PATH}`, { message: "Advance authenticated mainnet checkpoint evidence", branch, sha: current.sha, content: bytes.toString("base64") });
  }
  const open = await request("GET", `pulls?state=open&head=Flux-Point-Studios:${encodeURIComponent(branch)}`);
  if (!Array.isArray(open) || open.length > 1) throw new Error("Checkpoint proposal pull requests differ");
  if (open.length === 1) return { branch, digest, existing: true, pullRequest: Number.isSafeInteger(open[0]?.number) ? `https://github.com/${REPOSITORY}/pull/${open[0].number}` : null };
  const pr = await request("POST", "pulls", { title: "Advance authenticated mainnet checkpoint evidence", head: branch, base: "main", draft: false,
    body: `Preserve the accepted checkpoint prefix and append independently replayable GRANDPA advancement evidence. Candidate SHA-256: ${digest}.\n\nCI derived a fresh finalized target and replayed every proof from the pinned predecessor. Maintainers must review the proof/history validation before merging; no author signing, deployment or transaction submission is involved.` });
  return { branch, digest, existing: reused, pullRequest: Number.isSafeInteger(pr?.number) ? `https://github.com/${REPOSITORY}/pull/${pr.number}` : null };
}

const entry = import.meta.url.startsWith("data:") || (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
if (entry && process.env.CHECKPOINT_PUBLISH === "1") {
  publishCheckpointCandidate({ file: process.argv[2], token: process.env.CHECKPOINT_GITHUB_TOKEN }).then(result => console.log(JSON.stringify(result)), () => { console.error("Checkpoint publication failed; no raw service or credential diagnostics are emitted"); process.exitCode = 1; });
}
