import { authorKey } from "./commitment.js";
import { readPrivateFile, writePrivateFile } from "./private-file.js";
import { toHex } from "./scale.js";

// A user's own Midnight anchoring keys: the author secret behind their author key, and the salt
// key a kind-2 anchor derives its hiding salt from. Both are fresh random 32-byte values. The
// tagged JSON format is distinct from the bare hex of a service author key file, so a tool that
// anchors with a user's key never accepts a service's.
export const USER_KEY_FORMAT = "orynq-midnight-user-key/v1";

export interface UserKey {
  authorSecret: Uint8Array;
  saltKey: Uint8Array;
  authorKey: string;
}

const FIELDS = ["format", "authorSecret", "saltKey"] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const random32 = () => crypto.getRandomValues(new Uint8Array(32));

// Writes a new user key file only its owner can read and returns the public author key.
export function createUserKeyFile(path: string): string {
  const authorSecret = random32();
  writePrivateFile(path, JSON.stringify({ format: USER_KEY_FORMAT, authorSecret: toHex(authorSecret), saltKey: toHex(random32()) }));
  return toHex(authorKey(authorSecret));
}

// Reads a user key file, refusing what readPrivateFile refuses, any other format, and a file
// whose keys are malformed or equal. Errors name the path and field, never a value.
export function readUserKey(path: string): UserKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivateFile(path));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || (parsed as { format?: unknown }).format !== USER_KEY_FORMAT) {
    throw new Error(`${path} is not a user key file (${USER_KEY_FORMAT})`);
  }
  const file = parsed as Record<string, unknown>;
  for (const field of Object.keys(file)) {
    if (!(FIELDS as readonly string[]).includes(field)) throw new Error(`${path} has unknown field ${field}`);
  }
  const key = (field: "authorSecret" | "saltKey") => {
    const value = file[field];
    if (typeof value !== "string" || !HEX64.test(value)) throw new Error(`${path}: ${field} must be 64 lowercase hex characters`);
    return value;
  };
  const [secret, salt] = [key("authorSecret"), key("saltKey")];
  if (secret === salt) throw new Error(`${path}: the salt key must differ from the author secret`);
  const authorSecret = new Uint8Array(Buffer.from(secret, "hex"));
  return { authorSecret, saltKey: new Uint8Array(Buffer.from(salt, "hex")), authorKey: toHex(authorKey(authorSecret)) };
}
