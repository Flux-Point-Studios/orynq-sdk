// A strict SCALE reader: every compact integer must be in its shortest form and a decode must
// consume its input exactly, so two different byte strings never decode to the same value.

// A compact integer at `offset`: its value and the offset after it, or the reason it is not a
// canonical compact integer there.
export function compactAt(bytes: Uint8Array, offset: number): { value: bigint; next: number } | { error: string } {
  const first = bytes[offset];
  if (first === undefined) return { error: `no compact integer at offset ${offset}` };
  const mode = first & 3;
  const width = mode === 0 ? 1 : mode === 1 ? 2 : mode === 2 ? 4 : (first >> 2) + 5;
  if (offset + width > bytes.length) return { error: `compact integer at offset ${offset} runs past the end` };
  if (mode === 0) return { value: BigInt(first >> 2), next: offset + 1 };
  let value = 0n;
  const from = mode === 3 ? offset + 1 : offset;
  for (let i = offset + width - 1; i >= from; i--) value = (value << 8n) | BigInt(bytes[i]!);
  if (mode !== 3) value >>= 2n;
  const min = mode === 1 ? 1n << 6n : mode === 2 ? 1n << 14n : 1n << 30n;
  if (value < min || (mode === 3 && bytes[offset + width - 1] === 0)) return { error: `non-canonical compact integer at offset ${offset}` };
  return { value, next: offset + width };
}

export class ScaleReader {
  private offset = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly what: string,
  ) {}

  private take(n: number): Uint8Array {
    if (this.offset + n > this.data.length) throw new Error(`${this.what}: needs ${n} more bytes at offset ${this.offset}, has ${this.data.length - this.offset}`);
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  get position(): number {
    return this.offset;
  }

  // The bytes read since `position` was `from`.
  since(from: number): Uint8Array {
    return this.data.subarray(from, this.offset);
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  u32(): number {
    const b = this.take(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16)) + b[3]! * 2 ** 24;
  }

  u64(): bigint {
    const b = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }

  bytes(n: number): Uint8Array {
    return this.take(n);
  }

  compact(): bigint {
    const read = compactAt(this.data, this.offset);
    if ("error" in read) throw new Error(`${this.what}: ${read.error}`);
    this.offset = read.next;
    return read.value;
  }

  compactNumber(): number {
    const v = this.compact();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${this.what}: compact integer ${v} is too large`);
    return Number(v);
  }

  vecBytes(): Uint8Array {
    return this.take(this.compactNumber());
  }

  vec<T>(item: (r: ScaleReader) => T): T[] {
    const n = this.compactNumber();
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(item(this));
    return out;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  end(): void {
    if (this.remaining !== 0) throw new Error(`${this.what} has ${this.remaining} trailing byte${this.remaining === 1 ? "" : "s"}`);
  }
}

export function encodeCompact(value: number | bigint): Uint8Array {
  const v = BigInt(value);
  if (v < 0n) throw new Error("compact integers are unsigned");
  if (v < 1n << 6n) return new Uint8Array([Number(v << 2n)]);
  if (v < 1n << 14n) {
    const x = Number((v << 2n) | 1n);
    return new Uint8Array([x & 0xff, x >> 8]);
  }
  if (v < 1n << 30n) {
    const x = Number((v << 2n) | 2n);
    return new Uint8Array([x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, x >>> 24]);
  }
  const out: number[] = [];
  for (let x = v; x > 0n; x >>= 8n) out.push(Number(x & 0xffn));
  return new Uint8Array([((out.length - 4) << 2) | 3, ...out]);
}

export function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}

export function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0, x = n; i < 8; i++, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
}

export function fromHex(hex: string, what: string): Uint8Array {
  const bare = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (bare.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(bare)) throw new Error(`${what} is not hex`);
  return new Uint8Array(Buffer.from(bare, "hex"));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}
