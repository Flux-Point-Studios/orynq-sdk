// Policy-root signing tool. Keep its owner-only seed separate from the online batch author;
// neither command prints a seed.
//   new-root-key SEED_FILE        writes a fresh owner-only Ed25519 seed, prints its public key
//   sign DOCUMENT_FILE SEED_FILE  prints the signed document as known-authors.json holds it
import { readFileSync } from "node:fs";
import { ed25519PublicKey } from "../src/ed25519.js";
import { knownAuthors, knownAuthorsSigningSummary, signKnownAuthors } from "../src/known-authors.js";
import { createSecretFile, readPrivateFile } from "../src/private-file.js";
import { fromHex, toHex } from "../src/scale.js";
import { parseStrictJson } from "../src/strict-json.js";
import { reviewCheckpointSigning } from "../src/signing-review.js";

const [command, ...args] = process.argv.slice(2);
const seedFrom = (path: string) => {
  const text = readPrivateFile(path);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path} must hold exactly 64 lowercase hex characters`);
  return fromHex(text, "seed");
};
try {
  if (command === "new-root-key" && args.length === 1) {
    process.stdout.write(`${toHex(ed25519PublicKey(createSecretFile(args[0]!)))}\n`);
  } else if (command === "inspect" && args.length === 1) {
    process.stdout.write(`${JSON.stringify(knownAuthorsSigningSummary(readFileSync(args[0]!, "utf8")), null, 2)}\n`);
  } else if (command === "sign" && (args.length === 4 || args.length === 6) && args[2] === "--reviewed-sha256" && (args.length === 4 || args[4] === "--checkpoint-proofs")) {
    const document = readFileSync(args[0]!, "utf8");
    const summary = knownAuthorsSigningSummary(document);
    process.stderr.write(`Known-authors signing review\n${JSON.stringify(summary, null, 2)}\n`);
    if (args[3] !== summary.documentSha256) throw new Error("The document differs from the reviewed SHA-256; inspect it before signing");
    const seed = seedFrom(args[1]!);
    const policy = knownAuthors({ trustRoots: [toHex(ed25519PublicKey(seed))] });
    const proofs = args[5] ? parseStrictJson(readFileSync(args[5], "utf8"), 64 * 1024 * 1024) : [];
    await reviewCheckpointSigning(document, proofs, policy);
    process.stdout.write(`${JSON.stringify([signKnownAuthors(document, seed)], null, 2)}\n`);
  } else {
    throw new Error("usage: known-authors.ts new-root-key SEED_FILE | inspect DOCUMENT_FILE | sign DOCUMENT_FILE SEED_FILE --reviewed-sha256 HASH [--checkpoint-proofs FILE]");
  }
} catch (error) {
  process.stderr.write(`known-authors: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
