// KNOWN_AUTHORS documents for the preprod rotation and revocation drill, signed with a
// preprod-only trust-root key through the offline tool (scripts/known-authors.ts), which never
// prints the seed. Serial 1 lists relay-1 from the registry's deploy; serial 2 rotates relay-1
// to relay-2 after the rotation-old-before anchor; serial 3 revokes relay-2 after the
// rotation-new-after anchor. Each document carries the preprod GRANDPA checkpoint W2 recorded.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERIFY = fileURLToPath(new URL("../../anchors-midnight/", import.meta.url));
const SEED = `${process.env.HOME}/.secrets/orynq-midnight-preprod/known-authors-root.seed`;
const OUT = new URL("./evidence/known-authors/", import.meta.url);
const tool = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "scripts/known-authors.ts", ...args], { encoding: "utf8", cwd: VERIFY });

const raw = JSON.parse(readFileSync(new URL("./evidence/raw.json", import.meta.url), "utf8"));
mkdirSync(OUT, { recursive: true });
if (!existsSync(SEED)) writeFileSync(new URL("root.pub", OUT), tool("new-root-key", SEED));
const checkpoint = JSON.parse(readFileSync(`${VERIFY}src/__tests__/fixtures/preprod-finality.json`, "utf8")).checkpoints.own;
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
docs.forEach((authors, i) => {
  const serial = i + 1;
  const text = `${JSON.stringify({ format: "orynq-known-authors/v1", serial, issued: new Date().toISOString(), networks: { preprod: { authors, checkpoints: [checkpoint] } } }, null, 2)}\n`;
  writeFileSync(new URL(`doc-${serial}.json`, OUT), text);
  writeFileSync(new URL(`signed-${serial}.json`, OUT), tool("sign", new URL(`doc-${serial}.json`, OUT).pathname, SEED));
  console.log(`serial ${serial}: ${authors.map((a) => `${a.id} [${a.validFrom}, ${a.validTo ?? "open"}]`).join(", ")}`);
});
console.log("trust root", readFileSync(new URL("root.pub", OUT), "utf8").trim());
