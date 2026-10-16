// The offline trust-root holder's tool for KNOWN_AUTHORS documents. Run on a machine no model
// drives; neither command prints a seed.
//   new-root-key SEED_FILE        writes a fresh owner-only Ed25519 seed, prints its public key
//   sign DOCUMENT_FILE SEED_FILE  prints the signed document as known-authors.json holds it
import { readFileSync } from "node:fs";
import { ed25519PublicKey } from "../src/ed25519.js";
import { signKnownAuthors } from "../src/known-authors.js";
import { createSecretFile, readPrivateFile } from "../src/private-file.js";
import { fromHex, toHex } from "../src/scale.js";

const [command, ...args] = process.argv.slice(2);
const seedFrom = (path: string) => {
  const text = readPrivateFile(path);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path} must hold exactly 64 lowercase hex characters`);
  return fromHex(text, "seed");
};
try {
  if (command === "new-root-key" && args.length === 1) {
    process.stdout.write(`${toHex(ed25519PublicKey(createSecretFile(args[0]!)))}\n`);
  } else if (command === "sign" && args.length === 2) {
    process.stdout.write(`${JSON.stringify([signKnownAuthors(readFileSync(args[0]!, "utf8"), seedFrom(args[1]!))], null, 2)}\n`);
  } else {
    throw new Error("usage: known-authors.ts new-root-key SEED_FILE | sign DOCUMENT_FILE SEED_FILE");
  }
} catch (error) {
  process.stderr.write(`known-authors: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
