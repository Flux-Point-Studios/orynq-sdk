// KNOWN_AUTHORS documents for the preprod rotation and revocation drill, signed with a
// preprod-only trust-root key through the offline tool (scripts/known-authors.ts), which never
// prints the seed. Serial 1 lists relay-1 from the registry's deploy; serial 2 rotates relay-1
// to relay-2 after the rotation-old-before anchor; serial 3 revokes relay-2 after the
// rotation-new-after anchor. These documents authorize authors alone. Consensus checkpoints
// come separately from the independently reviewed shipped-root submission policy.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPrivateFile, readAuthorSecret } from "../../anchors-midnight/src/index.js";
import { ed25519PublicKey } from "../../anchors-midnight/src/ed25519.js";

import { toolingCommit } from "./tooling.js";
const commit = toolingCommit();

const VERIFY = fileURLToPath(new URL("../../anchors-midnight/", import.meta.url));
const SEED = `${process.env.HOME}/.secrets/orynq-midnight-preprod/known-authors-root.seed`;
const OUT = new URL("./evidence/known-authors/", import.meta.url);
const tool = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "scripts/known-authors.ts", ...args], { encoding: "utf8", cwd: VERIFY });

const raw = JSON.parse(readFileSync(new URL("./evidence/raw.json", import.meta.url), "utf8"));
if (raw.toolingCommit !== commit) throw new Error("KNOWN_AUTHORS drill and rehearsal tooling revisions differ");
mkdirSync(OUT, { recursive: true });
raw.rotation.policyIssuedAt ??= new Date().toISOString();
writeFileSync(new URL("./evidence/raw.json", import.meta.url), JSON.stringify(raw, null, 1));
const { relay1, relay2 } = raw.rotation.keys;
const deployHeight = raw.deploy.blockHeight;
const rotatedAt = raw.anchors["rotation-old-before"].blockHeight;
const revokedAt = raw.anchors["rotation-new-after"].blockHeight;
const author = (key: string, id: string, validFrom: number, validTo: number | null) => ({ key, id, role: "relay", validFrom, validTo });
const docs = [
  [author(relay1, "fluxpoint-relay-preprod-1", deployHeight, null)],
  [author(relay1, "fluxpoint-relay-preprod-1", deployHeight, rotatedAt), author(relay2, "fluxpoint-relay-preprod-2", rotatedAt + 1, null)],
  [author(relay1, "fluxpoint-relay-preprod-1", deployHeight, rotatedAt), author(relay2, "fluxpoint-relay-preprod-2", rotatedAt + 1, revokedAt)],
];
const drafts = docs.map((authors, i) => {
  const serial = i + 1;
  const text = `${JSON.stringify({ format: "orynq-known-authors/v1", serial, issued: raw.rotation.policyIssuedAt, networks: { preprod: { authors, checkpoints: [] } } }, null, 2)}\n`;
  writeFileSync(new URL(`doc-${serial}.json`, OUT), text);
  const digest = createHash("sha256").update(text).digest("hex");
  console.log(`serial ${serial} draft sha256 ${digest}: ${authors.map((a) => `${a.id} [${a.validFrom}, ${a.validTo ?? "open"}]`).join(", ")}`);
  return { serial, digest };
});
let reviewed: Record<string, string>;
try { reviewed = JSON.parse(readPrivateFile(`${process.env.HOME}/.secrets/orynq-midnight-preprod/known-authors-reviewed.json`)); }
catch { throw new Error("Review the three author-only drafts, then provide owner-only known-authors-reviewed.json mapping serials 1, 2 and 3 to their externally reviewed SHA-256 values; no policy was signed"); }
if (!reviewed || JSON.stringify(Object.keys(reviewed).sort()) !== '["1","2","3"]' || drafts.some(({ serial, digest }) => reviewed[String(serial)] !== digest)) throw new Error("The draft documents differ from the externally reviewed SHA-256 map; no policy was signed");
if (!existsSync(SEED)) tool("new-root-key", SEED);
writeFileSync(new URL("root.pub", OUT), `${Buffer.from(ed25519PublicKey(readAuthorSecret(SEED))).toString("hex")}\n`);
for (const { serial, digest } of drafts) writeFileSync(new URL(`signed-${serial}.json`, OUT), tool("sign", new URL(`doc-${serial}.json`, OUT).pathname, SEED, "--reviewed-sha256", digest));
console.log("trust root", readFileSync(new URL("root.pub", OUT), "utf8").trim());

raw.phaseCommits.documents = commit;
writeFileSync(new URL("./evidence/raw.json", import.meta.url), JSON.stringify(raw, null, 1));
