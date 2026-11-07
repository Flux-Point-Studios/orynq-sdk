import { lstatSync, mkdirSync } from "node:fs";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import * as L from "@midnightntwrk/ledger-v9";
import { DustAddress, MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from "@midnightntwrk/wallet-sdk-address-format";
import { WalletSeeds } from "@midnightntwrk/wallet-sdk-hd";
import { createKeystore, type UnshieldedKeystore } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { readPrivateFile, writePrivateFile, type MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export interface WalletAddresses {
  unshielded: string;
  shielded: string;
  dust: string;
}

// The secret halves of a wallet: HD account 0, index 0, roles Zswap, NightExternal and Dust,
// the derivation Midnight's published test vector pins. The wallet starts from `seeds`, from which
// each ledger derives its own keys; `zswap` and `dust` are ledger 9's. Callers must never log these
// objects.
export interface WalletSecrets {
  seeds: WalletSeeds;
  zswap: L.ZswapSecretKeys;
  dust: L.DustSecretKey;
  night: UnshieldedKeystore;
}

// Writes a fresh 24-word BIP39 mnemonic (256 bits from the platform CSPRNG) to a new file only
// its owner can read. Nothing about it is returned; derive what is public with walletAddresses.
export function createWalletMnemonicFile(path: string): void {
  writePrivateFile(path, generateMnemonic(wordlist, 256));
}

// Creates `path` as a directory only its owner can enter, or accepts one that already is.
export function ensurePrivateDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error(`${path} is not a directory`);
  if (process.getuid !== undefined && stat.uid !== process.getuid()) throw new Error(`${path} is not owned by the caller`);
  if (stat.mode & 0o077) throw new Error(`${path} can be entered by group or others`);
}

function seedOf(mnemonicFile: string): Uint8Array {
  const words = readPrivateFile(mnemonicFile).trim();
  if (words.split(/\s+/).length !== 24 || !validateMnemonic(words, wordlist)) {
    throw new Error(`${mnemonicFile} does not hold a valid 24-word BIP39 mnemonic`);
  }
  return mnemonicToSeedSync(words);
}

// Opens the wallet's secret keys from a mnemonic file only its owner can read. A failure names
// the file and never what it holds.
export function walletSecrets(mnemonicFile: string, network: MidnightNetwork): WalletSecrets {
  let seeds: WalletSeeds;
  try {
    seeds = WalletSeeds.fromMasterSeed(seedOf(mnemonicFile));
  } catch (error) {
    if ((error as Error).name === "SeedDerivationError") throw new Error(`${mnemonicFile}: account 0 index 0 cannot be derived`);
    throw error;
  }
  return {
    seeds,
    zswap: L.ZswapSecretKeys.fromSeed(seeds.shielded),
    dust: L.DustSecretKey.fromSeed(seeds.dust),
    night: createKeystore({ kind: "schnorr", secret: seeds.unshielded }, network),
  };
}

export function addressesOf(secrets: WalletSecrets, network: MidnightNetwork): WalletAddresses {
  const shielded = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(secrets.zswap.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(secrets.zswap.encryptionPublicKey),
  );
  return {
    unshielded: secrets.night.getBech32Address().asString(),
    shielded: MidnightBech32m.encode(network, shielded).asString(),
    dust: DustAddress.encodePublicKey(network, secrets.dust.publicKey),
  };
}

// The wallet's public addresses on `network`; the secret keys never leave this call.
export function walletAddresses(mnemonicFile: string, network: MidnightNetwork): WalletAddresses {
  return addressesOf(walletSecrets(mnemonicFile, network), network);
}
