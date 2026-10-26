import type { Journal, JournalRow } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { finalTransaction } from "../src/submission.js";
import { nodeRefusal } from "../src/broadcast.js";
import type { OperatorWallet } from "../src/wallet.js";
import type { openFollowerState } from "./follower-state.js";
import type { openStandingSession } from "./standing-session.js";
import type { openCensusState } from "./census-state.js";
import type { Census } from "./census.js";
import { publishCensusPlan, type PublicationOptions } from "./publisher.js";
import { assertStandingFreshClock, assertStandingHostClock } from "./standing-clock.js";

export function openStandingDelivery(options: {
  wallet: Pick<OperatorWallet, "network" | "addresses" | "submit" | "saveState">;
  follower: ReturnType<typeof openFollowerState>; session: ReturnType<typeof openStandingSession>;
  census: ReturnType<typeof openCensusState>; journal: Journal;
  readCensus: () => Promise<Census>; publication: PublicationOptions;
  clock?: () => { wallTime: number; monotonicMillis: number };
}) {
  const { wallet, follower, session, census, journal } = options, scope = follower.scope(), payer = wallet.addresses.unshielded;
  const rawSubmit = wallet.submit.bind(wallet), save = wallet.saveState.bind(wallet), readCensus = options.readCensus;
  const publication = { network: options.publication.network, targets: options.publication.targets.map(target => ({ ...target })) };
  const clock = options.clock ?? (() => ({ wallTime: Date.now(), monotonicMillis: performance.now() }));
  if (wallet.network !== scope.network || publication.network !== scope.network || !payer) throw new Error("Standing delivery network or payer scope differs");
  const refused = new Set<string>();
  let active = false, fatal: Error | null = null;
  let invocation: { bytes: Uint8Array; txHash: string; commitment: string } | null = null;
  const hold: (message: string, cause?: unknown) => never = (message, cause) => { fatal = new Error(`${message}; standing process restart required`, { cause }); throw fatal; };
  function enter() { if (fatal) throw fatal; if (active) throw new Error("Standing delivery is already active"); active = true; }
  function checkRow(row: JournalRow) {
    const attempt = follower.attempt(row.txHash);
    if (!attempt) throw new Error("Unknown recovered journal row has no prebroadcast provenance");
    if (row.ttl.getTime() !== attempt.ttl) hold("Standing journal serialized TTL differs from provenance");
  }
  function checkPending() { for (const row of journal.pending()) checkRow(row); }
  async function saveWallet() {
    try { if ((await save())?.saved !== true) hold("Standing wallet persistence failed"); }
    catch (error) { if (error === fatal) throw error; hold("Standing wallet persistence failed", error); }
  }
  async function broadcast(bytes: Uint8Array) {
    const request = invocation; invocation = null;
    if (!request || !Buffer.from(request.bytes).equals(bytes)) throw new Error("Standing delivery has no exact single-use permit");
    const exact = new Uint8Array(bytes);
    follower.assertAdmitted(exact);
    const plan = census.currentPlan();
    if (!plan || plan.commitment !== request.commitment) throw new Error("Standing census plan changed before publication");
    await publishCensusPlan(census, publication);
    const fresh = await readCensus(); census.confirm(request.commitment, fresh);
    const current = census.currentPlan(); if (!current || current.commitment !== request.commitment || current.state !== "confirmed") throw new Error("Standing confirmed census plan changed before delivery");
    const confirmed = await session.reserve(exact, request.commitment);
    checkPending();
    const permittedAt = clock();
    try { assertStandingHostClock(confirmed.checkedAt, permittedAt); }
    catch (error) { hold("Standing host-clock continuity failed before permission", error); }
    assertStandingFreshClock({ ...confirmed.checkedAt, ...permittedAt });
    const expires = permittedAt.monotonicMillis + 30_000;
    await session.reserve(exact, request.commitment);
    const transaction = finalTransaction(exact);
    const admitted = session.reserveNow(exact, request.commitment), time = clock();
    try { assertStandingHostClock(admitted.checkedAt, time); }
    catch (error) { hold("Standing host-clock continuity failed at delivery", error); }
    assertStandingFreshClock({ ...admitted.checkedAt, ...time });
    if (fatal) throw fatal;
    if (admitted.txHash !== request.txHash || refused.has(admitted.txHash) || !Number.isSafeInteger(time.wallTime) || !Number.isFinite(time.monotonicMillis) || time.monotonicMillis >= expires || time.wallTime >= admitted.earliestTtl) throw new Error("Standing delivery permit or serialized TTL expired");
    let failure: Error | null = null;
    try { await rawSubmit(transaction); }
    catch (error) {
      try {
        if (nodeRefusal(error)) { refused.add(admitted.txHash); failure = new Error("Standing node refusal forbids reusing these bytes", { cause: error }); }
        else failure = new Error("Standing transport or wallet delivery remains unresolved", { cause: error });
      } catch (classificationError) { fatal = new Error("Standing refusal classification failed; standing process restart required", { cause: classificationError }); failure = fatal; }
    }
    await saveWallet();
    if (failure) throw failure;
  }
  return {
    async submit(input: Uint8Array, commitment: string): Promise<JournalRow> {
      enter();
      try {
        if (!(input instanceof Uint8Array) || !input.length || input.length > 16 * 1024 * 1024) throw new Error("Invalid standing delivery bytes");
        const exact = new Uint8Array(input), plan = census.currentPlan();
        if (!plan || plan.commitment !== commitment || plan.plan.registry !== scope.registry || plan.plan.entries[0].materiosGenesis !== scope.genesis) throw new Error("Standing delivery differs from the active census scope");
        checkPending();
        const admitted = await session.reserve(exact, commitment);
        if (refused.has(admitted.txHash)) throw new Error("Standing node refusal forbids retrying these bytes");
        const key = { network: scope.network, registry: scope.registry, author: scope.author, kind: 3, commitment, attribute: "00".repeat(32) };
        const existing = journal.live(key); if (existing) { checkRow(existing); follower.assertRecorded(existing.bytes); }
        await saveWallet();
        invocation = { bytes: new Uint8Array(exact), txHash: admitted.txHash, commitment };
        return await journal.submitOnce(key, { txHash: admitted.txHash, chain: follower.chainView(),
          prepare: async () => ({ bytes: new Uint8Array(exact), ttl: new Date(admitted.ttl), payer }), broadcast });
      } finally { invocation = null; active = false; }
    },
    async reconcile(): Promise<JournalRow[]> {
      enter();
      try { checkPending(); await session.ready(); checkPending(); return await journal.reconcile(follower.chainView()); }
      finally { invocation = null; active = false; }
    },
  };
}
