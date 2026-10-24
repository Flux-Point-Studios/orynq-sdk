import type { KnownAuthors } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { followerPolicyDigest, type FollowerBlock } from "./follower-block.js";
import { StandingHistoryLost, type openFollowerState } from "./follower-state.js";
import { assertStandingClock, assertStandingFreshClock, assertStandingHostClock, type StandingClockPoint } from "./standing-clock.js";

export function openStandingSession(options: { state: ReturnType<typeof openFollowerState>; verifiedStart: FollowerBlock; authors: () => KnownAuthors; clock?: () => Pick<StandingClockPoint, "wallTime" | "monotonicMillis"> }) {
  const state = options.state, loadAuthors = options.authors, clock = options.clock ?? (() => ({ wallTime: Date.now(), monotonicMillis: performance.now() }));
  const proof = options.verifiedStart, start = { network: proof.network, policyDigest: proof.policyDigest, height: proof.block.height, hash: proof.block.hash, timestamp: proof.timestamp, runtime: proof.runtimeSpecVersion };
  const authors = loadAuthors(); state.observeStandingPolicy(authors);
  if (start.network !== state.chainView().network || start.policyDigest !== followerPolicyDigest(authors.checkpoints(start.network))) throw new Error("Standing startup proof has a different network or policy scope");
  if (start.runtime !== 1000300 || !Number.isSafeInteger(start.height) || start.height < 1 || !/^[a-f0-9]{64}$/.test(start.hash)) throw new Error("Invalid standing startup proof");
  const started = { ...clock(), chainTime: start.timestamp };
  assertStandingFreshClock(started);
  let lastClock = started, lastHead: { height: number; hash: string; timestamp: number } | null = null, fatal: Error | null = null;
  let lastReady: { height: number; hash: string; chainTime: number } | null = null;
  let rememberedAuthors = authors;
  const rememberedAdmissions = new Map<string, ReturnType<typeof state.admissions>[number]>();
  const hold: (message: string) => never = message => { fatal = new Error(`${message}; standing process restart required`); throw fatal; };
  function observeAuthors() {
    try {
      state.observeStandingPolicy(rememberedAuthors);
      const current = loadAuthors(); state.observeStandingPolicy(current); rememberedAuthors = current;
      return current;
    } catch { return hold("Standing authenticated policy continuity failed"); }
  }
  function checkAdmissions() {
    try { state.assertAdmissionHistory([...rememberedAdmissions.values()]); }
    catch (error) { if (error instanceof StandingHistoryLost) hold(error.message); throw error; }
  }
  function checkHead(head: ReturnType<typeof state.head>) {
    if (lastHead && (!head || head.height < lastHead.height || (head.height === lastHead.height && head.hash !== lastHead.hash))) hold("Standing follower rewound");
  }
  function readClock() {
    if (fatal) throw fatal;
    checkAdmissions();
    const current = { ...clock(), chainTime: start.timestamp };
    try { assertStandingHostClock(started, current); assertStandingHostClock(lastClock, current); }
    catch { return hold("Standing host-clock continuity failed"); }
    lastClock = current; return current;
  }
  async function currentPoint() {
    readClock();
    const view = state.chainView(), indexed = await view.indexedThrough();
    checkHead(state.head());
    if (!indexed && lastHead) hold("Standing follower history disappeared");
    if (!indexed) throw new Error("Standing warmup needs follower history");
    const startupHash = await view.finalHash(start.height), previousHash = lastHead ? await view.finalHash(lastHead.height) : null, head = state.head();
    checkHead(head);
    if (lastHead && previousHash !== lastHead.hash) hold("Standing follower snapshot rewound");
    if (!head || head.hash !== indexed.hash) throw new Error("Standing follower advanced during the check; retry with its new head");
    if (lastHead && (head.height < lastHead.height || (head.height === lastHead.height && head.hash !== lastHead.hash) || indexed.time.getTime() < lastHead.timestamp)) hold("Standing follower rewound");
    if (head.height < start.height) throw new Error("Standing warmup awaits startup block catch-up");
    if (startupHash !== start.hash) hold("Standing startup checkpoint is absent from durable history");
    const current = { ...readClock(), chainTime: indexed.time.getTime() };
    if (current.chainTime < start.timestamp) hold("Standing chain clock rewound");
    lastHead = { ...head, timestamp: current.chainTime };
    assertStandingClock(started, current);
    // At equality a lost attempt can still be exactly at its strict retirement margin.
    if (current.chainTime <= started.chainTime + 20 * 60_000) throw new Error("Standing warmup must pass the full restore TTL margin");
    lastReady = { ...head, chainTime: current.chainTime };
    return { ...current, ...head };
  }
  async function ready() {
    readClock(); observeAuthors();
    return currentPoint();
  }
  function reserveNow(bytes: Uint8Array, commitment: string) {
    const exact = new Uint8Array(bytes), current = lastReady;
    if (!current) throw new Error("Standing synchronous reservation requires successful readiness");
    const authors = observeAuthors(), time = readClock();
    checkHead(state.head());
    let admitted;
    try { admitted = state.reserveStandingAttempt(exact, { commitment, authors, started, current: { ...time, chainTime: current.chainTime, height: current.height, hash: current.hash }, retainedAdmissions: [...rememberedAdmissions.values()] }); }
    catch (error) { if (error instanceof StandingHistoryLost) hold(error.message); throw error; }
    const recorded = state.admissions().find(row => row.txHash === admitted.txHash);
    if (!recorded) hold("Standing admitted reservation was not retained");
    rememberedAdmissions.set(admitted.txHash, recorded);
    return { ...admitted, checkedAt: { wallTime: time.wallTime, monotonicMillis: time.monotonicMillis, chainTime: current.chainTime } };
  }
  return {
    ready,
    reserveNow,
    async reserve(bytes: Uint8Array, commitment: string) {
      const exact = new Uint8Array(bytes);
      await ready(); return reserveNow(exact, commitment);
    },
  };
}
