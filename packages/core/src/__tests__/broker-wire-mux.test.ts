import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BrokerWireError,
  encodeMuxMessage,
  MUX_CLOSE,
  MUX_FRAME,
  MUX_MAX_PAYLOAD,
  MUX_OPEN,
  MUX_READY,
  MuxDecoder,
  type MuxKind,
  type MuxMessage,
} from "../broker-wire/index.js";
import { message as windowsMessage, MessageReader } from "./fixtures/windows-mux-reader.js";

interface Vectors {
  valid: { name: string; kind: number; conn: string; payloadUtf8: string; hex: string }[];
  large: { name: string; kind: number; conn: string; payloadBytes: number; fill: number; headerHex: string };
  invalid: { name: string; hex: string; code: string }[];
}

const vectors = JSON.parse(readFileSync(new URL("./fixtures/broker-mux-vectors.json", import.meta.url), "utf8")) as Vectors;
const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const utf8 = (text: string) => new TextEncoder().encode(text);
const asMessage = (v: { kind: number; conn: string; payloadUtf8: string }): MuxMessage => ({
  kind: v.kind as MuxKind,
  conn: BigInt(v.conn),
  payload: utf8(v.payloadUtf8),
});

function largeBytes(): Uint8Array {
  const { headerHex, payloadBytes, fill } = vectors.large;
  const header = hex(headerHex);
  const bytes = new Uint8Array(header.length + payloadBytes).fill(fill);
  bytes.set(header);
  return bytes;
}

function thrown(f: () => unknown): BrokerWireError {
  try {
    f();
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerWireError);
    return error as BrokerWireError;
  }
  throw new Error("accepted");
}

describe("mux constants", () => {
  it("name the four kinds and a 16 MiB payload bound", () => {
    expect([MUX_READY, MUX_OPEN, MUX_FRAME, MUX_CLOSE]).toEqual([0, 1, 2, 3]);
    expect(MUX_MAX_PAYLOAD).toBe(16 * 1024 * 1024);
  });
});

describe("encodeMuxMessage", () => {
  it.each(vectors.valid)("writes $name byte for byte as the Windows sidecar does", vector => {
    expect(Buffer.from(encodeMuxMessage(asMessage(vector))).toString("hex")).toBe(vector.hex);
  });

  it("writes a full 16 MiB FRAME, whose length is 9 + 16 MiB", () => {
    const { kind, conn, payloadBytes, fill } = vectors.large;
    const payload = new Uint8Array(payloadBytes).fill(fill);
    const encoded = encodeMuxMessage({ kind: kind as MuxKind, conn: BigInt(conn), payload });
    expect(encoded.length).toBe(13 + MUX_MAX_PAYLOAD);
    expect(Buffer.compare(encoded, largeBytes())).toBe(0);
  });

  it("refuses what the decoder refuses", () => {
    const one = Uint8Array.of(0x7b);
    const cases: [MuxMessage, string][] = [
      [{ kind: 4 as MuxKind, conn: 1n, payload: one }, "MUX_KIND"],
      [{ kind: MUX_READY, conn: 1n, payload: new Uint8Array() }, "MUX_READY"],
      [{ kind: MUX_READY, conn: 0n, payload: one }, "MUX_READY"],
      [{ kind: MUX_FRAME, conn: 1n, payload: new Uint8Array() }, "MUX_FRAME"],
      [{ kind: MUX_FRAME, conn: 1n, payload: new Uint8Array(MUX_MAX_PAYLOAD + 1) }, "MUX_LENGTH"],
      [{ kind: MUX_OPEN, conn: 1n, payload: new Uint8Array(MUX_MAX_PAYLOAD + 1) }, "MUX_LENGTH"],
      [{ kind: MUX_CLOSE, conn: 1n, payload: one }, "MUX_CLOSE"],
    ];
    for (const [message, code] of cases) expect(thrown(() => encodeMuxMessage(message)).code).toBe(code);
  });

  it("refuses a conn that is not a u64", () => {
    for (const conn of [-1n, 1n << 64n]) {
      expect(() => encodeMuxMessage({ kind: MUX_CLOSE, conn, payload: new Uint8Array() })).toThrow(RangeError);
    }
  });
});

describe("MuxDecoder", () => {
  it.each(vectors.valid)("reads $name whole and byte by byte", vector => {
    const bytes = hex(vector.hex);
    expect(new MuxDecoder().push(bytes)).toEqual([asMessage(vector)]);
    const decoder = new MuxDecoder();
    const messages = [...bytes].flatMap(byte => decoder.push(Uint8Array.of(byte)));
    expect(messages).toEqual([asMessage(vector)]);
    expect(decoder.buffered).toBe(0);
  });

  it("reads every valid vector from one stream and keeps a partial tail", () => {
    const stream = Buffer.concat(vectors.valid.map(v => hex(v.hex)));
    const decoder = new MuxDecoder();
    expect(decoder.push(stream.subarray(0, stream.length - 3))).toEqual(vectors.valid.slice(0, -1).map(asMessage));
    expect(decoder.buffered).toBe(10);
    expect(decoder.push(stream.subarray(stream.length - 3))).toEqual([asMessage(vectors.valid.at(-1)!)]);
  });

  it("accepts a full 16 MiB FRAME and returns its payload in a buffer of exactly that size", () => {
    const bytes = largeBytes();
    const decoder = new MuxDecoder();
    const messages: MuxMessage[] = [];
    for (let at = 0; at < bytes.length; at += 65_536) messages.push(...decoder.push(bytes.subarray(at, at + 65_536)));
    expect(messages).toHaveLength(1);
    const [frame] = messages;
    expect(frame!.kind).toBe(MUX_FRAME);
    expect(frame!.conn).toBe(5n);
    expect(frame!.payload.byteLength).toBe(MUX_MAX_PAYLOAD);
    expect(frame!.payload.buffer.byteLength).toBe(MUX_MAX_PAYLOAD);
    expect(frame!.payload.every(byte => byte === vectors.large.fill)).toBe(true);
  });

  it.each(vectors.invalid)("refuses $name as $code from its shortest prefix", ({ hex: text, code }) => {
    const bytes = hex(text);
    expect(thrown(() => new MuxDecoder().push(bytes)).code).toBe(code);
    const decoder = new MuxDecoder();
    for (const byte of bytes.subarray(0, -1)) expect(decoder.push(Uint8Array.of(byte))).toEqual([]);
    expect(thrown(() => decoder.push(bytes.subarray(-1))).code).toBe(code);
  });

  it("allocates nothing for a payload a header announces until its bytes arrive", () => {
    const decoder = new MuxDecoder();
    expect(decoder.push(largeBytes().subarray(0, 14))).toEqual([]);
    expect(decoder.buffered).toBe(14);
  });

  it("does not keep a view of the caller's chunk", () => {
    const bytes = hex(vectors.valid[4]!.hex);
    const [message] = new MuxDecoder().push(bytes);
    bytes.fill(0);
    expect(message!.payload).toEqual(utf8("{"));
  });

  it("rethrows its first refusal on every later push", () => {
    const decoder = new MuxDecoder();
    const first = thrown(() => decoder.push(hex("0000000904")));
    expect(thrown(() => decoder.push(hex(vectors.valid[0]!.hex)))).toBe(first);
    expect(thrown(() => decoder.push(new Uint8Array()))).toBe(first);
  });

  it("answers from fixed messages that never quote the input", () => {
    const messages = vectors.invalid.map(({ hex: text }) => thrown(() => new MuxDecoder().push(hex(text))).message);
    expect(new Set(messages)).toEqual(
      new Set([
        "mux message length is outside 9 to 9 + 16 MiB",
        "mux message kind is unknown",
        "mux READY must carry conn 0 and no payload",
        "mux FRAME must carry 1 byte to 16 MiB",
        "mux CLOSE must carry no payload",
      ]),
    );
  });
});

// The shipped Windows host decodes the sidecar's stdout with MessageReader and encodes its replies
// with `message`; neither validates, so agreement is checked on every valid vector.
describe("the Windows host's mux code (fixture copy)", () => {
  it.each(vectors.valid)("reads $name as the core decoder does, whole and byte by byte", vector => {
    const bytes = Buffer.from(vector.hex, "hex");
    for (const chunks of [[bytes], [...bytes].map(byte => Buffer.of(byte))]) {
      const reader = new MessageReader();
      const read: MuxMessage[] = [];
      for (const chunk of chunks) {
        reader.push(chunk);
        for (let next = reader.next(); next; next = reader.next()) {
          read.push({ kind: next.kind as MuxKind, conn: next.conn, payload: new Uint8Array(next.payload) });
        }
      }
      expect(read).toEqual(new MuxDecoder().push(bytes));
    }
  });

  it("reads a full 16 MiB FRAME as the core decoder does", () => {
    const bytes = Buffer.from(largeBytes());
    const reader = new MessageReader();
    reader.push(bytes);
    const next = reader.next()!;
    const [core] = new MuxDecoder().push(bytes);
    expect({ kind: next.kind, conn: next.conn }).toEqual({ kind: core!.kind, conn: core!.conn });
    expect(Buffer.compare(next.payload, core!.payload)).toBe(0);
  });

  it.each(vectors.valid)("writes $name as the core encoder does", vector => {
    const { kind, conn, payload } = asMessage(vector);
    expect(new Uint8Array(windowsMessage(kind, conn, payload))).toEqual(encodeMuxMessage({ kind, conn, payload }));
  });
});
