import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";

// Linux flock locks the open file description shared by parent and child. Once the utility
// acquires inherited fd3, its exit leaves the lock held by our descriptor until closeSync.
// Never unlink this stable inode: stale-PID recovery via check-then-unlink can delete a new
// owner's lock. The kernel releases an abandoned descriptor without any userspace reclamation.
export async function withResultsLock<T>(file: string, operation: () => T, waitMs = 5_000): Promise<T> {
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 60_000) throw new Error("invalid results writer lock deadline");
  const descriptor = openSync(`${file}.lock`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("unsafe results lock");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/flock", ["--exclusive", "--timeout", String(waitMs / 1000), "3"], { stdio: ["ignore", "ignore", "ignore", descriptor] });
      child.once("error", () => reject(new Error("cannot acquire results writer lock: Linux /usr/bin/flock is required")));
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${file}: results writer lock is still held; no result was overwritten`)));
    });
    // No await in the operation: only the atomic result-file read/append/rename holds the lock.
    return operation();
  } finally { closeSync(descriptor); }
}
