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

// The maintenance updates the node must refuse, and the refusal that counts: the node's own
// JSON-RPC answer 1010, Invalid Transaction. A transport failure, a timeout or any other code
// proves nothing about the registry.
export const NODE_NEGATIVES = ["ReplaceAuthority", "VerifierKeyRemove", "VerifierKeyInsert"];
export const INVALID_TRANSACTION = 1010;
export const MIN_ANCHORS = { 1: 10, 2: 2 };

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

// One journal crash window: the kill step must die by SIGKILL after writing the journal row, and
// the recovery must land exactly the bytes that row holds, broadcasting them again only if they
// never left.
function crashDrill(label, crash, status, raw) {
  const failures = [];
  const events = crash.filter((e) => e.label === label);
  const dying = events.filter((e) => e.mode.startsWith("kill-") && e.event.startsWith("dying"));
  if (dying.length !== 1) return { failures: [`crash drill ${label}: ${dying.length} kill steps logged, not 1`] };
  const { mode, txHash } = dying[0];
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
  return { failures, fact: { label, mode, txHash, resent: resent.length } };
}

export function judge({ raw, verified, crash, crashStatus }) {
  const failures = [];
  const anchors = Object.entries(raw.anchors ?? {});
  const facts = { anchors: { total: 0, byKind: { 1: 0, 2: 0 }, crash: 0 }, crashDrill: [], nodeNegatives: [], verifierNegatives: 0, sameBlock: null };

  if (raw.deploy?.readback?.immutable !== true || raw.deploy?.readback?.byteEqual !== true) failures.push("the registry deploy's readback did not show the same immutable state from the indexer and the node");

  // Every anchor outside the rotation drill: valid at consensus-verified, for the hash recorded.
  for (const [name, a] of anchors) {
    if (ROTATION_LABELS.includes(name)) continue;
    const v = verified.anchors?.[name];
    if (!isValid(v)) failures.push(`anchor ${name}: ${verdict(v)}`);
    else if (v.txHash !== a.txHash) failures.push(`anchor ${name}: the verifier checked ${v.txHash}, not the recorded ${a.txHash}`);
    else {
      facts.anchors.total++;
      facts.anchors.byKind[a.kind] = (facts.anchors.byKind[a.kind] ?? 0) + 1;
    }
  }
  for (const [kind, min] of Object.entries(MIN_ANCHORS)) {
    if ((facts.anchors.byKind[kind] ?? 0) < min) failures.push(`${facts.anchors.byKind[kind] ?? 0} kind-${kind} anchors verified valid, fewer than ${min}`);
  }

  // Every anchor the crash drill landed is a recorded anchor, and each window behaved.
  for (const e of crash.filter((e) => e.event === "landed")) {
    if (raw.anchors?.[e.label]?.txHash !== e.receipt?.txHash) failures.push(`crash drill anchor ${e.label} (${e.receipt?.txHash}) is not among the recorded anchors`);
  }
  for (const label of ["crash-before-broadcast", "crash-after-broadcast"]) {
    const drill = crashDrill(label, crash, crashStatus, raw);
    failures.push(...drill.failures);
    if (drill.fact) facts.crashDrill.push(drill.fact);
  }
  facts.anchors.crash = facts.crashDrill.length;

  // Two wallets, one block, both anchors valid.
  const pair = raw.sameBlock?.coLanded;
  const pairAnchors = (pair?.txHashes ?? []).map((t) => anchors.find(([, a]) => a.txHash === t));
  if (!pair || pairAnchors.length !== 2 || pairAnchors.some((x) => !x)) failures.push("no same-block pair was recorded among the anchors");
  else {
    const [[nameA, a], [nameB, b]] = pairAnchors;
    if (a.wallet === b.wallet || a.blockHeight !== pair.height || b.blockHeight !== pair.height) failures.push(`same-block pair ${nameA} and ${nameB}: wallets ${a.wallet} and ${b.wallet} at heights ${a.blockHeight} and ${b.blockHeight}, not two wallets in block ${pair.height}`);
    else if (!isValid(verified.anchors?.[nameA]) || !isValid(verified.anchors?.[nameB])) failures.push(`same-block pair ${nameA} and ${nameB}: not both verified valid`);
    else facts.sameBlock = { height: pair.height, anchors: [nameA, nameB], round: pair.round };
  }

  // The node itself refused every maintenance update, and none of them landed.
  const negatives = Object.entries(raw.negatives ?? {});
  for (const kind of NODE_NEGATIVES) {
    const found = negatives.filter(([name]) => name.startsWith(kind));
    if (found.length !== 1) {
      failures.push(`${found.length} ${kind} negatives recorded, not 1`);
      continue;
    }
    const [name, n] = found[0];
    if (n.refusal?.code !== INVALID_TRANSACTION) failures.push(`negative ${name}: ${n.refusal ? `the node answered ${n.refusal.code} ${n.refusal.message}` : `no refusal by the node was recorded (${n.unresolved ?? n.error ?? n.note ?? "accepted"})`}, not ${INVALID_TRANSACTION} Invalid Transaction`);
    else if (n.onChain !== 0) failures.push(`negative ${name}: the indexer lists it ${n.onChain} times`);
    else facts.nodeNegatives.push({ name, txHash: n.txHash, code: n.refusal.code, message: n.refusal.message, data: n.refusal.data });
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
  if (!String(verified.rotation?.forgedSignature).startsWith("refused:")) failures.push(`a KNOWN_AUTHORS document with a forged signature was ${verified.rotation?.forgedSignature ?? "not tried"}`);

  // Each verifier negative fails with its expected status, for its expected cause.
  for (const [name, [status, cause]] of Object.entries(VERIFIER_NEGATIVES)) {
    const got = verified.negatives?.[name];
    if (got?.status !== status || !(got.failed ?? []).some((f) => f.startsWith(`${cause}:`))) failures.push(`verifier negative "${name}": ${verdict(got)}, expected ${status} from the ${cause} check`);
    else facts.verifierNegatives++;
  }

  return { failures, facts };
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
