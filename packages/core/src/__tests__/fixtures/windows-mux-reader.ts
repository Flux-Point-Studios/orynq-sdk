// FIXTURE, not production code: a verbatim copy of `message` and `MessageReader` from
// packages/credential-broker-windows/src/frontend.ts on branch feat/credential-broker-windows at
// 0571767 (the last commit to touch that file), exported so broker-wire-mux.test.ts can hold the
// core codec to what the shipped Windows host writes and reads.

export const message = (kind: number, conn: bigint, payload: Uint8Array = new Uint8Array()): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(9 + payload.length, 0);
  header.writeUInt8(kind, 4);
  header.writeBigUInt64BE(conn, 5);
  return Buffer.concat([header, payload]);
};

// Collects stdout chunks and concatenates only when a whole message is present, so a 16 MiB frame
// arriving in 64 KiB chunks is copied once rather than once per chunk.
export class MessageReader {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  next(): { kind: number; conn: bigint; payload: Buffer } | undefined {
    if (this.size < 4) return undefined;
    const length = this.contiguous(4).readUInt32BE(0);
    if (this.size < 4 + length) return undefined;
    const all = this.contiguous(this.size);
    const rest = all.subarray(4 + length);
    this.chunks = [rest];
    this.size = rest.length;
    return { kind: all.readUInt8(4), conn: all.readBigUInt64BE(5), payload: all.subarray(13, 4 + length) };
  }

  private contiguous(count: number): Buffer {
    const [first] = this.chunks;
    if (first && first.length >= count) return first;
    const joined = Buffer.concat(this.chunks);
    this.chunks = [joined];
    return joined;
  }
}
