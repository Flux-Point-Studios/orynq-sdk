import type { Duplex } from "node:stream";
import { RpcError } from "./errors.js";
import { parseJsonPayload } from "./strict-json.js";

// Spec §6.1: a frame is a uint32 big-endian length N (1 <= N <= 16 MiB) and N bytes holding one
// JSON-RPC 2.0 request. The Unix sockets are Node Duplexes served by serveConnection; on Windows a
// sidecar does the length framing and hands each frame's payload to decodeRequest.

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const IDLE_TIMEOUT_MS = 300_000;

export type FrameErrorCode = "FRAME_EMPTY" | "FRAME_OVERSIZE";

export class FrameError extends Error {
  readonly code: FrameErrorCode;

  constructor(code: FrameErrorCode) {
    super(code === "FRAME_EMPTY" ? "frame length is zero" : `frame length exceeds ${MAX_FRAME_BYTES} bytes`);
    this.name = "FrameError";
    this.code = code;
  }
}

function checkLength(n: number): void {
  if (n === 0) throw new FrameError("FRAME_EMPTY");
  if (n > MAX_FRAME_BYTES) throw new FrameError("FRAME_OVERSIZE");
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  checkLength(payload.length);
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length);
  frame.set(payload, 4);
  return frame;
}

const EMPTY = new Uint8Array(0);

// Reassembles frames from arbitrary chunks. A header's length must pass checkLength, and the
// payload buffer then grows with the bytes that arrive (doubling, capped at the length), so a
// header alone costs nothing and a finished frame's buffer is exactly its length. After a
// framing error every push throws it again.
export class FrameDecoder {
  private readonly header = new Uint8Array(4);
  private headerBytes = 0;
  private length = 0;
  private payload = EMPTY;
  private payloadBytes = 0;
  private failure: FrameError | undefined;

  get buffered(): number {
    return this.headerBytes + this.payloadBytes;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.failure) throw this.failure;
    const frames: Uint8Array[] = [];
    let at = 0;
    while (at < chunk.length) {
      if (this.headerBytes < 4) {
        const take = Math.min(4 - this.headerBytes, chunk.length - at);
        this.header.set(chunk.subarray(at, at + take), this.headerBytes);
        this.headerBytes += take;
        at += take;
        if (this.headerBytes < 4) break;
        const n = new DataView(this.header.buffer).getUint32(0);
        try {
          checkLength(n);
        } catch (error) {
          this.failure = error as FrameError;
          throw error;
        }
        this.length = n;
        continue;
      }
      const take = Math.min(this.length - this.payloadBytes, chunk.length - at);
      this.reserve(this.payloadBytes + take);
      this.payload.set(chunk.subarray(at, at + take), this.payloadBytes);
      this.payloadBytes += take;
      at += take;
      if (this.payloadBytes === this.length) {
        frames.push(this.payload);
        this.payload = EMPTY;
        this.headerBytes = 0;
        this.payloadBytes = 0;
      }
    }
    return frames;
  }

  private reserve(bytes: number): void {
    if (bytes <= this.payload.length) return;
    const grown = new Uint8Array(Math.min(this.length, Math.max(bytes, 2 * this.payload.length)));
    grown.set(this.payload.subarray(0, this.payloadBytes));
    this.payload = grown;
  }
}

export type RequestId = string | number;

// Omitted params read as {} (JSON-RPC 2.0 lets a call without arguments omit them); any params
// present stay as decoded for the method's schema to judge with the request id.
export interface RpcRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params: unknown;
}

const ENVELOPE = new Set(["jsonrpc", "id", "method", "params"]);
const METHOD = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/;
const MAX_METHOD_BYTES = 64;
const MAX_ID_BYTES = 128;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

function isRequestId(id: unknown): id is RequestId {
  if (typeof id === "string") return id.length > 0 && utf8Length(id) <= MAX_ID_BYTES;
  return typeof id === "number" && Number.isInteger(id) && id >= 0 && !Object.is(id, -0);
}

// One request per frame: batches, notifications (no id) and null ids are refused.
export function decodeRequest(payload: Uint8Array): RpcRequest {
  checkLength(payload.length);
  const message = parseJsonPayload(payload);
  if (!isObject(message) || Object.keys(message).some(key => !ENVELOPE.has(key))) throw new RpcError("INVALID_REQUEST");
  const { jsonrpc, id, method } = message;
  if (jsonrpc !== "2.0" || !isRequestId(id)) throw new RpcError("INVALID_REQUEST");
  if (typeof method !== "string" || utf8Length(method) > MAX_METHOD_BYTES || !METHOD.test(method)) {
    throw new RpcError("INVALID_REQUEST");
  }
  return { id, method, params: Object.hasOwn(message, "params") ? message.params : {} };
}

function errorPayload(id: RequestId | null, error: RpcError): Uint8Array {
  const data = error.field === undefined ? {} : { data: { field: error.field } };
  return new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, error: { code: error.code, message: error.message, ...data } }));
}

// The handler returns the response payload; an RpcError it throws is answered from the error
// table, anything else closes the connection and rejects.
export type RequestHandler = (request: RpcRequest) => Promise<Uint8Array>;

// "reset" is any stream error, such as a client that disconnects while its reply is written.
export type CloseReason = "end" | "idle" | "frame" | "concurrent" | "reset";

// Serves one request at a time: a byte that arrives before the reply has drained closes the
// connection. The idle clock runs from the open, stops while a request runs, and restarts when
// the reply is queued and again when it has drained, so a reply the client leaves unread also
// closes the connection after IDLE_TIMEOUT_MS. Partial frames do not restart it. A client FIN
// ends the connection once a request already dispatched has been answered, which needs a
// half-open stream (net.createServer({ allowHalfOpen: true })); any other stream is refused.
// Settles once the stream is destroyed; it rejects only for a handler failure or a misused stream,
// and always with an Error: a thrown value that is not one becomes the cause of one.
export function serveConnection(stream: Duplex, handle: RequestHandler): Promise<CloseReason> {
  return new Promise<CloseReason>((resolve, reject) => {
    const decoder = new FrameDecoder();
    let busy = false;
    let ending = false;
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;

    const settle = (outcome: { reason: CloseReason } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      stream.off("data", onData);
      stream.destroy();
      if ("reason" in outcome) resolve(outcome.reason);
      else if (outcome.error instanceof Error) reject(outcome.error);
      else reject(new Error("request handling failed with a value that is not an Error", { cause: outcome.error }));
    };
    const finish = (reason: CloseReason) => settle({ reason });
    const fail = (error: unknown) => settle({ error });
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish("idle"), IDLE_TIMEOUT_MS);
    };
    const send = (payload: Uint8Array) =>
      new Promise<void>(done => {
        if (settled) return done();
        // A failed write also emits "error", which settles the connection as "reset".
        stream.write(encodeFrame(payload), () => done());
        arm();
      });
    const respond = async (frame: Uint8Array) => {
      let request: RpcRequest;
      try {
        request = decodeRequest(frame);
      } catch (error) {
        if (error instanceof RpcError) return send(errorPayload(null, error));
        throw error;
      }
      let payload: Uint8Array;
      try {
        payload = await handle(request);
      } catch (error) {
        if (error instanceof RpcError) return send(errorPayload(request.id, error));
        throw error;
      }
      return send(payload);
    };
    function onData(chunk: unknown) {
      if (!(chunk instanceof Uint8Array)) return fail(new TypeError("the stream must carry bytes"));
      if (busy) return finish("concurrent");
      let frames: Uint8Array[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        return error instanceof FrameError ? finish("frame") : fail(error);
      }
      if (frames.length === 0) return;
      if (frames.length > 1 || decoder.buffered > 0) return finish("concurrent");
      busy = true;
      clearTimeout(idle);
      respond(frames[0] as Uint8Array).then(() => {
        busy = false;
        if (ending) finish("end");
        else if (!settled) arm();
      }, fail);
    }

    stream.on("error", () => finish("reset"));
    if (!stream.allowHalfOpen) {
      fail(new TypeError("the stream must allow half-open so a reply can follow the client's FIN"));
      return;
    }
    stream.on("data", onData);
    stream.once("end", () => {
      ending = true;
      if (!busy) finish("end");
    });
    stream.once("close", () => finish("end"));
    arm();
  });
}
