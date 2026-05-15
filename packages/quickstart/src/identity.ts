/**
 * @summary Local sr25519 identity bootstrap for solo-dev quickstart.
 *
 * Generates a fresh BIP39 mnemonic on first run, derives an sr25519 keypair,
 * and persists the mnemonic to `~/.orynq/config.json` (or any caller-supplied
 * path) with 0600 permissions on POSIX systems. Subsequent calls reload the
 * same identity so the address stays stable across processes.
 *
 * This is intentionally pure-local: no network, no chain RPC, no faucet.
 * Anchoring + faucet drip belong in `bootstrap.ts` so callers who already
 * have an identity can skip identity generation entirely.
 *
 * Trust model: the mnemonic on disk is treated like any other developer
 * secret. The config file is created with 0600 perms; an explicit warning is
 * emitted via the returned `OrynqIdentity.warnings` array when the env
 * suggests a shared filesystem (which is reserved for a follow-up — kept
 * as `warnings: []` today so the public shape stays stable).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import {
  cryptoWaitReady,
  mnemonicGenerate,
  mnemonicValidate,
} from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/keyring";

/**
 * Solo-dev identity loaded from disk or freshly generated.
 *
 * Fields:
 *   - `mnemonic`     BIP39 12-word seed phrase. Required to sign on-chain
 *                    txs and blob-gateway uploads. Treat as a secret.
 *   - `address`      sr25519 SS58 address derived from `mnemonic`. Safe to
 *                    log; this is the public chain identity.
 *   - `generatedAt`  ISO timestamp of original generation.
 *   - `configPath`   Where the identity is persisted.
 *   - `freshlyGenerated`  True iff this call generated a new mnemonic (vs
 *                    reloading an existing one). Lets the CLI print "saved
 *                    new identity to..." only on the first run.
 *   - `warnings`     Non-fatal advisories from the loader. Empty today;
 *                    reserved for shared-FS / world-readable-perm checks.
 */
export interface OrynqIdentity {
  mnemonic: string;
  address: string;
  generatedAt: string;
  configPath: string;
  freshlyGenerated: boolean;
  warnings: string[];
}

export interface LoadOrCreateIdentityOptions {
  /**
   * Path to the persistent identity file. Defaults to
   * `${HOME}/.orynq/config.json`. The parent directory is created
   * recursively if it does not exist.
   */
  configPath?: string | undefined;

  /**
   * SS58 prefix for the encoded address. Defaults to 42 (generic Substrate).
   * Materios uses 42 in v6 preprod; pass a different value here if you're
   * targeting a chain with a custom prefix.
   */
  ss58Format?: number | undefined;
}

/**
 * Default config-file location: `~/.orynq/config.json`.
 *
 * Exposed so other code (`bootstrap.ts`, the CLI) can reference the same
 * default without duplicating the homedir join.
 */
export function defaultConfigPath(): string {
  return `${homedir()}/.orynq/config.json`;
}

interface OnDiskConfig {
  version: 1;
  mnemonic: string;
  address: string;
  generatedAt: string;
}

/**
 * Load an existing identity from `configPath`, or generate + persist a new
 * one if the file does not exist.
 *
 * Throws if the config file exists but cannot be parsed — better to fail
 * loudly than silently regenerate and orphan whatever identity used to be
 * there (and any MATRA balance on it).
 */
export async function loadOrCreateIdentity(
  opts: LoadOrCreateIdentityOptions = {},
): Promise<OrynqIdentity> {
  await cryptoWaitReady();

  const configPath = opts.configPath ?? defaultConfigPath();
  const ss58Format = opts.ss58Format ?? 42;
  const warnings: string[] = [];

  if (existsSync(configPath)) {
    let parsed: OnDiskConfig;
    try {
      const raw = readFileSync(configPath, "utf-8");
      parsed = JSON.parse(raw) as OnDiskConfig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `orynq identity config at ${configPath} is corrupt and cannot be parsed: ${msg}. ` +
          `Inspect the file by hand — do NOT delete it without first checking whether the ` +
          `mnemonic inside is still recoverable. If you want a fresh identity, move the file ` +
          `aside (e.g. mv ${configPath} ${configPath}.broken) and rerun.`,
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.mnemonic !== "string" ||
      typeof parsed.address !== "string"
    ) {
      throw new Error(
        `orynq identity config at ${configPath} is missing required fields (mnemonic, address). ` +
          `File contents may be from an older or unrelated tool. Move it aside and rerun.`,
      );
    }
    if (!mnemonicValidate(parsed.mnemonic)) {
      throw new Error(
        `orynq identity config at ${configPath} has an invalid mnemonic. ` +
          `Move it aside and rerun, or restore from your secure backup.`,
      );
    }
    const keyring = new Keyring({ type: "sr25519", ss58Format });
    const pair = keyring.addFromUri(parsed.mnemonic);
    if (pair.address !== parsed.address) {
      // Likely an SS58 prefix mismatch between when it was written and now.
      // Re-encode at the caller-specified prefix and continue, but warn.
      warnings.push(
        `address re-encoded under ss58Format=${ss58Format} (config had ${parsed.address})`,
      );
    }
    return {
      mnemonic: parsed.mnemonic,
      address: pair.address,
      generatedAt: parsed.generatedAt,
      configPath,
      freshlyGenerated: false,
      warnings,
    };
  }

  // No config — generate fresh.
  const mnemonic = mnemonicGenerate(12);
  const keyring = new Keyring({ type: "sr25519", ss58Format });
  const pair = keyring.addFromUri(mnemonic);
  const generatedAt = new Date().toISOString();

  const config: OnDiskConfig = {
    version: 1,
    mnemonic,
    address: pair.address,
    generatedAt,
  };

  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8" });
  if (process.platform !== "win32") {
    // Best-effort tighten perms. chmod is a no-op on Windows.
    chmodSync(configPath, 0o600);
  }

  return {
    mnemonic,
    address: pair.address,
    generatedAt,
    configPath,
    freshlyGenerated: true,
    warnings,
  };
}
