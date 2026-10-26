import { headerFromRpc, headerHash, rpcOnlySource, type BlockRef, type KnownAuthors, type RpcHeader } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { followerPolicyDigest, openFollowerReader, type FollowerBlock } from "./follower-block.js";
import type { openFollowerState } from "./follower-state.js";
import { assertStandingFreshClock } from "./standing-clock.js";

export interface FollowerStartupDiagnostic {
  phase: "policy" | "head" | "finality" | "clock";
  outcome: "start" | "success" | "failure";
  category: "cancelled" | "deadline" | "request-budget" | "byte-budget" | "policy" | "clock" | "source-or-integrity" | null;
  elapsedMs: number;
  requests: number;
  responseBytes: number;
}

export function openFollowerCatchup(options: { state: ReturnType<typeof openFollowerState>; node: string; authors: () => KnownAuthors; signal?: AbortSignal; clock?: () => { wallTime: number; monotonicMillis: number }; startupDiagnostic?: (event: FollowerStartupDiagnostic) => void }) {
  const { state, signal } = options, scope = state.scope(), loadAuthors = options.authors;
  const clock = options.clock ?? (() => ({ wallTime: Date.now(), monotonicMillis: performance.now() }));
  const initial = loadAuthors(), checkpoints = initial.checkpoints(scope.network), day = 86_400_000, maximumBytes = 64 * 1024 * 1024;
  state.observeStandingPolicy(initial);
  if (followerPolicyDigest(checkpoints) !== scope.policyDigest) throw new Error("Follower original checkpoint policy differs");
  const budget = { requests: 256, bytes: maximumBytes, abort: new AbortController() };
  const source = rpcOnlySource({ network: scope.network, node: options.node, operator: "standing-follower", hints: [], registries: [], ...(signal ? { signal } : {}), httpBudget: budget });
  const pending = new Set<Promise<unknown>>(), original = source.node;
  function track<T>(operation: Promise<T>) {
    pending.add(operation); operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
  }
  source.node = { call: (method, params) => track(original.call(method, params)), batch: calls => track(original.batch(calls)) };
  const reader = openFollowerReader({ source, checkpoints });
  let active = false, startup: FollowerBlock | null = null, candidate: number | null = null, distance = 14_400;
  let fatal: Error | null = null;
  let rememberedAuthors = initial;
  let rememberedHead = state.head();
  async function turn<T>(run: () => Promise<T>) {
    if (fatal) throw fatal;
    if (active) throw new Error("Follower turn is already active"); active = true;
    budget.requests = 256; budget.bytes = maximumBytes; budget.abort = new AbortController();
    const timer = setTimeout(() => budget.abort.abort("turn-deadline"), 90_000);
    try { signal?.throwIfAborted(); return await run(); }
    finally { clearTimeout(timer); budget.abort.abort("turn-complete"); await Promise.allSettled([...pending]); active = false; }
  }
  function policy() {
    let authors: KnownAuthors;
    try { state.rememberStandingPolicy(rememberedAuthors); authors = loadAuthors(); state.observeStandingPolicy(authors); rememberedAuthors = authors; }
    catch (error) { fatal = new Error("Follower policy continuity failed; process restart required", { cause: error }); throw fatal; }
    if (followerPolicyDigest(authors.checkpoints(scope.network)) !== scope.policyDigest) throw new Error("Follower checkpoint changes require retained-history migration");
    const windows = authors.authors(scope.network).filter(row => row.key === scope.author && row.role === "batch");
    if (!windows.length) throw new Error("Follower author has no retained batch history window");
    return Math.max(1, Math.min(...windows.map(row => row.validFrom)));
  }
  async function reference(hash: unknown): Promise<{ ref: BlockRef; parentHash: string }> {
    if (typeof hash !== "string" || !/^0x[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid follower block hash hint");
    const header = headerFromRpc(await source.node.call<RpcHeader>("chain_getHeader", [hash]));
    if (Buffer.from(headerHash(header)).toString("hex") !== hash.slice(2)) throw new Error("Follower header differs from its hash hint");
    return { ref: { height: header.number, hash: hash.slice(2) }, parentHash: Buffer.from(header.parentHash).toString("hex") };
  }
  async function probe(ref: BlockRef, parentHash: string) {
    let result: FollowerBlock | null = null;
    for await (const block of reader.range({ after: { height: ref.height - 1, hash: parentHash }, end: ref })) result = block;
    if (!result) throw new Error("Follower probe did not return a complete block"); return result;
  }
  function coverage() {
    const result = state.coverage(), head = result.head;
    if (rememberedHead && (!head || head.height < rememberedHead.height || (head.height === rememberedHead.height && head.hash !== rememberedHead.hash))) { fatal = new Error("Follower history rewound; process restart required"); throw fatal; }
    rememberedHead = head && { height: head.height, hash: head.hash }; return result;
  }
  return {
    async start() {
      return turn(async () => {
        if (startup) throw new Error("Follower startup was already captured");
        const started = performance.now();
        let phase: FollowerStartupDiagnostic["phase"] = "policy";
        // Only fixed categories and local counters leave this boundary, never provider errors,
        // file contents, endpoint URLs or policy values. Work and freshness limits stay intact.
        const report = (outcome: FollowerStartupDiagnostic["outcome"], category: FollowerStartupDiagnostic["category"] = null) => options.startupDiagnostic?.({
          phase, outcome, category, elapsedMs: Math.min(86_400_000, Math.max(0, Math.floor(performance.now() - started))),
          requests: 256 - budget.requests, responseBytes: maximumBytes - budget.bytes,
        });
        const enter = (next: typeof phase) => { phase = next; report("start"); };
        try {
          enter("policy"); policy();
          enter("head"); const hint = await reference(await source.node.call("chain_getFinalizedHead"));
          enter("finality"); const verified = await probe(hint.ref, hint.parentHash);
          enter("policy"); policy();
          enter("clock"); assertStandingFreshClock({ ...clock(), chainTime: verified.timestamp });
          startup = structuredClone(verified); report("success"); return verified;
        } catch (error) {
          const reason = budget.abort.signal.reason;
          report("failure", signal?.aborted ? "cancelled" : reason === "turn-deadline" ? "deadline" : reason === "request-budget" || reason === "byte-budget" ? reason : phase === "policy" ? "policy" : phase === "clock" ? "clock" : "source-or-integrity");
          throw error;
        }
      });
    },
    async turn() {
      return turn(async () => {
        if (!startup) throw new Error("Follower requires authenticated startup first");
        const authorFloor = policy(), current = coverage(), required = Math.min(authorFloor, current.earliestAttempt?.height ?? authorFloor);
        if (!current.floor) {
          if (current.earliestAttempt) throw new Error("Follower lost attempt coverage; retained-history repair required");
          const first = Math.min(...checkpoints.map(row => row.startsAfter.height)) + 1;
          if (required < first) throw new Error("Follower history precedes original checkpoints; earlier authenticated policy required");
          candidate ??= Math.min(required, Math.max(first, startup.block.height - distance));
          const hint = await reference(await source.node.call("chain_getBlockHash", [candidate]));
          if (hint.ref.height !== candidate) throw new Error("Follower floor height hint differs");
          const floor = await probe(hint.ref, hint.parentHash), latestRequired = policy();
          if (floor.block.height > latestRequired) { candidate = null; throw new Error("Follower retained history window changed during its floor probe"); }
          if (floor.timestamp > startup.timestamp - day) {
            if (candidate === first) throw new Error("Follower day precedes original checkpoints; retained-history repair required");
            distance *= 2; candidate = Math.max(first, Math.min(candidate - 1, startup.block.height - distance));
            return { state: "search" as const, blocks: 0, head: null };
          }
          state.recordVerifiedBlock(floor); coverage();
          return { state: "floor" as const, blocks: 1, head: state.head() };
        }
        if (current.floor.timestamp > startup.timestamp - day || current.floor.height > required || (current.earliestAttempt && current.head!.height < current.earliestAttempt.height)) throw new Error("Follower floor is insufficient; retained-history repair required");
        let range = current.replay;
        if (!range) {
          const hint = await reference(await source.node.call("chain_getFinalizedHead")), after = { height: current.head!.height, hash: current.head!.hash };
          if (hint.ref.height <= after.height) return { state: "idle" as const, blocks: 0, head: after };
          const height = Math.min(after.height + 32, hint.ref.height);
          const end = height === hint.ref.height ? hint.ref : (await reference(await source.node.call("chain_getBlockHash", [height]))).ref;
          if (end.height !== height) throw new Error("Follower endpoint height hint differs");
          range = { after, end };
        }
        let blocks = 0;
        for await (const block of reader.range(range)) {
          if (current.floor.height > policy()) throw new Error("Follower history window requires retained-floor repair");
          state.recordVerifiedBlock(block); blocks++; coverage();
        }
        return { state: "progress" as const, blocks, head: state.head() };
      });
    },
  };
}
