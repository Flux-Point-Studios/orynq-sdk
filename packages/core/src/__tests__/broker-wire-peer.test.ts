import { describe, expect, it } from "vitest";
import { BrokerWireError, decodeOpenPayload, parsePeer, type Peer } from "../broker-wire/index.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

// The shape the Windows sidecar's json! builds for a client token.
const windows = {
  os: "windows",
  sid: "S-1-5-21-1004336348-1177238915-682003330-1001",
  logonLuid: "18446744073709551615",
  tsSessionId: 1,
  integrityRid: 0x2000,
  pidHint: 4242,
} as const satisfies Peer;

const linux = {
  os: "linux",
  uid: 1000,
  gid: 1000,
  pidHint: 4242,
  cgroup: "/orynq.slice/orynq-agents.slice/orynq-agent-00112233445566778899aabbccddeeff.service",
} as const satisfies Peer;

function refusal(value: unknown): BrokerWireError {
  try {
    parsePeer(value);
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerWireError);
    return error as BrokerWireError;
  }
  throw new Error(`accepted ${JSON.stringify(value)}`);
}

const field = (value: unknown) => {
  const error = refusal(value);
  expect(error.code).toBe("PEER_INVALID");
  return error.field;
};

describe("parsePeer", () => {
  it("returns a Windows peer exactly as the sidecar spells it", () => {
    expect(parsePeer(windows)).toEqual(windows);
    expect(parsePeer({ ...windows, pidHint: null })).toEqual({ ...windows, pidHint: null });
    const service = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    expect(parsePeer({ ...windows, sid: service })).toEqual({ ...windows, sid: service });
  });

  it("returns a Linux peer", () => {
    expect(parsePeer(linux)).toEqual(linux);
    expect(parsePeer({ ...linux, pidHint: null, cgroup: "/" })).toEqual({ ...linux, pidHint: null, cgroup: "/" });
  });

  it("refuses anything but a plain object naming a known os", () => {
    for (const value of [null, [], "peer", 1, new Map(), { ...linux, os: "darwin" }, { ...windows, os: undefined }]) {
      expect(field(value)).toBe("peer");
    }
    expect(field(Object.assign(Object.create({ inherited: 1 }), linux))).toBe("peer");
  });

  it("refuses an unknown key and every missing key, for both systems", () => {
    for (const peer of [windows, linux] as const) {
      expect(field({ ...peer, extra: 1 })).toBe("peer");
      for (const key of Object.keys(peer)) {
        const { [key as keyof typeof peer]: _, ...rest } = peer;
        expect(field(rest)).toBe("peer");
      }
    }
    expect(field({ ...linux, sid: windows.sid })).toBe("peer");
    expect(field({ ...windows, uid: 0 })).toBe("peer");
  });

  it("takes user and service SIDs only, in canonical form", () => {
    for (const sid of [
      "S-1-5-21-0-0-0-0",
      "S-1-5-21-4294967295-4294967295-4294967295-4294967295",
      "S-1-5-80-0-1-2-3-4",
    ]) {
      expect(parsePeer({ ...windows, sid }).os).toBe("windows");
    }
    for (const sid of [
      "S-1-5-18",
      "S-1-5-19",
      "S-1-5-32-544",
      "S-1-12-1-1-2-3-4",
      "S-1-5-21-1-2-3",
      "S-1-5-21-1-2-3-4-5",
      "S-1-5-80-1-2-3-4",
      "S-1-5-80-1-2-3-4-5-6",
      "S-1-5-21-01-2-3-4",
      "S-1-5-21-4294967296-2-3-4",
      "s-1-5-21-1-2-3-4",
      "S-1-5-21-1-2-3-4 ",
      "S-1-5-21-1-2-3-+4",
      "",
      1001,
    ]) {
      expect(field({ ...windows, sid })).toBe("sid");
    }
  });

  it("takes the logon LUID as a canonical decimal u64 string", () => {
    for (const logonLuid of ["0", "999", "18446744073709551615"]) {
      expect(parsePeer({ ...windows, logonLuid }).os).toBe("windows");
    }
    for (const logonLuid of ["", "01", "-1", "1e3", "1.0", " 1", "18446744073709551616", "99999999999999999999", 999, 0x3e7n]) {
      expect(field({ ...windows, logonLuid })).toBe("logonLuid");
    }
  });

  it.each(["tsSessionId", "integrityRid"] as const)("takes %s as a u32 number", key => {
    for (const value of [0, 0x4000, 4294967295]) {
      expect(parsePeer({ ...windows, [key]: value }).os).toBe("windows");
    }
    for (const value of [-1, -0, 1.5, 4294967296, Number.NaN, "1", null, 1n]) {
      expect(field({ ...windows, [key]: value })).toBe(key);
    }
  });

  it.each(["uid", "gid"] as const)("takes the Linux %s as a u32 number", key => {
    for (const value of [0, 4294967295]) {
      expect(parsePeer({ ...linux, [key]: value }).os).toBe("linux");
    }
    for (const value of [-1, -0, 1.5, 4294967296, "1000", null]) {
      expect(field({ ...linux, [key]: value })).toBe(key);
    }
  });

  it("takes pidHint as a u32 number or null on both systems", () => {
    for (const peer of [windows, linux] as const) {
      for (const pidHint of [0, 4294967295, null]) expect(parsePeer({ ...peer, pidHint }).pidHint).toBe(pidHint);
      for (const pidHint of [-1, 1.5, 4294967296, "4242", undefined]) expect(field({ ...peer, pidHint })).toBe("pidHint");
    }
  });

  it("takes a cgroup as an absolute path of non-empty components, at most 4096 UTF-8 bytes", () => {
    for (const cgroup of ["/", "/a", "/user.slice/user-1000.slice/session-2.scope", `/${"é".repeat(2047)}x`]) {
      expect(parsePeer({ ...linux, cgroup }).cgroup).toBe(cgroup);
    }
    for (const cgroup of ["", "a", "a/b", "//", "/a/", "/a//b", "/a\nb", "/a\0b", `/${"é".repeat(2048)}`, 1, null]) {
      expect(field({ ...linux, cgroup })).toBe("cgroup");
    }
  });

  it("answers from a fixed message that never quotes the input", () => {
    const error = refusal({ ...windows, sid: "S-1-5-21-secret" });
    expect(error.message).toBe("peer field sid is invalid");
    expect(error.message).not.toContain("secret");
  });
});

describe("decodeOpenPayload", () => {
  it("reads the literal bytes null as an anonymous client", () => {
    expect(decodeOpenPayload(utf8("null"))).toBeNull();
  });

  it("reads peer JSON as a peer", () => {
    expect(decodeOpenPayload(utf8(JSON.stringify(windows)))).toEqual(windows);
    expect(decodeOpenPayload(utf8(JSON.stringify(linux)))).toEqual(linux);
  });

  it("refuses anything that is not the literal null or one strict JSON peer", () => {
    for (const text of ["", " null", "null ", "Null", "[]", "{}", "1", `[${JSON.stringify(linux)}]`, `${JSON.stringify(linux)}x`]) {
      const error = (() => {
        try {
          decodeOpenPayload(utf8(text));
        } catch (thrown) {
          return thrown;
        }
        throw new Error(`accepted ${JSON.stringify(text)}`);
      })();
      expect(error).toBeInstanceOf(BrokerWireError);
      expect((error as BrokerWireError).code).toBe("PEER_INVALID");
    }
    expect(() => decodeOpenPayload(Uint8Array.of(0x7b, 0xff, 0x7d))).toThrow(BrokerWireError);
  });

  it("refuses a duplicate key, so one OPEN has one meaning", () => {
    const text = JSON.stringify(linux).replace('"uid":1000', '"uid":0,"uid":1000');
    expect(() => decodeOpenPayload(utf8(text))).toThrow(new BrokerWireError("PEER_INVALID", "peer"));
  });
});

describe("the broker-wire subpath", () => {
  it("is exported by the package and built by tsup, so a public frontend can import it at runtime", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports["./broker-wire"]).toEqual({
      import: { types: "./dist/broker-wire/index.d.ts", default: "./dist/broker-wire/index.js" },
      require: { types: "./dist/broker-wire/index.d.cts", default: "./dist/broker-wire/index.cjs" },
    });
    const tsup = readFileSync(new URL("../../tsup.config.ts", import.meta.url), "utf8");
    expect(tsup).toContain('"src/broker-wire/index.ts"');
  });
});

describe("isAccountSid", () => {
  it("accepts exactly the SIDs a Windows peer may carry", async () => {
    const { isAccountSid } = await import("../broker-wire/index.js");
    const sids = ["S-1-5-21-1-2-3-4", "S-1-5-80-1-2-3-4-5", "S-1-5-18", "S-1-5-21-01-2-3-4", "S-1-5-21-4294967296-2-3-4", "", 7];
    for (const sid of sids) {
      const peer = (() => {
        try {
          return parsePeer({ ...windows, sid });
        } catch (error) {
          expect(error).toBeInstanceOf(BrokerWireError);
          return undefined;
        }
      })();
      expect(isAccountSid(sid)).toBe(peer !== undefined);
    }
  });
});
