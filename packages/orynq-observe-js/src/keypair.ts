/**
 * sr25519 keypair management for AI observation observers.
 *
 * Thin wrapper around @polkadot/keyring + @polkadot/util-crypto for sr25519
 * sign/verify. The keyfile format on disk matches the Python `ObserverKeypair`
 * exactly so a single key can be used from either runtime:
 *
 *     {
 *       "scheme":  "sr25519-observer",   (or legacy "sr25519")
 *       "public":  "<hex 64>",
 *       "secret":  "<hex 128>"           (64 raw bytes)
 *     }
 *
 * The sr25519 secret is the 64-byte EXPANDED secret-key form
 * (`sr25519.pair_from_seed` output's second half in Python). @polkadot's
 * `Keyring.addFromUri` derives from a mini-secret seed; we use
 * `sr25519PairFromSeed` directly to round-trip with Python.
 */

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import {
  sr25519PairFromSeed,
  sr25519Sign,
  sr25519Verify,
  randomAsU8a,
  cryptoWaitReady,
  encodeAddress,
} from "@polkadot/util-crypto";
import { hexToU8a, u8aToHex } from "@polkadot/util";

/** Materios SS58 prefix. */
export const SS58_PREFIX = 42;

export class InvalidKeyfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKeyfileError";
  }
}

export class InvalidSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSeedError";
  }
}

interface Sr25519Pair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function normalizeSeedHex(seedHex: string): Uint8Array {
  if (typeof seedHex !== "string") {
    throw new InvalidSeedError("seedHex must be a string");
  }
  const s = seedHex.startsWith("0x") || seedHex.startsWith("0X")
    ? seedHex.slice(2)
    : seedHex;
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new InvalidSeedError(
      `seedHex must decode to exactly 32 bytes (got ${s.length / 2})`,
    );
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export class ObserverKeypair {
  static readonly SCHEME = "sr25519-observer";
  private static readonly LOAD_ACCEPTED_SCHEMES = ["sr25519-observer", "sr25519"];

  /**
   * Lazy init flag — @polkadot/util-crypto requires `await cryptoWaitReady()`
   * once before any sr25519 call. We track per-process so callers can build
   * a keypair without awaiting first; the actual sign/verify path waits.
   */
  private static _readyPromise: Promise<boolean> | null = null;

  private constructor(
    public readonly publicKey: Uint8Array,
    public readonly secretKey: Uint8Array,
  ) {
    if (publicKey.length !== 32) {
      throw new InvalidKeyfileError(
        `publicKey must be 32 bytes (got ${publicKey.length})`,
      );
    }
    if (secretKey.length !== 64) {
      throw new InvalidKeyfileError(
        `secretKey must be 64 bytes (got ${secretKey.length})`,
      );
    }
  }

  static async ready(): Promise<void> {
    if (!ObserverKeypair._readyPromise) {
      ObserverKeypair._readyPromise = cryptoWaitReady();
    }
    await ObserverKeypair._readyPromise;
  }

  static async generate(): Promise<ObserverKeypair> {
    await ObserverKeypair.ready();
    const seed = randomAsU8a(32);
    const pair = sr25519PairFromSeed(seed) as Sr25519Pair;
    return new ObserverKeypair(pair.publicKey, pair.secretKey);
  }

  static async fromSeedHex(seedHex: string): Promise<ObserverKeypair> {
    await ObserverKeypair.ready();
    const seed = normalizeSeedHex(seedHex);
    const pair = sr25519PairFromSeed(seed) as Sr25519Pair;
    return new ObserverKeypair(pair.publicKey, pair.secretKey);
  }

  static async load(path: string): Promise<ObserverKeypair> {
    await ObserverKeypair.ready();
    let blob: unknown;
    try {
      const raw = readFileSync(path, "utf-8");
      blob = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new InvalidKeyfileError(`could not read ${path}: ${msg}`);
    }
    if (!blob || typeof blob !== "object") {
      throw new InvalidKeyfileError("keyfile root is not a JSON object");
    }
    const b = blob as Record<string, unknown>;
    if (typeof b.scheme !== "string" ||
        !ObserverKeypair.LOAD_ACCEPTED_SCHEMES.includes(b.scheme)) {
      throw new InvalidKeyfileError(
        `unsupported scheme ${String(b.scheme)}, expected one of ${ObserverKeypair.LOAD_ACCEPTED_SCHEMES.join(",")}`,
      );
    }
    if (typeof b.public !== "string" || typeof b.secret !== "string") {
      throw new InvalidKeyfileError(
        "keyfile missing 'secret' or 'public' field",
      );
    }
    const publicKey = hexToU8a("0x" + b.public);
    const secretKey = hexToU8a("0x" + b.secret);
    return new ObserverKeypair(publicKey, secretKey);
  }

  save(path: string): void {
    const blob = {
      scheme: ObserverKeypair.SCHEME,
      public: u8aToHex(this.publicKey, undefined, false).replace(/^0x/, ""),
      secret: u8aToHex(this.secretKey, undefined, false).replace(/^0x/, ""),
    };
    writeFileSync(path, JSON.stringify(blob), { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  get publicHex(): string {
    return u8aToHex(this.publicKey, undefined, false).replace(/^0x/, "");
  }

  get secretHex(): string {
    return u8aToHex(this.secretKey, undefined, false).replace(/^0x/, "");
  }

  get ss58Address(): string {
    return encodeAddress(this.publicKey, SS58_PREFIX);
  }

  signBytes(payload: Uint8Array): Uint8Array {
    return sr25519Sign(payload, {
      publicKey: this.publicKey,
      secretKey: this.secretKey,
    });
  }

  verifyBytes(payload: Uint8Array, signature: Uint8Array): boolean {
    try {
      return sr25519Verify(payload, signature, this.publicKey);
    } catch {
      return false;
    }
  }
}
