import { lstatSync, mkdirSync } from "node:fs";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import * as L from "@midnight-ntwrk/ledger-v8";
import { DustAddress, MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from "@midnight-ntwrk/wallet-sdk-address-format";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { createKeystore, type UnshieldedKeystore } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { readPrivateFile, writePrivateFile, type MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export interface WalletAddresses {
  unshielded: string;
  shielded: string;
  dust: string;
}

// The secret halves of a wallet: HD account 0, index 0, roles Zswap, NightExternal and Dust,
// the derivation Midnight's published test vector pins. Callers must never log these objects.
export interface WalletSecrets {
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
  const opened = HDWallet.fromSeed(seedOf(mnemonicFile));
  if (opened.type !== "seedOk") throw new Error(`${mnemonicFile}: its seed does not open an HD wallet`);
  const derived = opened.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (derived.type !== "keysDerived") throw new Error(`${mnemonicFile}: account 0 index 0 cannot be derived`);
  const keys = derived.keys;
  opened.hdWallet.clear();
  return {
    zswap: L.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]),
    dust: L.DustSecretKey.fromSeed(keys[Roles.Dust]),
    night: createKeystore(keys[Roles.NightExternal], network),
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
