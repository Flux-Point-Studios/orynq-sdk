import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { GUARD_LOG_GENESIS, nextGuardLogHead, type GuardEvent, type GuardHistory, type GuardLogHead } from "../../../src/index.js";

// Cross-process guard log for the child-process hosts. Each position is a file created with O_EXCL, so exactly one
// writer claims it; the head lives in its own file, so deleting event files cannot lower it.
export class FileGuardLog {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  append(event: GuardEvent): void {
    const next = nextGuardLogHead(this.head(), event);
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
