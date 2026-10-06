// What the preprod evidence pack may claim, decided only from what the rehearsal recorded
// (evidence/raw.json, the crash drill's log) and what the separate verifier returned. Every
// failure is a reason not to write the pack. No imports: verify-all.mjs runs it beside the
// packed verify package, compose.ts beside the repository.

export const ROTATION_LABELS = ["rotation-old-before", "rotation-old-after", "rotation-new-after", "revoked-new-after"];
const RELAY_OF = { "rotation-old-before": "relay1", "rotation-old-after": "relay1", "rotation-new-after": "relay2", "revoked-new-after": "relay2" };

// The newest document decides: serial 1 lists relay-1 alone; serial 2 closes relay-1's window
// at rotation-old-before and opens relay-2's after it; serial 3 closes relay-2's at
// rotation-new-after, and passing serial 1 again cannot reopen anything.
const SERIAL_3 = { "rotation-old-before": "valid", "rotation-old-after": "author-revoked", "rotation-new-after": "valid", "revoked-new-after": "author-revoked" };
export const ROTATION_EXPECTED = {
  "serial 1": { "rotation-old-before": "valid", "rotation-old-after": "valid", "rotation-new-after": "unauthenticated", "revoked-new-after": "unauthenticated" },
  "serial 2": { "rotation-old-before": "valid", "rotation-old-after": "author-revoked", "rotation-new-after": "valid", "revoked-new-after": "valid" },
  "serial 3": SERIAL_3,
  "serial 3 with serial 1 passed again": SERIAL_3,
};

// Each verifier negative: the status it must return and the check whose failure causes it, so a
// source that could not answer is never counted as a refusal.
export const VERIFIER_NEGATIVES = {
  "kind 1 against another bundle's entry": ["invalid", "expectation"],
  "kind 2 against another attribute": ["invalid", "expectation"],
  "a kind-1 anchor read as kind 2": ["invalid", "expectation"],
  "a stranger as the expected author": ["unauthenticated", "author"],
  "a transaction hash no chain holds": ["invalid", "indexer"],
  "the registry deploy read as an anchor": ["invalid", "anchor"],
  "the DUST registration read as an anchor": ["invalid", "anchor"],
  "finality skipped": ["unverified-finality", "finality"],
  "a registry pinned at another deploy height": ["invalid", "registry-deploy"],
  "a registry at another address": ["invalid", "anchor"],
  "no KNOWN_AUTHORS document and no checkpoint": ["unverified-finality", "finality"],
  "a checkpoint too far below for a zero set-change budget": ["unverified-finality", "finality"],
};

// The maintenance updates the node must refuse, and the only refusal that counts for each: the
// node's own JSON-RPC answer 1010 Invalid Transaction carrying the maintenance authority's own
// custom code from midnight-node's ledger error map. The registry's authority has no committee
// and threshold 1, so an unsigned update misses the threshold and a signature at index 0 names
// no member. Any other 1010 (another guard, a stale transaction, a fee the wallet cannot pay)
// proves nothing about the authority, nor does a transport failure or a timeout.
export const INVALID_TRANSACTION = 1010;
const INVALID_TRANSACTION_MESSAGE = "Invalid Transaction";
const THRESHOLD_MISSED = { data: "Custom error: 136", refusedBy: "ThresholdMissed" };
const KEY_NOT_IN_COMMITTEE = { data: "Custom error: 134", refusedBy: "KeyNotInCommittee" };
export const NODE_NEGATIVES = {
  "ReplaceAuthority, unsigned": THRESHOLD_MISSED,
  "VerifierKeyRemove(anchor), signed by a stranger at index 0": KEY_NOT_IN_COMMITTEE,
  "VerifierKeyInsert(rewrite), signed by a stranger at index 0": KEY_NOT_IN_COMMITTEE,
};
export const MIN_ANCHORS = { 1: 10, 2: 2 };

// KNOWN_AUTHORS documents forged from serial 3, and the verify package's only answer that counts
// for each. The verifier refuses each failed check with its own message, so the two forgeries
// under the trust root's key, which carry 64 bytes of hex, count only when Ed25519 verification
// refused them; the trust-root allow-list refuses the stranger's own key first; and the control
// opens the same document with the stranger as trust root, so nothing but the signature is wrong.
const NOT_SIGNED_BY_A_TRUST_ROOT = "the known-authors document carries no signature by a trust root";
const SIGNATURE_DOES_NOT_VERIFY = "the known-authors document's signature by a trust root does not verify";
const REOPENED = "serial 3 with every author window reopened, under the trust root's signature on serial 3";
const UNDER_ROOT_KEY = "that document signed by a stranger, under the trust root's key";
const UNDER_OWN_KEY = "that document signed by a stranger, under the stranger's key";
const CONTROL = "positive control: that document signed by a stranger, with the stranger as the trust root";
const FORGED_DOCUMENTS = {
  [REOPENED]: `refused: ${SIGNATURE_DOES_NOT_VERIFY}`,
  [UNDER_ROOT_KEY]: `refused: ${SIGNATURE_DOES_NOT_VERIFY}`,
  [UNDER_OWN_KEY]: `refused: ${NOT_SIGNED_BY_A_TRUST_ROOT}`,
  [CONTROL]: "opened",
};

// Builds each forged document with the trust roots to open it under. `sign` is the verify
// package's signKnownAuthors; the stranger's seed is fresh and never written anywhere.
export function forgeKnownAuthors(serial3, root, sign, strangerSeed) {
  const reopened = JSON.parse(serial3.document);
  for (const network of Object.values(reopened.networks)) for (const author of network.authors) author.validTo = null;
  const document = `${JSON.stringify(reopened, null, 2)}\n`;
  const byStranger = sign(document, strangerSeed);
  const [{ key: stranger, signature }] = byStranger.signatures;
  return {
    [REOPENED]: { signed: { document, signatures: serial3.signatures }, trustRoots: [root] },
    [UNDER_ROOT_KEY]: { signed: { document, signatures: [{ key: root, signature }] }, trustRoots: [root] },
    [UNDER_OWN_KEY]: { signed: byStranger, trustRoots: [root] },
    [CONTROL]: { signed: byStranger, trustRoots: [stranger] },
  };
}

// Each crash window's kill mode, and the words crash.ts logs as it dies there.
export const CRASH_WINDOWS = {
  "crash-before-broadcast": { mode: "kill-before", dying: "dying before broadcast" },
  "crash-after-broadcast": { mode: "kill-after", dying: "dying after the node accepted the bytes" },
};

// The crash drill's log: one JSON object per line, and one "crash.ts MODE LABEL exit=N" line per
// step in its status file.
export const parseCrashLog = (text) => text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
export const parseCrashStatus = (text) =>
  text
    .split("\n")
    .map((l) => /^crash\.ts (\S+) (\S+) exit=(\d+)$/.exec(l.trim()))
    .filter(Boolean)
    .map(([, mode, label, exit]) => ({ mode, label, exit: Number(exit) }));

const isValid = (v) => v?.status === "valid" && v.assurance === "consensus-verified";
const verdict = (v) => (v ? `${v.status} at ${v.assurance ?? "no"} assurance${v.failed?.length ? ` (${v.failed.join("; ")})` : ""}` : "not verified");

// One journal crash window: its kill step must die by SIGKILL where the window says, after
// writing the journal row, and the recovery must land exactly the bytes that row holds,
// broadcasting them again only if they never left.
function crashDrill(label, crash, status, raw) {
  const failures = [];
  const { mode, dying: said } = CRASH_WINDOWS[label];
  const events = crash.filter((e) => e.label === label);
  const dying = events.filter((e) => e.mode !== "recover");
  if (dying.length !== 1 || dying[0].mode !== mode || dying[0].event !== said) {
    return { failures: [`crash drill ${label}: its kill step logged ${JSON.stringify(dying.map((e) => [e.mode, e.event]))}, not one ${mode} step that said "${said}"`] };
  }
  const { txHash } = dying[0];
  const steps = status.filter((s) => s.label === label);
  const exits = Object.fromEntries(steps.map((s) => [s.mode, s.exit]));
  if (steps.length !== 2 || exits[mode] !== 137 || exits.recover !== 0) failures.push(`crash drill ${label}: steps exited ${JSON.stringify(exits)}, not ${mode} 137 (SIGKILL) and recover 0`);
  if (!(dying[0].rows ?? []).some((r) => r.tx_hash === txHash && r.state === "pending")) failures.push(`crash drill ${label}: the journal held no pending row for ${txHash} when the process died`);
  const recovered = events.filter((e) => e.mode === "recover");
  const landed = recovered.filter((e) => e.event === "landed");
  const resent = recovered.filter((e) => e.event === "broadcast").map((e) => e.txHash);
  if (landed.length !== 1) failures.push(`crash drill ${label}: the recovery logged ${landed.length} landings, not 1`);
  else {
    const { receipt, rows = [] } = landed[0];
    if (receipt?.txHash !== txHash) failures.push(`crash drill ${label}: the recovery landed ${receipt?.txHash}, not the journalled ${txHash}`);
    const attempts = rows.filter((r) => r.tx_hash === txHash);
    if (attempts.length !== 1 || attempts[0].state !== "landed") failures.push(`crash drill ${label}: the journal ends with ${JSON.stringify(attempts)} for ${txHash}, not one landed row`);
    if (raw.anchors?.[label]?.txHash !== txHash) failures.push(`crash drill ${label}: its anchor ${txHash} is not among the recorded anchors, so nothing verified it`);
  }
  const wantResent = mode === "kill-before" ? [txHash] : [];
  if (JSON.stringify(resent) !== JSON.stringify(wantResent)) failures.push(`crash drill ${label}: the recovery broadcast ${JSON.stringify(resent)}, not ${JSON.stringify(wantResent)}`);
  return { failures, fact: { label, mode, said, txHash, resent: resent.length } };
}

/**
 * What the gate established; every field is complete only when it returns no failure.
 * @typedef {object} Facts
 * @property {{ total: number, byKind: { 1: number, 2: number }, crash: number }} anchors
 * @property {Array<{ label: string, mode: string, said: string, txHash: string, resent: number }>} crashDrill
 * @property {Array<{ name: string, txHash: string, refusal: { code: number, message: string, data: string }, refusedBy: string }>} nodeNegatives
 * @property {number} verifierNegatives
 * @property {{ height: number, hash: string, anchors: [string, string], wallets: [string, string], round: number } | null} sameBlock
 * @property {Array<{ name: string, outcome: string }>} forgedDocuments
 * @property {{ name: string, version: string, resolved: string, integrity: string, sha256: string } | null} package
 * @property {string | null} trustRoot
 */

export function judge({ raw, verified, crash, crashStatus }) {
  const failures = [];
  const anchors = Object.entries(raw.anchors ?? {});
  /** @type {Facts} */
  const facts = { anchors: { total: 0, byKind: { 1: 0, 2: 0 }, crash: 0 }, crashDrill: [], nodeNegatives: [], verifierNegatives: 0, sameBlock: null, forgedDocuments: [], package: null, trustRoot: null };

  // The pack describes the deploy by its prepared record, so that record must be the deploy that
  // landed, never a prepare whose bytes a later run abandoned.
  const deploy = raw.deploy ?? {};
  if (deploy.prepared?.txHash !== deploy.txHash || deploy.prepared?.address !== deploy.address) {
    failures.push(`the registry deploy recorded as prepared, ${deploy.prepared?.txHash} at ${deploy.prepared?.address}, is not the deploy that landed, ${deploy.txHash} at ${deploy.address}`);
  }
  if (deploy.readback?.immutable !== true || deploy.readback?.byteEqual !== true) failures.push("the registry deploy's readback did not show the same immutable state from the indexer and the node");

  // The verify package came from a packed tarball, as npm recorded the install.
  const pkg = verified.package;
  if (!/^file:[^/]+\.tgz$/.test(pkg?.resolved ?? "") || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg?.integrity ?? "") || !/^[0-9a-f]{64}$/.test(pkg?.sha256 ?? "")) {
    failures.push(`the verifier recorded no install of the verify package from a packed tarball (${JSON.stringify(pkg ?? null)})`);
  } else facts.package = pkg;

  // Every recorded anchor is its own transaction, of a kind the registry writes.
  const named = new Map();
  for (const [name, a] of anchors) {
    if (named.has(a.txHash)) failures.push(`anchors ${named.get(a.txHash)} and ${name} record the same transaction ${a.txHash}`);
    else named.set(a.txHash, name);
    if (a.kind !== 1 && a.kind !== 2) failures.push(`anchor ${name}: kind ${a.kind} is not one the registry writes`);
  }

  // Every anchor outside the rotation drill: valid at consensus-verified, for the hash and the
  // commitment recorded.
  for (const [name, a] of anchors) {
    if (ROTATION_LABELS.includes(name)) continue;
    const v = verified.anchors?.[name];
    if (!isValid(v)) failures.push(`anchor ${name}: ${verdict(v)}`);
    else if (v.txHash !== a.txHash) failures.push(`anchor ${name}: the verifier checked ${v.txHash}, not the recorded ${a.txHash}`);
    else if (v.commitment !== a.commitment) failures.push(`anchor ${name}: the verifier read commitment ${v.commitment}, not the recorded ${a.commitment}`);
    else if (a.kind === 1 || a.kind === 2) {
      facts.anchors.total++;
      facts.anchors.byKind[a.kind]++;
    }
  }
  for (const [kind, min] of Object.entries(MIN_ANCHORS)) {
    if ((facts.anchors.byKind[kind] ?? 0) < min) failures.push(`${facts.anchors.byKind[kind] ?? 0} kind-${kind} anchors verified valid, fewer than ${min}`);
  }

  // Every anchor the crash drill landed is a recorded anchor, and each window behaved.
  for (const e of crash.filter((e) => e.event === "landed")) {
    if (raw.anchors?.[e.label]?.txHash !== e.receipt?.txHash) failures.push(`crash drill anchor ${e.label} (${e.receipt?.txHash}) is not among the recorded anchors`);
  }
  for (const label of Object.keys(CRASH_WINDOWS)) {
    const drill = crashDrill(label, crash, crashStatus, raw);
    failures.push(...drill.failures);
    if (drill.fact) facts.crashDrill.push(drill.fact);
  }
  facts.anchors.crash = facts.crashDrill.length;

  // Two wallets, one block, both anchors valid, and the verifier places both in that block.
  const pair = raw.sameBlock?.coLanded;
  const pairAnchors = (pair?.txHashes ?? []).map((t) => anchors.find(([, a]) => a.txHash === t));
  if (!pair || pairAnchors.length !== 2 || pairAnchors.some((x) => !x)) failures.push("no same-block pair was recorded among the anchors");
  else {
    const [[nameA, a], [nameB, b]] = pairAnchors;
    const [va, vb] = [verified.anchors?.[nameA], verified.anchors?.[nameB]];
    if (a.wallet === b.wallet || a.blockHeight !== pair.height || b.blockHeight !== pair.height) failures.push(`same-block pair ${nameA} and ${nameB}: wallets ${a.wallet} and ${b.wallet} at heights ${a.blockHeight} and ${b.blockHeight}, not two wallets in block ${pair.height}`);
    else if (!isValid(va) || !isValid(vb)) failures.push(`same-block pair ${nameA} and ${nameB}: not both verified valid`);
    else if (va.block?.height !== pair.height || vb.block?.height !== pair.height || va.block.hash !== vb.block.hash) {
      failures.push(`same-block pair ${nameA} and ${nameB}: the verifier places them in blocks ${va.block?.height} (${va.block?.hash}) and ${vb.block?.height} (${vb.block?.hash}), not both in block ${pair.height}`);
    } else facts.sameBlock = { height: pair.height, hash: va.block.hash, anchors: [nameA, nameB], wallets: [a.wallet, b.wallet], round: pair.round };
  }

  // The maintenance authority itself refused every maintenance update, and none of them landed:
  // Blockfrost's indexer lists none when run.ts asks, nor when the verifier asks.
  const negatives = raw.negatives ?? {};
  for (const name of Object.keys(negatives)) {
    if (!Object.hasOwn(NODE_NEGATIVES, name)) failures.push(`negative ${name} is not one of the maintenance updates the gate knows the refusal for`);
  }
  for (const [name, { data, refusedBy }] of Object.entries(NODE_NEGATIVES)) {
    const n = negatives[name];
    if (!n) {
      failures.push(`negative ${name} was not recorded`);
      continue;
    }
    const { refusal } = n;
    const asked = verified.refusedTransactions?.[name];
    const absent = `indexer: the indexer knows no transaction ${n.txHash}`;
    if (refusal?.code !== INVALID_TRANSACTION || refusal.message !== INVALID_TRANSACTION_MESSAGE || refusal.data !== data) {
      const shown = refusal?.data === undefined ? "" : ` (${typeof refusal.data === "string" ? refusal.data : JSON.stringify(refusal.data)})`;
      const got = refusal ? `the node answered ${refusal.code} ${refusal.message}${shown}` : `no refusal by the node was recorded (${n.unresolved ?? n.error ?? n.note ?? "accepted"})`;
      failures.push(`negative ${name}: ${got}, not ${INVALID_TRANSACTION} ${INVALID_TRANSACTION_MESSAGE} (${data}, ${refusedBy})`);
    } else if (n.onChain !== 0) failures.push(`negative ${name}: the indexer lists it ${n.onChain} times`);
    else if (asked?.txHash !== n.txHash || asked.status !== "invalid" || !(asked.failed ?? []).includes(absent)) {
      const answer = !asked ? "not verified" : asked.txHash !== n.txHash ? `about ${asked.txHash}` : verdict(asked);
      failures.push(`negative ${name}: Blockfrost, asked by the verifier, answered ${answer}, not invalid with "${absent}"`);
    } else facts.nodeNegatives.push({ name, txHash: n.txHash, refusal: { code: refusal.code, message: refusal.message, data: refusal.data }, refusedBy });
  }
  if (raw.negativesAfter?.registryStillImmutable !== true) failures.push("the registry state was not re-checked after the negatives");

  // The rotation drill: four anchors by two keys, in increasing blocks, with the expected verdict
  // under every document set.
  const heights = ROTATION_LABELS.map((l) => raw.anchors?.[l]?.blockHeight);
  if (heights.some((h) => typeof h !== "number") || heights.some((h, i) => i > 0 && h <= heights[i - 1])) failures.push(`the rotation anchors are not four anchors in increasing blocks (${JSON.stringify(heights)})`);
  for (const label of ROTATION_LABELS) {
    const key = raw.rotation?.keys?.[RELAY_OF[label]];
    if (!key || raw.anchors?.[label]?.author !== key) failures.push(`rotation anchor ${label}: written by ${raw.anchors?.[label]?.author}, not ${RELAY_OF[label]} (${key})`);
  }
  for (const [set, want] of Object.entries(ROTATION_EXPECTED)) {
    for (const [label, status] of Object.entries(want)) {
      const got = verified.rotation?.[set]?.[label];
      if (got?.status !== status || (status === "valid" && got.assurance !== "consensus-verified")) failures.push(`rotation ${set}, ${label}: ${verdict(got)}, expected ${status}`);
    }
  }

  // Each forged document got the verify package's answer from the check it targets.
  const forged = verified.forgedDocuments ?? {};
  for (const name of Object.keys(forged)) {
    if (!Object.hasOwn(FORGED_DOCUMENTS, name)) failures.push(`forged KNOWN_AUTHORS document "${name}" is not one the gate holds an answer for`);
  }
  for (const [name, want] of Object.entries(FORGED_DOCUMENTS)) {
    const got = forged[name]?.outcome;
    if (got !== want) failures.push(`forged KNOWN_AUTHORS document "${name}": ${got ?? "not tried"}, not ${want}`);
    else facts.forgedDocuments.push({ name, outcome: got });
  }

  // The drill's trust root is not one the verify package ships, and its documents name preprod alone.
  const shipped = verified.shippedTrustRoots;
  if (!Array.isArray(shipped)) failures.push("the verifier did not record the trust roots the verify package ships");
  else if (shipped.includes(verified.trustRoot)) failures.push(`the drill's trust root ${verified.trustRoot} is one the verify package ships`);
  else facts.trustRoot = verified.trustRoot;
  const networks = (verified.knownAuthorsDocuments ?? []).map((d) => d.networks);
  if (networks.length !== 3 || networks.some((n) => JSON.stringify(n) !== '["preprod"]')) {
    failures.push(`the drill's KNOWN_AUTHORS documents name the networks ${JSON.stringify(networks)}, not preprod alone in each of three`);
  }

  // Each verifier negative fails with its expected status, for its expected cause.
  for (const [name, [status, cause]] of Object.entries(VERIFIER_NEGATIVES)) {
    const got = verified.negatives?.[name];
    if (got?.status !== status || !(got.failed ?? []).some((f) => f.startsWith(`${cause}:`))) failures.push(`verifier negative "${name}": ${verdict(got)}, expected ${status} from the ${cause} check`);
    else facts.verifierNegatives++;
  }

  return { failures, facts };
}

// A crash drill that aborted before any kill point, archived unmodified in
// evidence/crash-drill-aborted-N/ (README.md runbook): its crash.log, crash.log.status and
// crash.err, their sha256sum in MANIFEST.sha256, and README.md, whose first paragraph the pack
// carries as the attempt's statement. Each archive arrives as every entry of its directory, a
// regular file as its sha256 and text and anything else as null. An attempt counts as aborted
// only if no step reached a kill point: no kill step logged, every logged recovery event found
// the crash journal empty, and every step exited non-zero but not 137, the SIGKILL a kill point
// dies by. One that reached a kill point is a pass of the drill, and the drill runs once.
const ABORTED_DRILL = /^crash-drill-aborted-([1-9]\d*)$/;
const ARCHIVED = ["crash.err", "crash.log", "crash.log.status"];
const SHA256SUM_LINE = /^([0-9a-f]{64}) [ *](.+)$/;
// The pack carries Node's "Name: message" headline of each uncaught error in crash.err, never a
// stack frame or an inspected object, with every token that holds a path separator replaced.
const ERROR_HEADLINE = /^[A-Za-z_$][\w$.]*(?: \[[A-Z0-9_]+\])?: \S/;
const PATH_TOKEN = /[^\s'"`(),]*[/\\][^\s'"`(),]*/g;
const ERROR_LINES = 5;
const ERROR_CHARS = 240;

function abortedDrill(name, files) {
  const failures = [];
  const refuse = (why) => failures.push(`aborted crash drill ${name}: ${why}`);
  if (!ABORTED_DRILL.test(name)) refuse("its name is not crash-drill-aborted-N");
  else if (!files) refuse("not a directory");
  if (failures.length) return { failures };
  const { "MANIFEST.sha256": manifest, "README.md": readme, ...archived } = files;
  for (const [file, f] of Object.entries(files)) if (f === null) refuse(`${file} is not a regular file`);
  for (const file of ["MANIFEST.sha256", "README.md"]) if (!Object.hasOwn(files, file)) refuse(`holds no ${file}`);
  if (failures.length) return { failures };

  const recorded = {};
  for (const line of manifest.text.split("\n").filter((l) => l.trim())) {
    const [, sha256, file] = SHA256SUM_LINE.exec(line) ?? [];
    if (!file) refuse(`its MANIFEST.sha256 holds "${line}", which is not a sha256sum line`);
    else if (Object.hasOwn(recorded, file)) refuse(`its MANIFEST.sha256 lists ${file} twice`);
    else recorded[file] = sha256;
  }
  if (failures.length) return { failures };
  const listed = Object.keys(recorded).sort();
  if (JSON.stringify(listed) !== JSON.stringify(ARCHIVED)) refuse(`its MANIFEST.sha256 lists ${listed.join(", ")}, not ${ARCHIVED.join(", ")}`);
  for (const [file, { sha256 }] of Object.entries(archived)) {
    if (!Object.hasOwn(recorded, file)) refuse(`${file} is not in its MANIFEST.sha256`);
    else if (sha256 !== recorded[file]) refuse(`${file} has sha256 ${sha256}, not the ${recorded[file]} its MANIFEST.sha256 records`);
  }
  for (const file of listed) if (!Object.hasOwn(archived, file)) refuse(`${file}, which its MANIFEST.sha256 lists, is missing`);
  const statement = readme.text
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!statement) refuse("its README.md opens with no paragraph");
  if (failures.length) return { failures };

  const log = parseCrashLog(archived["crash.log"].text);
  const kills = log.filter((e) => /^kill-/.test(e.mode));
  if (kills.length) refuse(`it reached a kill point (${kills.map((e) => `${e.mode} ${e.label}: "${e.event}"`).join("; ")}), so it is a pass of the drill, not an abort`);
  for (const e of log) {
    if (kills.includes(e) || (e.mode === "recover" && Array.isArray(e.rows) && e.rows.length === 0)) continue;
    refuse(`${e.mode} ${e.label} logged "${e.event}" with journal rows ${JSON.stringify(e.rows ?? null)}, not a recovery that found the journal empty`);
  }
  const lines = archived["crash.log.status"].text.split("\n").filter((l) => l.trim());
  if (!lines.length) refuse("its crash.log.status records no step");
  const steps = lines.map((line) => {
    const [step] = parseCrashStatus(line);
    if (!Object.hasOwn(CRASH_WINDOWS, step?.label ?? "") || (step.mode !== "recover" && step.mode !== CRASH_WINDOWS[step.label].mode)) refuse(`its crash.log.status holds "${line.trim()}", which is no step of the drill`);
    else if (step.exit === 0 || step.exit === 137) refuse(`${step.mode} ${step.label} exited ${step.exit}; a step of an aborted drill exits non-zero, and never 137, the SIGKILL of a kill point`);
    return step;
  });

  const errors = new Map();
  for (const line of archived["crash.err"].text.split("\n").filter((l) => ERROR_HEADLINE.test(l))) {
    const shown = line.replace(PATH_TOKEN, "<path>").trimEnd().slice(0, ERROR_CHARS);
    errors.set(shown, (errors.get(shown) ?? 0) + 1);
  }
  const distinct = [...errors].map(([line, times]) => ({ line, times }));
  return {
    failures,
    attempt: { archive: name, statement, sha256: recorded, steps, log, errors: { shown: distinct.slice(0, ERROR_LINES), notShown: Math.max(0, distinct.length - ERROR_LINES) } },
  };
}

/**
 * What the pack discloses of one aborted attempt.
 * @typedef {object} AbortedAttempt
 * @property {string} archive
 * @property {string} statement
 * @property {Record<string, string>} sha256
 * @property {Array<{ mode: string, label: string, exit: number }>} steps
 * @property {Array<Record<string, any>>} log
 * @property {{ shown: Array<{ line: string, times: number }>, notShown: number }} errors
 */

// Every aborted attempt archived beside the drill, in number order, numbered 1 to N with none
// missing; the pack discloses each one, and none unless every one passes.
/** @returns {{ failures: string[], attempts: AbortedAttempt[] }} */
export function abortedDrills(archives) {
  const judged = [...archives].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true })).map(({ name, files }) => abortedDrill(name, files));
  const failures = judged.flatMap((j) => j.failures);
  const numbers = archives.map(({ name }) => ABORTED_DRILL.exec(name)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  if (numbers.some((n, i) => n !== i + 1)) failures.push(`the aborted crash-drill archives are numbered ${numbers.join(", ")}, not 1 to ${numbers.length}`);
  return { failures, attempts: failures.length ? [] : judged.map((j) => j.attempt) };
}

// Every transaction a rehearsal journal saw land, other than the registry deploy, is a recorded
// anchor, and every recorded anchor went through a journal: the universe "every anchor" means.
export function unrecordedAnchors(raw, journalLanded) {
  const recorded = new Map(Object.entries(raw.anchors ?? {}).map(([name, a]) => [a.txHash, name]));
  const landed = new Set(journalLanded.filter((t) => t !== raw.deploy?.txHash));
  return [
    ...[...landed].filter((t) => !recorded.has(t)).map((t) => `transaction ${t} landed through a rehearsal journal and is not among the recorded anchors`),
    ...[...recorded].filter(([t]) => !landed.has(t)).map(([t, name]) => `anchor ${name} (${t}) is in no rehearsal journal as landed`),
  ];
}
