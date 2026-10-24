import { parseBatchSet, type VerifyOptions } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import type { Journal, JournalRow } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import type { RegistryOperator } from "../src/operator.js";
import type { openCensusState, CensusPlan } from "./census-state.js";
import type { openFollowerState } from "./follower-state.js";
import type { openStandingSession } from "./standing-session.js";
import type { openStandingDelivery } from "./standing-delivery.js";
import type { Census } from "./census.js";
import { publishCensusPlan, type PublicationOptions } from "./publisher.js";

export function openStandingController(options: {
  census: ReturnType<typeof openCensusState>; follower: ReturnType<typeof openFollowerState>;
  session: ReturnType<typeof openStandingSession>; delivery: ReturnType<typeof openStandingDelivery>;
  journal: Journal; operator: Pick<RegistryOperator, "prepare">; readCensus: () => Promise<Census>;
  publication: PublicationOptions; verify: () => VerifyOptions; clock?: () => number;
}) {
  const { census, follower, session, delivery, journal, operator, readCensus, verify } = options, scope = follower.scope();
  const publication = { network: options.publication.network, targets: options.publication.targets.map(target => ({ ...target })) };
  const clock = options.clock ?? Date.now;
  let active = false, fatal: Error | null = null;
  async function result(plan: CensusPlan, row: JournalRow) {
    if (row.state !== "landed") return { state: "pending" as const, commitment: plan.commitment, txHash: row.txHash };
    if (!Number.isSafeInteger(row.height) || row.height! < 1 || !row.blockHash) throw new Error("Standing landing lacks authenticated block evidence");
    await census.publishLandedSet({ network: scope.network, materiosGenesis: scope.genesis, commitment: plan.commitment,
      anchorIds: plan.plan.entries[0].batches.map(member => member.anchorId),
      midnight: { registry: scope.registry, txHash: row.txHash, blockHeight: row.height, blockHash: row.blockHash } }, { verify, publication });
    return { state: "landed" as const, commitment: plan.commitment, txHash: row.txHash };
  }
  return {
    async turn() {
      if (fatal) throw fatal;
      if (active) throw new Error("Standing controller is already active"); active = true;
      try {
        const retained = census.currentPlan(), staged = retained && census.publicationObjects(retained.commitment).find(object => object.kind === "sets");
        if (staged) {
          const set = parseBatchSet(JSON.parse(staged.body));
          await census.publishLandedSet(set, { verify, publication });
          return { state: "landed" as const, commitment: set.commitment, txHash: set.midnight.txHash };
        }
        const point = await session.ready(); await delivery.reconcile();
        const current = await readCensus(), plan = census.prepare(current, BigInt(point.chainTime), follower.commitments());
        if (!plan) return { state: "idle" as const };
        const key = { network: scope.network, registry: scope.registry, author: scope.author, kind: 3, commitment: plan.commitment, attribute: "00".repeat(32) };
        const held = journal.live(key);
        if (held) {
          if (held.state === "landed" || held.broadcasts > 0 || held.ttl.getTime() <= clock()) return result(plan, held);
          return result(plan, await delivery.submit(held.bytes, plan.commitment));
        }
        await publishCensusPlan(census, publication); census.confirm(plan.commitment, await readCensus());
        await session.ready();
        const entry = plan.plan.entries[0], prepared = await operator.prepare({ kind: 3, materiosGenesis: entry.materiosGenesis, batches: entry.batches });
        try { return await result(plan, await delivery.submit(prepared.bytes, plan.commitment)); }
        catch (error) {
          if (journal.live(key)?.txHash !== prepared.txHash) {
            fatal = new Error("Prepared standing bytes could not be journalled; process restart required", { cause: error }); throw fatal;
          }
          throw error;
        }
      } finally { active = false; }
    },
  };
}
