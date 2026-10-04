import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync } from "node:fs";

// Reads a secret file, refusing a symlink, anything but a regular file the caller owns, and a
// file group or others can read or write. Errors name the path, never the content.
export function readPrivateFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${path} is not a regular file`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (process.getuid !== undefined && stat.uid !== process.getuid()) throw new Error(`${path} is not owned by the caller`);
    if (stat.mode & 0o077) throw new Error(`${path} can be read or written by group or others`);
    return readFileSync(fd, "utf8").replace(/\n$/, "");
  } finally {
    closeSync(fd);
  }
}

// Writes 32 fresh random bytes, as 64 hex characters, to a new file only its owner can read,
// and returns them. It never replaces an existing file or follows a symlink.
export function createSecretFile(path: string): Uint8Array {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${Buffer.from(secret).toString("hex")}\n`);
  } finally {
    closeSync(fd);
  }
  return secret;
}
