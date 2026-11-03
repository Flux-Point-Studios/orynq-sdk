import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A fresh directory below which a broker socket passes the client's directory rule, so not under a
// world-writable /tmp: the session's runtime directory where there is one, else the home directory.
export const privateDir = (prefix: string): string => mkdtempSync(join(process.env.XDG_RUNTIME_DIR || homedir(), prefix));
