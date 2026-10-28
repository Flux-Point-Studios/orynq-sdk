import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { GUARD_LOG_GENESIS, nextGuardLogHead, type GuardEvent, type GuardHistory, type GuardLogHead } from "../../../src/index.js";
import { formatGuardLogHead, sameGuardLogHead } from "../../../src/log.js";

// Cross-process guard log for the child-process hosts. An append first compares the stored head with the expected
// previous head; each position is then a file created with O_EXCL, so exactly one writer claims it. The head lives in
// its own file, so deleting event files cannot lower it.
export class FileGuardLog {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  append(event: GuardEvent, previous: GuardLogHead): GuardLogHead {
    const current = this.head();
    if (!sameGuardLogHead(current, previous)) {
      throw new Error(`guard log head is ${formatGuardLogHead(current)}, but the append expected ${formatGuardLogHead(previous)}`);
    }
    const next = nextGuardLogHead(current, event);
    const fd = openSync(this.eventFile(event.seq), "wx");
    try {
      writeSync(fd, serialize(event));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const tmp = join(this.dir, `head.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ count: next.count.toString(), hash: next.hash }), { flush: true });
    renameSync(tmp, join(this.dir, "head.json"));
    return next;
  }

  history(): GuardHistory {
    const events: GuardEvent[] = [];
    while (existsSync(this.eventFile(BigInt(events.length)))) {
      events.push(deserialize(readFileSync(this.eventFile(BigInt(events.length)))));
    }
    return { events, head: this.head() };
  }

  private head(): GuardLogHead {
    const file = join(this.dir, "head.json");
    if (!existsSync(file)) return GUARD_LOG_GENESIS;
    const { count, hash } = JSON.parse(readFileSync(file, "utf8"));
    return { count: BigInt(count), hash };
  }

  private eventFile(seq: bigint): string {
    return join(this.dir, `${seq}.v8`);
  }
}
