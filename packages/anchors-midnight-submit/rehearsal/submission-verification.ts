// The live preprod submitter still performs the real SDK consensus verification. This local
// policy authenticates only the drill's fresh preprod authors and immutable registry deployment;
// its root is separate from the rotation/revocation policy whose verdicts the pack measures.
import { existsSync } from "node:fs";
import {
  authorKey, createAuthorKeyFile, openKnownAuthors, readAuthorSecret, signKnownAuthors,
  verifyMidnightAnchor, REGISTRY_VERIFIER_KEY_SHA256,
  type MidnightSource, type RegistryInfo,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import checkpoint from "../../anchors-midnight/src/__tests__/fixtures/preprod-finality.json" with { type: "json" };

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export function authorJournalPath(secrets: string, authorFile: string): string {
  return `${secrets}/journal-author-${hex(authorKey(readAuthorSecret(authorFile)))}.sqlite`;
}

export function submissionVerification(secrets: string, source: MidnightSource, deploy: { address: string; txHash: string; blockHeight: number; blockHash: string }) {
  const rootFile = `${secrets}/submission-verifier.seed`;
  const authorFiles = ["author-relay.key", "author-relay-2.key"].map(file => `${secrets}/${file}`);
  for (const file of [...authorFiles, rootFile]) if (!existsSync(file)) createAuthorKeyFile(file);
  const authors = authorFiles.map((file, i) => ({ key: hex(authorKey(readAuthorSecret(file))), id: `rehearsal-submit-relay-${i + 1}`, role: "relay", validFrom: deploy.blockHeight, validTo: null }));
  const signed = signKnownAuthors(JSON.stringify({ format: "orynq-known-authors/v1", serial: 1, issued: "2026-01-01T00:00:00.000Z", networks: { preprod: { authors, checkpoints: [checkpoint.checkpoints.own] } } }), readAuthorSecret(rootFile));
  const policy = openKnownAuthors(signed, [signed.signatures[0]!.key]);
  const registry: RegistryInfo = {
    generation: 1, address: deploy.address, deployTxHash: deploy.txHash, deployHeight: deploy.blockHeight,
    deployBlockHash: deploy.blockHash, runtimeSpecVersion: 1000300,
    circuits: { anchor: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor }, anchor_hiding: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor_hiding } },
  };
  return (request: Parameters<typeof verifyMidnightAnchor>[0], options: Parameters<typeof verifyMidnightAnchor>[1]) => {
    if (request.network !== "preprod" || options.source !== source || options.finality !== "verify" || request.expectedAuthor !== undefined) throw new Error("Rehearsal submission verification requires its exact preprod consensus context");
    return verifyMidnightAnchor(request, { ...options, source, knownAuthors: policy, registries: [registry], finality: "verify" });
  };
}
