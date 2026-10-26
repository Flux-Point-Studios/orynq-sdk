import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readPrivateFile, writePrivateFile, type MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { openJournal } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";

// OS-account custody namespace: neither HOME nor a caller-chosen journal parent can move it.
// Same-UID code can intentionally edit this binding; preventing that requires a separate signer.
export function defaultAuthorBindingRoot(): string { return join(userInfo().homedir, ".orynq-midnight-journals"); }

export function authorJournal(network: MidnightNetwork, author: string, file: string, bindingRoot = defaultAuthorBindingRoot()) {
  try { mkdirSync(bindingRoot, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const root = lstatSync(bindingRoot);
  if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0) throw new Error("the author journal binding directory must be owned by this account and owner-only");
  const path = join(realpathSync(dirname(resolve(file))), resolve(file).split("/").at(-1)!);
  const binding = join(bindingRoot, `${network}-${author}.json`);
  const check = () => {
    const record: unknown = JSON.parse(readPrivateFile(binding));
    if (!record || typeof record !== "object" || (record as { path?: unknown }).path !== path) throw new Error("this author is already bound to another journal; reuse its canonical journal");
    const held = record as { device?: unknown; inode?: unknown };
    let stat;
    try { stat = lstatSync(path); } catch { throw new Error("the author's bound journal is missing; restore it before submitting"); }
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.dev !== held.device || stat.ino !== held.inode) throw new Error("the author's bound journal was replaced or is unsafe; restore it before submitting");
  };
  try { check(); return openJournal(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Open before publishing the binding; a crash can leave an empty journal, never a binding
  // that authorizes recreating a missing one. A complete, fsynced temporary record is linked
  // atomically so concurrent first callers cannot see an incomplete binding.
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.uid !== process.getuid?.() || (existing.mode & 0o077) !== 0) throw new Error("unsafe author journal");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const journal = openJournal(path);
  const temporary = join(bindingRoot, `.binding-${process.pid}-${randomBytes(16).toString("hex")}`);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("unsafe author journal");
    writePrivateFile(temporary, JSON.stringify({ path, device: stat.dev, inode: stat.ino }));
    try { linkSync(temporary, binding); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    check();
    for (const directory of [dirname(path), bindingRoot]) {
      const descriptor = openSync(directory, "r");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
    return journal;
  } catch (error) { journal.close(); throw error; }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
