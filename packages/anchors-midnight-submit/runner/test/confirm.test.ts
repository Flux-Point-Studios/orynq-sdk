import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { REGISTRY_VERIFIER_KEY_SHA256, entryCommitment, type EntryHashes } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { MAINNET_AUTHOR_KEYS } from "../../src/custody.js";
import type { PreparedDeploy } from "../../src/deployer.js";
import type { PreparedAnchor } from "../../src/operator.js";
import { NETWORK_IDENTITY, anchorSummary, deploySummary, parseDust } from "../../src/preflight.js";
import { fresh } from "../../test/fakes.js";
import { afterDeployRegistry, anchorsIntent, checkAnchorSummary, checkDeploySummary, deployIntent, driveTool, intentSha256, type Decision } from "../confirm.js";
import { LIMITS } from "../limits.js";
import type { FakeTool } from "./fake-tool.js";
import { ENTRIES, scriptPid } from "./helpers.js";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const fixture = (id: string) => readFileSync(`${FIXTURES}${id}.json`, "utf8");
const PAYER = LIMITS.payer;
const chain = { ...NETWORK_IDENTITY.mainnet, specVersion: 1000300, ledgerVersion: "8.1.1" };
const wallet = { dust: "mn_dust1example" };
const dust = 3_931_823_675_000_000_000n;

describe("limits.json", () => {
  it("pins the network, verifier keys and author keys the tools pin", () => {
    expect(LIMITS.network).toBe(`mainnet (${NETWORK_IDENTITY.mainnet.chain}, genesis ${NETWORK_IDENTITY.mainnet.genesis})`);
    expect(LIMITS.deploy.verifierKeys).toEqual(REGISTRY_VERIFIER_KEY_SHA256);
    expect(LIMITS.anchors.authorKeys).toEqual(MAINNET_AUTHOR_KEYS);
  });

  it("caps each transaction at the wrappers' --max-fee-dust default and a rolling day at ten of them, within which one deploy and a full anchors approval fit", () => {
    const perTransaction = parseDust(LIMITS.maxFeeDustPerTransaction)!;
    expect(LIMITS.maxFeeDustPerTransaction).toBe("0.01");
    expect(parseDust(LIMITS.maxDustPer24Hours)).toBe(10n * perTransaction);
    expect(BigInt(1 + LIMITS.anchors.maxEntriesPerApproval) * perTransaction <= parseDust(LIMITS.maxDustPer24Hours)!).toBe(true);
    expect([LIMITS.maxApprovalHours, LIMITS.maxConfirmationsPerTransaction, LIMITS.anchors.maxEntriesPerApproval]).toEqual([24, 3, 8]);
  });
});

describe("the intents deci authorized", () => {
  it("rebuilds deploy intent bf35fa0c exactly from limits.json and the 0.01 DUST fee cap", () => {
    const intent = deployIntent(PAYER, "0.01");
    expect(JSON.stringify(intent)).toBe(fixture("bf35fa0c"));
    expect(intentSha256(intent)).toBe("bf35fa0c0d16371a78ad26743e9d2691f6fca549571e3fa63816f0010b66a715");
  });

  it("hashes anchors intent 34941c71 as the wrapper did, over its compact JSON in the order it was written", () => {
    const intent = JSON.parse(fixture("34941c71"));
    expect(JSON.stringify(intent)).toBe(fixture("34941c71"));
    expect(intentSha256(intent)).toBe("34941c719ec6bd536b0d5a45fa249ca4135e92bd0ee7fecaa6bbd36ca72604c0");
  });

  it("builds an after-deploy anchors intent from a template as auto-anchor did: its sha256, its entries, and the registry deploy-mainnet's journal will name", () => {
    const authorized = JSON.parse(fixture("34941c71"));
    const template = fresh("plan.template.json");
    writeFileSync(template, JSON.stringify({ registry: "0".repeat(64), entries: authorized.entries }, null, 1));
    const registry = afterDeployRegistry("/home/deci/.local/state/orynq-midnight/mainnet-deploy.sqlite", "/home/deci/orynq-midnight-mainnet-plan.json");
    expect(registry).toBe(authorized.registry);
    expect(anchorsIntent({ plan: template, registry, payer: PAYER, maxFeeDustPerAnchor: "0.01" })).toEqual({
      ...authorized,
      plan: template,
      planSha256: createHash("sha256").update(readFileSync(template)).digest("hex"),
    });
  });
});

const TX = "ab".repeat(32);
const prepared: PreparedDeploy = {
  network: "mainnet",
  address: "cd".repeat(32),
  txHash: TX,
  bytes: new Uint8Array(8142),
  ttl: new Date("2026-10-20T15:00:00Z"),
  runtime: 1000300,
  authority: { committee: 0, threshold: 1, counter: "0" },
  verifierKeys: { ...REGISTRY_VERIFIER_KEY_SHA256 },
  declaredFee: 2n,
  payer: PAYER,
};

describe("checkDeploySummary", () => {
  const intent = deployIntent(PAYER, "0.01");
  const check = (change: Record<string, unknown> = {}, facts = chain, token = TX.slice(0, 16)) => checkDeploySummary(intent, deploySummary({ chain: facts, wallet, dust, prepared: { ...prepared, ...change } as PreparedDeploy }), token);

  it("finds nothing wrong with the summary of exactly the authorized deploy, and reads its transaction and fee", () => {
    expect(check()).toEqual({ item: "deploy", problems: [], txHash: TX, fee: 2n, validUntil: prepared.ttl.toISOString() });
  });

  it("accepts a deploy the journal resumed and a fee at the cap", () => {
    expect(check({ journal: { state: "pending", broadcasts: 1, expired: false }, declaredFee: 10n ** 13n }).problems).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, typeof chain, RegExp]>([
    ["another chain", {}, { ...chain, chain: "Midnight Preprod" }, /^network is "mainnet \(Midnight Preprod, genesis 1941/],
    ["another genesis", {}, { ...chain, genesis: "11".repeat(32) }, /^network is "mainnet \(Midnight Mainnet, genesis 1111/],
    ["a committee member", { authority: { committee: 1, threshold: 1, counter: "0" } }, chain, /^authority is "committee \[\] \(1 members\)/],
    ["another threshold", { authority: { committee: 0, threshold: 2, counter: "0" } }, chain, /^authority is "committee \[\] \(0 members\), threshold 2/],
    ["another counter", { authority: { committee: 0, threshold: 1, counter: "01" } }, chain, /^authority is "committee \[\] \(0 members\), threshold 1, counter 01:/],
    ["another anchor verifier key", { verifierKeys: { ...REGISTRY_VERIFIER_KEY_SHA256, anchor: "ee".repeat(32) } }, chain, /^anchor verifier key is "vk sha256 (ee){32}"/],
    ["another anchor_hiding verifier key", { verifierKeys: { ...REGISTRY_VERIFIER_KEY_SHA256, anchor_hiding: "ee".repeat(32) } }, chain, /^anchor_hiding verifier key is "vk sha256 (ee){32}"/],
    ["another payer", { payer: "mn_addr1other" }, chain, /^payer is "mn_addr1other"/],
    ["an unrecorded payer", { payer: undefined }, chain, /^payer is "a wallet the journal did not record"/],
    ["a fee over the cap", { declaredFee: 10n ** 13n + 1n }, chain, /^fee is "0\.010000000000001 DUST, all of it burned", cap 0\.01 DUST/],
  ])("names %s", (_, change, facts, problem) => {
    const { problems } = check(change, facts);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(problem);
  });

  it("names a token that does not name the summarized transaction", () => {
    expect(check({}, chain, "ab".repeat(7) + "ac").problems).toEqual([`the token abababababababac does not name the summarized transaction ${TX}`]);
  });

  it("refuses a summary without a valid transaction deadline", () => {
    const summary = deploySummary({ chain, wallet, dust, prepared });
    for (const text of [summary.replace(/^valid until .*\n/m, ""), summary.replace(prepared.ttl.toISOString(), "not-a-time")]) {
      expect(checkDeploySummary(intent, text, TX.slice(0, 16)).problems).toEqual([expect.stringContaining("valid until")]);
    }
  });

  it("names every fact a summary lacks", () => {
    expect(checkDeploySummary(intent, "Midnight Mainnet, runtime 1000300, ledger 8.1.1. Syncing the wallet...", TX.slice(0, 16)).problems).toEqual([
      'network is "(none)"',
      'authority is "(none)"',
      'anchor verifier key is "(none)"',
      'anchor_hiding verifier key is "(none)"',
      'payer is "(none)"',
      'fee is "(none)", cap 0.01 DUST',
      'valid until is "(none)"',
      "the token abababababababab does not name the summarized transaction (none)",
    ]);
  });
});

const REGISTRY = "ef".repeat(32);
const writePlan = (registry = REGISTRY, entries: unknown[] = ENTRIES) => {
  const path = fresh("plan.json");
  writeFileSync(path, JSON.stringify({ registry, entries }));
  return path;
};
const anchors = (plan = writePlan()) => anchorsIntent({ plan, registry: REGISTRY, payer: PAYER, maxFeeDustPerAnchor: "0.01" });

describe("checkAnchorSummary", () => {
  const intent = anchors();
  const [public1] = ENTRIES;
  const commitment = Buffer.from(entryCommitment(public1!)).toString("hex");
  const base: PreparedAnchor = {
    network: "mainnet",
    registry: REGISTRY,
    author: LIMITS.anchors.authorKeys[0]!,
    kind: 1,
    commitment,
    attribute: "00".repeat(32),
    txHash: TX,
    bytes: new Uint8Array(7000),
    ttl: new Date("2026-10-20T15:00:00Z"),
    declaredFee: 2n,
    payer: PAYER,
  };
  const summary = (change: Partial<PreparedAnchor> = {}, label = "proof-run-1", entry: EntryHashes = public1!) => anchorSummary({ entry, chain, wallet, dust, label, prepared: { ...base, ...change } });

  it("finds nothing wrong with each summary of exactly a planned anchor, and reads its label, transaction and fee", () => {
    expect(checkAnchorSummary(intent, REGISTRY, summary(), TX.slice(0, 16))).toEqual({ item: "proof-run-1", problems: [], txHash: TX, fee: 2n, validUntil: base.ttl.toISOString() });
    const hidden = summary({ kind: 2, commitment: "99".repeat(32), attribute: "44".repeat(32) }, "proof-run-1-hidden", ENTRIES[1]);
    expect(checkAnchorSummary(intent, REGISTRY, hidden, TX.slice(0, 16))).toEqual({ item: "proof-run-1-hidden", problems: [], txHash: TX, fee: 2n, validUntil: base.ttl.toISOString() });
  });

  it.each<[string, Partial<PreparedAnchor>, EntryHashes | undefined, RegExp]>([
    ["another registry", { registry: "ee".repeat(32) }, undefined, /^registry is "(ee){32}"/],
    ["another kind", { kind: 2 }, undefined, /^kind is "2: anchor_hiding\(\), a hiding commitment the attribute is bound to", the plan says 1/],
    ["another root hash", {}, { ...public1!, rootHash: "55".repeat(32) }, /^root hash is "(55){32}"/],
    ["another manifest hash", {}, { ...public1!, manifestHash: "55".repeat(32) }, /^manifest hash is "(55){32}"/],
    ["another merkle root", {}, { ...public1!, merkleRoot: "55".repeat(32) }, /^merkle root is "(55){32}"/],
    ["a commitment the plan does not derive", { commitment: "99".repeat(32) }, undefined, /^commitment is "(99){32}", the plan's entry derives [0-9a-f]{64}/],
    ["another author key", { author: "77".repeat(32) }, undefined, /^author key is "(77){32}"/],
    ["another payer", { payer: "mn_addr1other" }, undefined, /^payer is "mn_addr1other"/],
    ["a fee over the cap", { declaredFee: 10n ** 13n + 1n }, undefined, /^fee is "0\.010000000000001 DUST, all of it burned", cap 0\.01 DUST/],
  ])("names %s", (_, change, entry, problem) => {
    const { problems } = checkAnchorSummary(intent, REGISTRY, summary(change, "proof-run-1", entry), TX.slice(0, 16));
    expect(problems[0]).toMatch(problem);
    // A summary of another kind also lacks the rows the plan's kind is checked by.
    if (change.kind === undefined) expect(problems).toHaveLength(1);
  });

  it("names a kind-2 attribute other than the plan's", () => {
    const hidden = summary({ kind: 2, commitment: "99".repeat(32), attribute: "45".repeat(32) }, "proof-run-1-hidden", ENTRIES[1]);
    expect(checkAnchorSummary(intent, REGISTRY, hidden, TX.slice(0, 16)).problems).toEqual([`attribute is "${"45".repeat(32)}"`]);
  });

  it("refuses a label the plan does not hold, and a token that does not name the summarized transaction", () => {
    expect(checkAnchorSummary(intent, REGISTRY, summary({}, "git-head"), TX.slice(0, 16))).toEqual({ item: "git-head", problems: ['label "git-head" is not in the authorized plan'] });
    expect(checkAnchorSummary(intent, REGISTRY, summary(), "cd".repeat(8)).problems).toEqual([`the token ${"cd".repeat(8)} does not name the summarized transaction ${TX}`]);
  });
});

// The fake tool in a pseudo-terminal, answered by `decide` through driveTool.
const PACKAGE = new URL("../..", import.meta.url).pathname;
const human = () => ({ PATH: process.env.PATH, HOME: process.env.HOME });
async function drive(fake: Omit<FakeTool, "runs" | "record">, verb: "DEPLOY" | "ANCHOR", decide: (summary: string, token: string) => Decision, args: string[] = []) {
  const files = { runs: fresh("runs"), record: fresh("record.jsonl") };
  const tool = driveTool({ command: [process.execPath, "--import", "tsx", "runner/test/fake-tool.ts", ...args], cwd: PACKAGE, env: { ...human(), FAKE_TOOL: JSON.stringify({ ...fake, ...files }) }, verb, decide });
  const { code, answers } = await tool.exited;
  const typed = readFileSync(files.record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { item: string; typed: string; confirmed: boolean });
  return { code, answers, typed };
}

describe("driveTool answering the tool in a pseudo-terminal", () => {
  const intent = deployIntent(PAYER, "0.01");
  const deploy = (summary: string, token: string) => checkDeploySummary(intent, summary, token);

  it("types the token when every fact of the deploy summary matches", async () => {
    const r = await drive({ kind: "deploy" }, "DEPLOY", deploy);
    expect(r.code).toBe(0);
    expect(r.typed).toEqual([{ run: 1, item: "deploy", typed: `DEPLOY ${"aa".repeat(8)}`, confirmed: true }]);
    expect(r.answers).toEqual([{ token: `DEPLOY ${"aa".repeat(8)}`, confirmed: true, problems: [] }]);
  });

  it.each<[string, Partial<FakeTool>, "DEPLOY" | "ANCHOR", Decision]>([
    ["the summary", { payer: "mn_addr1other" }, "DEPLOY", { item: "deploy", problems: ['payer is "mn_addr1other"'], txHash: "aa".repeat(32), fee: 2n, validUntil: expect.any(String) }],
    ["the action", {}, "ANCHOR", { problems: [`the tool asks for "DEPLOY ${"aa".repeat(8)}", not an ANCHOR token`] }],
  ])("hands onNo the decision of a NO for %s before the tool is sent the NO", async (_, change, verb, decision) => {
    const files = { runs: fresh("runs"), record: fresh("record.jsonl") };
    const nos: { decision: Decision; toolAnswered: boolean }[] = [];
    const onNo = (decision: Decision) => {
      // Long enough for a tool already sent its NO to have recorded it.
      const until = Date.now() + 1000;
      while (Date.now() < until);
      nos.push({ decision, toolAnswered: existsSync(files.record) });
    };
    const tool = driveTool({ command: [process.execPath, "--import", "tsx", "runner/test/fake-tool.ts"], cwd: PACKAGE, env: { ...human(), FAKE_TOOL: JSON.stringify({ kind: "deploy", ...change, ...files }) }, verb, decide: deploy, onNo });
    expect((await tool.exited).code).toBe(1);
    expect(nos).toEqual([{ decision, toolAnswered: false }]);
  });

  it("runs the tool without the descriptor its exit status is reported on, so the tool cannot report one", async () => {
    let output = "";
    const tool = driveTool({ command: ["sh", "-c", "printf 0 >&3; echo started; sleep 30"], cwd: PACKAGE, env: human(), verb: "DEPLOY", decide: deploy, onText: (text) => void (output += text) });
    while (!output.includes("started")) await new Promise((resolve) => setTimeout(resolve, 25));
    process.kill(scriptPid(), "SIGTERM");
    expect(await tool.exited).toEqual({ code: null, answers: [] });
  });

  it.each(["SIGTERM", "SIGINT", "SIGQUIT"] as const)("reports no exit status when a stray %s ends script before the tool exits", async (signal) => {
    const files = { runs: fresh("runs"), record: fresh("record.jsonl") };
    let output = "";
    const tool = driveTool({ command: [process.execPath, "--import", "tsx", "runner/test/fake-tool.ts"], cwd: PACKAGE, env: { ...human(), FAKE_TOOL: JSON.stringify({ kind: "deploy", syncMs: 60_000, ...files }) }, verb: "DEPLOY", decide: deploy, onText: (text) => void (output += text) });
    while (!output.includes("Syncing the wallet")) await new Promise((resolve) => setTimeout(resolve, 25));
    process.kill(scriptPid(), signal);
    expect(await tool.exited).toEqual({ code: null, answers: [] });
  });

  it.each<[string, Partial<FakeTool>]>([
    ["payer", { payer: "mn_addr1other" }],
    ["fee", { fee: String(10n ** 13n + 1n) }],
    ["committee", { committee: 1 }],
    ["verifier key", { verifierKeys: { anchor: "ee".repeat(32) } }],
    ["chain", { chain: { chain: "Midnight Preprod" } }],
  ])("answers NO when the deploy's %s does not match, and the tool sends nothing", async (_, change) => {
    const r = await drive({ kind: "deploy", ...change }, "DEPLOY", deploy);
    expect(r.code).toBe(1);
    expect(r.typed).toEqual([{ run: 1, item: "deploy", typed: "NO", confirmed: false }]);
    expect(r.answers[0]).toMatchObject({ confirmed: false, problems: [expect.any(String)] });
  });

  it("answers NO to a prompt for another kind of bytes than the intent's", async () => {
    const r = await drive({ kind: "deploy" }, "ANCHOR", () => ({ problems: [] }));
    expect(r.typed).toEqual([{ run: 1, item: "deploy", typed: "NO", confirmed: false }]);
    expect(r.answers[0]!.problems).toEqual(['the tool asks for "DEPLOY aaaaaaaaaaaaaaaa", not an ANCHOR token']);
  });

  it("types each anchor's token when its summary matches its plan entry, and NO to the one whose attribute does not", async () => {
    const plan = writePlan();
    const intent = anchors(plan);
    const anchor = (summary: string, token: string) => checkAnchorSummary(intent, REGISTRY, summary, token);
    const both = await drive({ kind: "anchor" }, "ANCHOR", anchor, ["--plan", plan]);
    expect(both.code).toBe(0);
    expect(both.typed.map(({ item, confirmed }) => [item, confirmed])).toEqual([
      ["proof-run-1", true],
      ["proof-run-1-hidden", true],
    ]);
    const tampered = await drive({ kind: "anchor", anchors: { "proof-run-1-hidden": { attribute: "45".repeat(32) } } }, "ANCHOR", anchor, ["--plan", plan]);
    expect(tampered.code).toBe(1);
    expect(tampered.typed.map(({ item, typed }) => [item, typed])).toEqual([
      ["proof-run-1", `ANCHOR ${"a0".repeat(8)}`],
      ["proof-run-1-hidden", "NO"],
    ]);
    expect(tampered.answers[1]!.problems).toEqual([`attribute is "${"45".repeat(32)}"`]);
  });

  it.each<[string, NonNullable<FakeTool["anchors"]>]>([
    ["registry", { "proof-run-1": { registry: "ee".repeat(32) } }],
    ["author key", { "proof-run-1": { author: "77".repeat(32) } }],
    ["root hash", { "proof-run-1": { rootHash: "55".repeat(32) } }],
  ])("answers NO to an anchor whose %s does not match", async (_, change) => {
    const plan = writePlan();
    const intent = anchors(plan);
    const r = await drive({ kind: "anchor", anchors: change }, "ANCHOR", (summary, token) => checkAnchorSummary(intent, REGISTRY, summary, token), ["--plan", plan]);
    expect(r.code).toBe(1);
    expect(r.typed).toEqual([{ run: 1, item: "proof-run-1", typed: "NO", confirmed: false }]);
  });
});
