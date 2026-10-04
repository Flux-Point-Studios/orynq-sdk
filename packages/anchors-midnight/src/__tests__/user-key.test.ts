import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorKey, createAuthorKeyFile } from "../commitment.js";
import { USER_KEY_FORMAT, createUserKeyFile, readUserKey } from "../user-key.js";
import { hex, random32 } from "./registry-call.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-user-key-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};

describe("user key files: an author secret and a salt key the user holds, never a service key", () => {
  it("createUserKeyFile writes two fresh random keys readable only by their owner and returns the public author key", () => {
    const path = join(dir, "me.json");
    const key = createUserKeyFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const read = readUserKey(path);
    expect(read.authorKey).toBe(key);
    expect(hex(authorKey(read.authorSecret))).toBe(key);
    expect(hex(read.saltKey)).not.toBe(hex(read.authorSecret));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ format: USER_KEY_FORMAT, authorSecret: hex(read.authorSecret), saltKey: hex(read.saltKey) });
    const other = readUserKey((createUserKeyFile(join(dir, "other.json")), join(dir, "other.json")));
    expect(hex(other.authorSecret)).not.toBe(hex(read.authorSecret));
    expect(hex(other.saltKey)).not.toBe(hex(read.saltKey));
  });

  it("createUserKeyFile never replaces an existing file", () => {
    const path = join(dir, "existing.json");
    writeFileSync(path, "keep me\n", { mode: 0o600 });
    expect(message(() => createUserKeyFile(path))).toMatch(/EEXIST/);
    expect(readFileSync(path, "utf8")).toBe("keep me\n");
  });

  it("readUserKey refuses a service author key file, other formats, open permissions and symlinks, without echoing a key", () => {
    const secret = hex(random32());
    const salt = hex(random32());
    const write = (name: string, text: string, mode = 0o600) => {
      const path = join(dir, name);
      writeFileSync(path, text, { mode: 0o600 });
      chmodSync(path, mode);
      return path;
    };
    const service = join(dir, "service.key");
    createAuthorKeyFile(service);
    const serviceSecret = readFileSync(service, "utf8").trim();
    const good = { format: USER_KEY_FORMAT, authorSecret: secret, saltKey: salt };
    const link = join(dir, "link.json");
    symlinkSync(write("target.json", JSON.stringify(good)), link);
    const cases: Array<[string, RegExp]> = [
      [service, /service\.key is not a user key file \(orynq-midnight-user-key\/v1\)/],
      [write("hex.json", `${secret}\n`), /hex\.json is not a user key file/],
      [write("format.json", JSON.stringify({ ...good, format: "orynq-midnight-user-key/v2" })), /format\.json is not a user key file/],
      [write("extra.json", JSON.stringify({ ...good, wallet: secret })), /extra\.json has unknown field wallet/],
      [write("short.json", JSON.stringify({ ...good, saltKey: salt.slice(2) })), /short\.json: saltKey must be 64 lowercase hex characters/],
      [write("same.json", JSON.stringify({ ...good, saltKey: secret })), /same\.json: the salt key must differ from the author secret/],
      [write("open.json", JSON.stringify(good), 0o644), /open\.json can be read or written by group or others/],
      [link, /link\.json is not a regular file/],
    ];
    for (const [path, expected] of cases) {
      const text = message(() => readUserKey(path));
      expect(text).toMatch(expected);
      for (const s of [secret, salt, serviceSecret]) expect(text).not.toContain(s.slice(4, 20));
    }
    expect(readUserKey(write("good.json", `${JSON.stringify(good)}\n`)).authorKey).toBe(hex(authorKey(secret)));
  });
});
