// Live preprod submissions require independently reviewed checkpoint/author onboarding under
// the shipped policy roots. A test fixture or a freshly made root cannot bootstrap live trust.
import {
  authorKey, knownAuthors, readAuthorSecret, readPrivateFile,
  verifyMidnightAnchor, REGISTRY_VERIFIER_KEY_SHA256,
  type MidnightSource, type RegistryInfo, type SignedKnownAuthors,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export function authorJournalPath(secrets: string, authorFile: string): string {
  return `${secrets}/journal-author-${hex(authorKey(readAuthorSecret(authorFile)))}.sqlite`;
}

export function submissionConsensusPolicy(secrets: string) {
  let documents: SignedKnownAuthors[];
  try { documents = JSON.parse(readPrivateFile(`${secrets}/submission-known-authors.json`)); }
  catch { throw new Error("Preprod rehearsal requires owner-only submission-known-authors.json containing independently reviewed signed author/checkpoint policy"); }
  if (!Array.isArray(documents) || documents.length === 0) throw new Error("Preprod submission policy must contain signed documents");
  const policy = knownAuthors({ documents }); // Deliberately use shipped trust roots, never an input root.
  if (policy.checkpoints("preprod").length === 0) throw new Error("Preprod submission policy has no reviewed consensus checkpoint; onboarding is required");
  return { policy, documents };
}

export function submissionVerification(secrets: string, source: MidnightSource, deploy: { address: string; txHash: string; blockHeight: number; blockHash: string }) {
  const { policy } = submissionConsensusPolicy(secrets);
  const authorFiles = ["author-relay.key", "author-relay-2.key"].map(file => `${secrets}/${file}`);
  // Global signed policies must retain the shipped mainnet checkpoint history as a prefix.
  // Only their preprod section is consumed here; the request guard below excludes mainnet.
  for (const file of authorFiles) if (policy.author("preprod", hex(authorKey(readAuthorSecret(file))), deploy.blockHeight).status !== "known") throw new Error("Both fresh rehearsal author keys need signed preprod onboarding before submission");
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
