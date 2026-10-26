import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

// The read/append/rename callback is synchronous: no chain or wallet operation holds this lock.
// A crashed owner's lock is reclaimed only after the OS proves that PID no longer exists.
export async function withResultsLock<T>(file: string, operation: () => T, waitMs = 5_000): Promise<T> {
  const lock = `${file}.lock`;
  const owner = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString("hex") });
  const deadline = performance.now() + waitMs;
  let descriptor: number;
  for (;;) {
    try { descriptor = openSync(lock, "wx", 0o600); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try {
      const metadata = lstatSync(lock);
      if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size > 256) throw new Error("unsafe results lock");
      const held = readFileSync(lock, "utf8");
      let record: { pid?: unknown; token?: unknown };
      try { record = JSON.parse(held); } catch { throw new Error("incomplete results lock"); }
      if (!Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || (record.pid as number) > 0x7fffffff || typeof record.token !== "string" || !/^[0-9a-f]{32}$/.test(record.token)) throw new Error("invalid results lock");
      try { process.kill(record.pid as number, 0); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          if (readFileSync(lock, "utf8") === held) unlinkSync(lock);
          continue;
        }
        if (code !== "EPERM") throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // A newly-created lock can be observed before its owner writes its small record.
      if (!(error instanceof Error) || error.message !== "incomplete results lock") throw error;
    }
    if (performance.now() >= deadline) throw new Error(`${file}: results writer lock is still held; no result was overwritten`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  try {
    writeFileSync(descriptor, owner); fsyncSync(descriptor);
    return operation();
  } finally {
    closeSync(descriptor);
    try { if (readFileSync(lock, "utf8") === owner) unlinkSync(lock); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
