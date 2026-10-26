// Records the verifier's reads of three real preprod rehearsal anchors through Blockfrost (a
// kind 1 from the relay key, a kind 2, and the revoked relay-2 anchor) into a fixture the
// anchors-midnight suite replays (verify.test.ts): the registry generation, the drill's signed
// KNOWN_AUTHORS documents and trust root, each request and the result the live run gave.
//   node --import tsx record-golden.ts ../../anchors-midnight/src/__tests__/fixtures/preprod-rehearsal.json
import { readFileSync, writeFileSync } from "node:fs";
import { blockfrostEndpoints, knownAuthors, midnightSource, verifyMidnightAnchor, REGISTRY_VERIFIER_KEY_SHA256 } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { recordingSource } from "../../anchors-midnight/src/__tests__/recorded-source.js";

const here = (p: string) => new URL(p, import.meta.url);
const raw = JSON.parse(readFileSync(here("./evidence/raw.json"), "utf8"));
const bundles = JSON.parse(readFileSync(here("./bundles/index.json"), "utf8")) as Array<{ label: string; rootHash: string; manifestHash: string; merkleRoot: string }>;
const trustRoot = readFileSync(here("./evidence/known-authors/root.pub"), "utf8").trim();
const documents = [1, 2, 3].map((n) => JSON.parse(readFileSync(here(`./evidence/known-authors/signed-${n}.json`), "utf8"))[0]);
const registry = {
  generation: 1,
  address: raw.deploy.address,
  deployTxHash: raw.deploy.txHash,
  deployHeight: raw.deploy.blockHeight,
  runtimeSpecVersion: 1000300,
  circuits: { anchor: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor }, anchor_hiding: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor_hiding } },
};
const live = midnightSource(blockfrostEndpoints("preprod", `${process.env.HOME}/.secrets/blockfrost-midnight-preprod.project_id`));
const { source, recording } = recordingSource(live, "preprod");
const kind2 = Object.entries(raw.anchors as Record<string, any>).find(([, a]) => a.kind === 2)!;
const picks: Array<[string, any]> = [["git-head", raw.anchors["git-head"]], kind2, ["revoked-new-after", raw.anchors["revoked-new-after"]]];
const anchors = [];
for (const [name, a] of picks) {
  const b = bundles.find((x) => x.label === a.bundle)!;
  const expect = a.kind === 1 ? { kind: 1, entry: { rootHash: b.rootHash, manifestHash: b.manifestHash, merkleRoot: b.merkleRoot } } : { kind: 2, attribute: a.attribute };
  const r = await verifyMidnightAnchor({ network: "preprod", txHash: a.txHash, expect: expect as never }, { source, registries: [registry], knownAuthors: knownAuthors({ documents, trustRoots: [trustRoot] }) });
  anchors.push({ name, txHash: a.txHash, expect, status: r.status, assurance: r.assurance, author: r.author, verifiedFields: r.verifiedFields, checks: r.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`) });
  console.log(name, r.status, r.assurance);
}
writeFileSync(process.argv[2]!, `${JSON.stringify({ network: "preprod", registry, trustRoot, documents, anchors, recording }, null, 1)}\n`);
