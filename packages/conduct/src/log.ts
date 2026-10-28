import { createHash } from "node:crypto";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import { guardEventData, snapshotGuardEvent, type GuardEvent } from "./events.js";

export const GUARD_LOG_DOMAIN = "orynq:conduct:guard:log:v1|";

export interface GuardLogHead {
  readonly count: bigint;
  readonly hash: string;
}

export interface GuardHistory {
  readonly events: readonly GuardEvent[];
  readonly head: GuardLogHead;
}

export const GUARD_LOG_GENESIS: GuardLogHead = Object.freeze({ count: 0n, hash: "0".repeat(64) });

export function readGuardLogHead(source: GuardLogHead): GuardLogHead {
  const { count, hash } = source;
  if (typeof count !== "bigint" || count < 0n || count > 1n << 64n || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("guard log head must be { count: bigint in [0, 2^64], hash: 64 lowercase hex }");
  }
  return Object.freeze({ count, hash });
}

export function nextGuardLogHead(head: GuardLogHead, event: GuardEvent): GuardLogHead {
  const current = readGuardLogHead(head);
  const snapshot = snapshotGuardEvent(event);
  if (snapshot.seq !== current.count) {
    throw new Error(`cannot append guard event seq ${snapshot.seq} at log length ${current.count}`);
  }
  const hash = createHash("sha256")
    .update(GUARD_LOG_DOMAIN)
    .update(Buffer.from(current.hash, "hex"))
    .update(canonicalize(guardEventData(snapshot)))
    .digest("hex");
  return Object.freeze({ count: current.count + 1n, hash });
}

// Reference implementation of the guard event sink contract for tests and single-process hosts.
export class MemoryGuardLog {
  private readonly events: GuardEvent[] = [];
  private head: GuardLogHead = GUARD_LOG_GENESIS;

  append(event: GuardEvent): void {
    const snapshot = snapshotGuardEvent(event);
    this.head = nextGuardLogHead(this.head, snapshot);
    this.events.push(snapshot);
  }

  history(): GuardHistory {
    return { events: [...this.events], head: this.head };
  }
}
