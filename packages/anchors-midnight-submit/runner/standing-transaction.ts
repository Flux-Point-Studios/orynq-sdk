import { decodeAnchorTransaction, MIDNIGHT_REGISTRIES, type KnownAuthors, type MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { MAINNET_BATCH_AUTHOR_KEYS, RETIRED_AUTHOR_KEYS } from "../src/custody.js";
import { declaredFee, finalTransaction } from "../src/submission.js";

interface Scope { network: MidnightNetwork; registry: string; author: string; commitment: string }
interface Head { height: number; timestamp: number; runtimeSpecVersion: number }

export function assertStandingTransaction(bytes: Uint8Array, scope: Scope, head: Head, authors: KnownAuthors) {
  if (!["mainnet", "preprod"].includes(scope.network) || ![scope.registry, scope.author, scope.commitment].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error("Invalid standing transaction scope");
  if (scope.network === "mainnet" && scope.registry !== MIDNIGHT_REGISTRIES.mainnet[0]?.address) throw new Error("Standing registry is outside the approved mainnet generation");
  if (!Number.isSafeInteger(head.height) || head.height < 1 || !Number.isSafeInteger(head.timestamp) || head.timestamp < 0) throw new Error("Invalid authenticated standing head");
  if (head.runtimeSpecVersion !== 1000300) throw new Error("Standing runtime is unsupported");
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error("Invalid standing transaction bytes");
  const decoded = decodeAnchorTransaction(bytes, [scope.registry]), tx = finalTransaction(bytes), intents = [...(tx.intents?.values() ?? [])], call = decoded.calls[0];
  if (decoded.touches.length || decoded.calls.length !== 1 || call!.entryPoint !== "anchor" || call!.kind !== 3 || call!.author !== scope.author || call!.commitment !== scope.commitment) throw new Error("Transaction is outside the intended standing batch scope");
  if (intents.reduce((count, intent) => count + intent.actions.length, 0) !== 1) throw new Error("Standing transaction contains unrelated contract actions");
  if (tx.rewards !== undefined || tx.guaranteedOffer !== undefined || (tx.fallibleOffer?.size ?? 0) !== 0 || intents.some(intent => intent.guaranteedUnshieldedOffer !== undefined || intent.fallibleUnshieldedOffer !== undefined)) throw new Error("Standing transaction contains rewards or asset offers");
  if (intents.some(intent => (intent.dustActions?.registrations.length ?? 0) !== 0)) throw new Error("Standing transaction contains DUST registrations");
  const deadlines = intents.map(intent => intent.ttl.getTime());
  if (!deadlines.length || deadlines.some(ttl => !Number.isSafeInteger(ttl) || ttl <= head.timestamp || ttl > head.timestamp + 15 * 60_000)) throw new Error("Standing serialized TTL is outside the approved bound");
  const status = authors.author(scope.network, scope.author, head.height);
  if (RETIRED_AUTHOR_KEYS.includes(scope.author) || status.status !== "known" || status.role !== "batch" || (scope.network === "mainnet" && !MAINNET_BATCH_AUTHOR_KEYS.includes(scope.author))) throw new Error("Standing author is not a current pinned batch author");
  return { txHash: decoded.txHash, commitment: call!.commitment, ttl: Math.max(...deadlines), earliestTtl: Math.min(...deadlines), fee: declaredFee(tx) };
}
