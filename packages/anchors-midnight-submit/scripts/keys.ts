// Creates an operator's wallets and author keys and derives what is public from them. No
// command prints a mnemonic or a secret: only addresses, author keys and booleans leave it.
//   private-dir DIR                                creates DIR (0700), or accepts it if it already is
//   new-wallet MNEMONIC_FILE NETWORK               writes a fresh 24-word mnemonic (0600), prints its addresses
//   new-author KEY_FILE                            writes a fresh 32-byte author secret (0600), prints its author key
//   addresses MNEMONIC_FILE NETWORK [--equals F]   prints the addresses, or whether they equal F's "addresses"
import { readFileSync } from "node:fs";
import { createAuthorKeyFile, type MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { createWalletMnemonicFile, ensurePrivateDir, walletAddresses } from "../src/keys.js";

const network = (name: string | undefined): MidnightNetwork => {
  if (name !== "mainnet" && name !== "preprod") throw new Error(`the network must be mainnet or preprod, not ${name}`);
  return name;
};
const print = (value: unknown) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 1)}\n`);

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "private-dir" && args.length === 1) {
    ensurePrivateDir(args[0]!);
  } else if (command === "new-wallet" && args.length === 2) {
    const net = network(args[1]);
    createWalletMnemonicFile(args[0]!);
    print(walletAddresses(args[0]!, net));
  } else if (command === "new-author" && args.length === 1) {
    print(createAuthorKeyFile(args[0]!));
  } else if (command === "addresses" && (args.length === 2 || (args.length === 4 && args[2] === "--equals"))) {
    const addresses = walletAddresses(args[0]!, network(args[1]));
    if (args.length === 2) print(addresses);
    else {
      const recorded = (JSON.parse(readFileSync(args[3]!, "utf8")) as { addresses: Partial<Record<keyof typeof addresses, string>> }).addresses;
      const same = (["unshielded", "shielded", "dust"] as const).every((role) => recorded[role] === addresses[role]);
      print(String(same));
      if (!same) process.exitCode = 1;
    }
  } else {
    throw new Error("usage: keys.ts private-dir DIR | new-wallet MNEMONIC_FILE NETWORK | new-author KEY_FILE | addresses MNEMONIC_FILE NETWORK [--equals FILE]");
  }
} catch (error) {
  process.stderr.write(`keys: ${(error as Error).message}\n`);
  process.exitCode = 2;
}
