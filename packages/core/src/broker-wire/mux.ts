import { BrokerWireError } from "./errors.js";

// The stdio mux between a broker and the frontend process that owns its sockets or pipes, both
// directions: u32 length | u8 kind | u64 conn | payload, big-endian, where length counts kind, conn
// and payload. The frontend writes READY once, then OPEN, FRAME and CLOSE; the broker writes only
// FRAME (a reply) and CLOSE.

export const MUX_READY = 0;
export const MUX_OPEN = 1;
export const MUX_FRAME = 2;
export const MUX_CLOSE = 3;
export const MUX_MAX_PAYLOAD = 16 * 1024 * 1024;

export type MuxKind = typeof MUX_READY | typeof MUX_OPEN | typeof MUX_FRAME | typeof MUX_CLOSE;

export interface MuxMessage {
  readonly kind: MuxKind;
  readonly conn: bigint;
  readonly payload: Uint8Array;
}

const HEADER_BYTES = 13;
const PREFIX_BYTES = 9;
const MAX_LENGTH = PREFIX_BYTES + MUX_MAX_PAYLOAD;
const U64_MAX = (1n << 64n) - 1n;
const EMPTY = new Uint8Array(0);

function checkLength(length: number): void {
  if (length < PREFIX_BYTES || length > MAX_LENGTH) throw new BrokerWireError("MUX_LENGTH");
}

function checkKind(kind: number): void {
  if (kind !== MUX_READY && kind !== MUX_OPEN && kind !== MUX_FRAME && kind !== MUX_CLOSE) throw new BrokerWireError("MUX_KIND");
}

function checkMessage(kind: MuxKind, conn: bigint, payloadBytes: number): void {
  if (kind === MUX_READY && (conn !== 0n || payloadBytes !== 0)) throw new BrokerWireError("MUX_READY");
  if (kind === MUX_FRAME && payloadBytes === 0) throw new BrokerWireError("MUX_FRAME");
  if (kind === MUX_CLOSE && payloadBytes !== 0) throw new BrokerWireError("MUX_CLOSE");
}

export function encodeMuxMessage({ kind, conn, payload }: MuxMessage): Uint8Array {
  if (conn < 0n || conn > U64_MAX) throw new RangeError("conn must be a u64");
  checkKind(kind);
  checkLength(PREFIX_BYTES + payload.length);
  checkMessage(kind, conn, payload.length);
  const message = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(message.buffer);
  view.setUint32(0, PREFIX_BYTES + payload.length);
  view.setUint8(4, kind);
  view.setBigUint64(5, conn);
  message.set(payload, HEADER_BYTES);
  return message;
}

// Reassembles messages from arbitrary chunks. Each header is judged as its bytes arrive (length at
// 4, kind at 5, the kind's conn and payload rules at 13), so a refusal needs only the shortest
// prefix that shows it, and a payload buffer grows with the bytes that arrive (doubling, capped
// at the announced size). After a refusal every push throws it again.
export class MuxDecoder {
  private readonly header = new Uint8Array(HEADER_BYTES);
  private readonly view = new DataView(this.header.buffer);
  private headerBytes = 0;
  private payload = EMPTY;
  private payloadBytes = 0;
  private payloadLength = 0;
  private failure: BrokerWireError | undefined;

  get buffered(): number {
    return this.headerBytes + this.payloadBytes;
  }

  push(chunk: Uint8Array): MuxMessage[] {
    if (this.failure) throw this.failure;
    try {
      return this.read(chunk);
    } catch (error) {
      if (error instanceof BrokerWireError) this.failure = error;
      throw error;
    }
  }

  private read(chunk: Uint8Array): MuxMessage[] {
    const messages: MuxMessage[] = [];
    let at = 0;
    while (at < chunk.length) {
      if (this.headerBytes < HEADER_BYTES) {
        const take = Math.min(HEADER_BYTES - this.headerBytes, chunk.length - at);
        this.header.set(chunk.subarray(at, at + take), this.headerBytes);
        this.headerBytes += take;
        at += take;
        this.checkHeader();
        if (this.headerBytes < HEADER_BYTES) break;
        this.payloadLength = this.view.getUint32(0) - PREFIX_BYTES;
      }
      const take = Math.min(this.payloadLength - this.payloadBytes, chunk.length - at);
      this.reserve(this.payloadBytes + take);
      this.payload.set(chunk.subarray(at, at + take), this.payloadBytes);
      this.payloadBytes += take;
      at += take;
      if (this.payloadBytes < this.payloadLength) break;
      messages.push({ kind: this.view.getUint8(4) as MuxKind, conn: this.view.getBigUint64(5), payload: this.payload });
      this.headerBytes = 0;
      this.payload = EMPTY;
      this.payloadBytes = 0;
      this.payloadLength = 0;
    }
    return messages;
  }

  private checkHeader(): void {
    if (this.headerBytes >= 4) checkLength(this.view.getUint32(0));
    if (this.headerBytes >= 5) checkKind(this.view.getUint8(4));
    if (this.headerBytes === HEADER_BYTES) {
      checkMessage(this.view.getUint8(4) as MuxKind, this.view.getBigUint64(5), this.view.getUint32(0) - PREFIX_BYTES);
    }
  }

  private reserve(bytes: number): void {
    if (bytes <= this.payload.length) return;
    const grown = new Uint8Array(Math.min(this.payloadLength, Math.max(bytes, 2 * this.payload.length)));
    grown.set(this.payload.subarray(0, this.payloadBytes));
    this.payload = grown;
  }
}
