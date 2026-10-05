import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  createAuthorKeyFile,
  createUserKeyFile,
  entryCommitment,
  midnightSource,
  readUserKey,
  sourceEndpoints,
  verifyMidnightAnchor,
  verifyReport,
  type MidnightSource,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import type { TraceBundle } from "@fluxpointstudios/orynq-sdk-process-trace";
import { midnightCommand, type MidnightDeps } from "../midnight.js";
import { fixture } from "../../../anchors-midnight/src/__tests__/anchor-chain.js";
import { serveSource, traceBundle, userChain } from "../../../anchors-midnight/src/__tests__/surface-chain.js";

type Served = Awaited<ReturnType<typeof serveSource>>;
type UserChain = Awaited<ReturnType<typeof userChain>>;

const dir = mkdtempSync(join(tmpdir(), "orynq-cli-midnight-"));
let bundle: TraceBundle;
let bundlePath: string;
let keyPath: string;
let user: UserChain;
let served: Served;
const servers: Served[] = [];
beforeAll(async () => {
  bundle = await traceBundle();
  bundlePath = join(dir, "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(bundle));
  keyPath = join(dir, "me.json");
  createUserKeyFile(keyPath);
  user = await userChain(bundle, readUserKey(keyPath));
  served = await serve(user.chain.source);
});
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});

async function serve(source: MidnightSource) {
  const s = await serveSource(source);
  servers.push(s);
  return s;
}

// A terminal or a pipe: `tty` marks stdin and stderr as a TTY, and `input` is what is typed.
function terminal({ tty = false, input }: { tty?: boolean; input?: string } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: tty });
  if (input !== undefined) stdin.end(input);
  const out = { stdout: "", stderr: "" };
  return {
    io: {
      stdin,
      stdout: { write: (s: string) => ((out.stdout += s), true) },
      stderr: { write: (s: string) => ((out.stderr += s), true), isTTY: tty },
      env: {} as Record<string, string | undefined>,
    },
    out,
  };
}

const deps = (extra: Partial<MidnightDeps> = {}): Partial<MidnightDeps> => ({
  registries: { mainnet: [user.chain.registry], preprod: [user.chain.registry] },
  knownAuthors: user.chain.authors(),
  ...extra,
});
const at = (s: Served) => ["--indexer", s.indexer, "--rpc", s.node];
const run = async (argv: string[], d: Partial<MidnightDeps> = deps(), t = terminal()) => ({ code: await midnightCommand(argv, t.io, d), ...t.out });
const line = (text: string, label: string) => text.split("\n").find((l) => l.trimStart().startsWith(`${label} `))?.trim().slice(label.length).trim();
const author = () => readUserKey(keyPath).authorKey;

describe("orynq verify midnight", () => {
  it("verifies a bare transaction hash through --indexer and --rpc and prints every assurance label", async () => {
    served.requests.length = 0;
    const r = await run(["verify", "midnight", user.anchors.public.txHash, ...at(served), "--author", author()]);
    expect(r.code).toBe(0);
    expect(line(r.stdout, "status")).toBe("valid");
    expect(line(r.stdout, "assurance")).toBe("consensus-verified");
    expect(line(r.stdout, "author")).toBe(`expected: ${author()} (given with --author)`);
    expect(line(r.stdout, "matched")).toBe("nothing: no bundle was given, so the commitment is reported, not checked");
    expect(line(r.stdout, "commitment")).toBe(user.anchors.public.commitment);
    expect(r.stdout).toMatch(/^ {2}ok {4}finality +GRANDPA set \d+ justified block \d+ after \d+ set changes$/m);
    expect(new Set(served.requests)).toEqual(new Set(["/graphql", "/rpc"]));
  });

  it("is unauthenticated, exit 1, for an author KNOWN_AUTHORS does not list and no --author names", async () => {
    const r = await run(["verify", "midnight", user.anchors.public.txHash, ...at(served)]);
    expect(r.code).toBe(1);
    expect(line(r.stdout, "status")).toBe("unauthenticated");
    expect(line(r.stdout, "author")).toBe(`unknown: ${author()} is not in KNOWN_AUTHORS serial 1`);
  });

  it("checks a bundle's own hashes, then matches them: kind 1 binds the entry, --hidden the committed attribute", async () => {
    const pub = await run(["verify", "midnight", bundlePath, "--tx", user.anchors.public.txHash, ...at(served), "--author", author()]);
    expect([pub.code, line(pub.stdout, "status"), line(pub.stdout, "matched")]).toEqual([0, "valid", "rootHash, manifestHash, merkleRoot"]);
    const hidden = await run(["verify", "midnight", user.anchors.hidden.txHash, "--bundle", bundlePath, "--hidden", ...at(served), "--author", author()]);
    expect([hidden.code, line(hidden.stdout, "status"), line(hidden.stdout, "matched")]).toEqual([0, "valid", "committedAttribute"]);
    expect(line(hidden.stdout, "attribute")).toBe(user.anchors.hidden.attribute);
    expect(hidden.stdout).toContain("note        kind 2: the registry circuit binds the attribute to the commitment and never checks it against the trace's model manifest");
  });

  it("--json prints exactly the library's report for the same request", async () => {
    const r = await run(["verify", "midnight", user.anchors.hidden.txHash, "--bundle", bundlePath, "--hidden", ...at(served), "--json"]);
    const direct = await verifyMidnightAnchor(
      { network: "mainnet", txHash: user.anchors.hidden.txHash, expect: { kind: 2, attribute: bundle.modelManifestHash! } },
      { source: midnightSource(sourceEndpoints("mainnet", { indexer: served.indexer, node: served.node })!), registries: [user.chain.registry], knownAuthors: user.chain.authors() },
    );
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify(verifyReport(direct))));
    expect(JSON.parse(r.stdout)).toMatchObject({ status: "unauthenticated", assurance: "consensus-verified", verifiedFields: ["committedAttribute"] });
  });

  it("matches a bundle against another anchor as invalid, naming the commitment the bundle gives, and the wrong kind too", async () => {
    const want = Buffer.from(entryCommitment({ rootHash: bundle.rootHash, manifestHash: bundle.manifestHash!, merkleRoot: bundle.merkleRoot })).toString("hex");
    expect(want).toBe(user.anchors.public.commitment);
    const other = await run(["verify", "midnight", bundlePath, "--tx", fixture.anchor.txHash, ...at(served)]);
    expect([other.code, line(other.stdout, "status")]).toEqual([1, "invalid"]);
    expect(other.stdout).toContain(`not to the entry (${want})`);
    const kind = await run(["verify", "midnight", bundlePath, "--tx", user.anchors.public.txHash, "--hidden", ...at(served), "--author", author()]);
    expect(kind.stdout).toContain("the anchor is kind 1, not kind 2");
    expect(kind.code).toBe(1);
  });

  it("refuses a tampered bundle before any source is asked", async () => {
    const tampered = structuredClone(bundle);
    (tampered.privateRun.events[0] as { observation: string }).observation = "something else";
    const path = join(dir, "tampered.json");
    writeFileSync(path, JSON.stringify(tampered));
    served.requests.length = 0;
    const r = await run(["verify", "midnight", path, "--tx", user.anchors.public.txHash, ...at(served)]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/tampered\.json is not an intact trace bundle: /);
    expect(served.requests).toEqual([]);
  });

  it("prints a hostile source's text without its control characters", async () => {
    const hostile: MidnightSource = {
      ...user.chain.source,
      indexer: { ...user.chain.source.indexer, transactions: async (h) => (await user.chain.source.indexer.transactions(h)).map((t) => ({ ...t, status: "\u001b]0;owned\u0007\u001b[2J" as never })) },
    };
    const r = await run(["verify", "midnight", user.anchors.public.txHash, ...at(await serve(hostile))]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("the indexer reports ?]0;owned??[2J");
    expect(r.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  });

  it("with the registries this build ships (none deployed), answers invalid without asking a source", async () => {
    served.requests.length = 0;
    const r = await run(["verify", "midnight", user.anchors.public.txHash, ...at(served)], { knownAuthors: user.chain.authors() });
    expect([r.code, line(r.stdout, "status")]).toEqual([1, "invalid"]);
    expect(r.stdout).toContain("no registry generation is deployed on mainnet");
    expect(served.requests).toEqual([]);
  });

  it("says how to configure a source when none is given, and refuses malformed requests", async () => {
    const none = await run(["verify", "midnight", user.anchors.public.txHash]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no Midnight source: pass --blockfrost-file <project id file> (or set ORYNQ_MIDNIGHT_BLOCKFROST_FILE), or --indexer <url> and --rpc <url>");
    const cases: Array<[string[], RegExp]> = [
      [[bundlePath], /a bundle needs --tx <hash>, the transaction that anchored it/],
      [[user.anchors.public.txHash, "--hidden"], /--hidden needs a bundle/],
      [[user.anchors.public.txHash, "--tx", user.anchors.public.txHash], /give the transaction once/],
      [[user.anchors.public.txHash, "--network", "testnet"], /--network must be mainnet or preprod/],
      [[user.anchors.public.txHash, "--key", keyPath], /unknown option '--key'/i],
      [[], /verify midnight takes one transaction hash or bundle file/],
    ];
    for (const [args, expected] of cases) {
      const r = await run(["verify", "midnight", ...args, ...at(served)]);
      expect([r.code, r.stderr]).toEqual([1, expect.stringMatching(expected)]);
    }
  });
});

describe("orynq keys init midnight", () => {
  it("creates the user's own key file, readable only by them, and prints only the public author key", async () => {
    const path = join(dir, "new-key.json");
    const r = await run(["keys", "init", "midnight", "--out", path]);
    expect(r.code).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const key = readUserKey(path);
    expect(line(r.stdout, "author key")).toBe(key.authorKey);
    const text = r.stdout + r.stderr;
    for (const secret of [key.authorSecret, key.saltKey]) expect(text).not.toContain(Buffer.from(secret).toString("hex").slice(0, 16));
    const again = await run(["keys", "init", "midnight", "--out", path]);
    expect([again.code, again.stderr]).toEqual([1, expect.stringMatching(/new-key\.json already exists/)]);
    expect((await run(["keys", "init", "midnight"])).stderr).toMatch(/--out <file> is required/);
  });
});

describe("orynq anchor midnight", () => {
  const submits: unknown[][] = [];
  const submit: MidnightDeps["submit"] = async (...args) => {
    submits.push(args);
    return { txHash: "5e".repeat(32) };
  };
  const anchor = (extra: string[], t = terminal(), d = deps({ submit })) => run(["anchor", "midnight", "--network", "preprod", "--key", keyPath, "--bundle", bundlePath, ...extra], d, t);

  it("is a dry run by default: the plan's commitments are the registry circuit's, and nothing is sent", async () => {
    const pub = await anchor([]);
    expect(pub.code).toBe(0);
    expect(line(pub.stdout, "commitment")).toBe(user.anchors.public.commitment);
    expect(line(pub.stdout, "kind")).toBe("1, public: the commitment binds the bundle's rootHash, manifestHash and merkleRoot");
    expect(line(pub.stdout, "registry")).toBe(`generation 1 at ${fixture.registry.address}`);
    expect(line(pub.stdout, "author key")).toBe(`${author()} (your key, not in KNOWN_AUTHORS)`);
    expect(pub.stdout).toContain("Dry run: nothing was sent. Add --submit, at a terminal, to send it.");
    const hidden = await anchor(["--hidden"]);
    expect(line(hidden.stdout, "commitment")).toBe(user.anchors.hidden.commitment);
    expect(line(hidden.stdout, "attribute")).toBe(user.anchors.hidden.attribute);
    const json = JSON.parse((await anchor(["--hidden", "--json"])).stdout);
    expect(json).toEqual({
      sent: false,
      plan: { network: "preprod", registry: { generation: 1, address: fixture.registry.address }, kind: 2, commitment: user.anchors.hidden.commitment, attribute: user.anchors.hidden.attribute, authorKey: author() },
    });
    expect(JSON.stringify(json)).not.toContain(Buffer.from(readUserKey(keyPath).saltKey).toString("hex").slice(0, 16));
    expect(submits).toEqual([]);
  });

  it("refuses an FPS key, one KNOWN_AUTHORS lists on any network, in a dry run and at a terminal", async () => {
    const fps = join(dir, "fps-in-user-format.json");
    writeFileSync(fps, JSON.stringify({ format: "orynq-midnight-user-key/v1", authorSecret: fixture.author.secret, saltKey: "ab".repeat(32) }), { mode: 0o600 });
    for (const [extra, t] of [[[], terminal()], [["--submit"], terminal({ tty: true, input: "whatever\n" })]] as const) {
      const r = await run(["anchor", "midnight", "--network", "preprod", "--key", fps, "--bundle", bundlePath, ...extra], deps({ submit }), t);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`holds the author key of fluxpoint-relay (relay on mainnet), a Flux Point Studios key in KNOWN_AUTHORS: orynq anchors only with your own key`);
      expect(r.stdout).toBe("");
    }
    const service = join(dir, "service.key");
    createAuthorKeyFile(service);
    const bare = await anchor(["--key", service]);
    expect([bare.code, bare.stderr]).toEqual([1, expect.stringContaining("service.key is not a user key file (orynq-midnight-user-key/v1); create your own with `orynq keys init midnight --out <file>`")]);
    expect(submits).toEqual([]);
  });

  it("refuses --submit without a terminal before reading the key or the bundle", async () => {
    const missing = ["--key", join(dir, "no-such-key.json"), "--bundle", join(dir, "no-such-bundle.json")];
    for (const t of [terminal({ input: `${user.anchors.public.commitment.slice(0, 8)}\n` }), (() => {
      const half = terminal({ tty: true, input: `${user.anchors.public.commitment.slice(0, 8)}\n` });
      half.io.stderr.isTTY = false;
      return half;
    })()]) {
      const r = await run(["anchor", "midnight", "--network", "preprod", "--submit", ...missing], deps({ submit }), t);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--submit needs a person at a terminal (stdin and stderr must both be a TTY); nothing was read or sent");
    }
    expect(submits).toEqual([]);
  });

  it("at a terminal, sends once the commitment's first 8 characters are typed, and cancels on anything else", async () => {
    const commitment = user.anchors.public.commitment;
    for (const input of ["yes\n", `${commitment.slice(0, 7)}\n`, ""]) {
      const r = await anchor(["--submit"], terminal({ tty: true, input }));
      expect([r.code, r.stderr]).toEqual([1, expect.stringContaining("Cancelled: nothing was sent.")]);
    }
    expect(submits).toEqual([]);
    const t = terminal({ tty: true, input: `${commitment.slice(0, 8).toUpperCase()}\n` });
    const sent = await anchor(["--submit"], t);
    expect(sent.code).toBe(0);
    expect(sent.stderr).toContain("This sends the anchor above to Midnight preprod with your own key and spends your DUST. It cannot be undone.");
    expect(sent.stderr).toContain("Type the first 8 characters of the commitment to send it, anything else to cancel: ");
    expect(line(sent.stdout, "sent")).toBe("5e".repeat(32));
    expect(submits).toHaveLength(1);
    const [plan, key] = submits[0] as [Record<string, unknown>, { authorKey: string }];
    expect(plan).toMatchObject({ network: "preprod", kind: 1, commitment, authorKey: author() });
    expect(key.authorKey).toBe(author());
    submits.length = 0;
  });

  it("with no registry deployed, or no submitter in this build, --submit stops before asking", async () => {
    const tty = () => terminal({ tty: true, input: `${user.anchors.public.commitment.slice(0, 8)}\n` });
    const none = await anchor(["--submit"], tty(), { knownAuthors: user.chain.authors(), submit });
    expect([none.code, none.stderr]).toEqual([1, expect.stringContaining("no registry generation is deployed on preprod, so there is nothing to send to")]);
    const noSubmitter = await anchor(["--submit"], tty(), deps());
    expect([noSubmitter.code, noSubmitter.stderr]).toEqual([1, expect.stringContaining("this build of orynq cannot send Midnight anchors: it has no submitter")]);
    for (const r of [none, noSubmitter]) expect(r.stderr).not.toContain("Type the first 8 characters");
    expect(submits).toEqual([]);
  });

  it("refuses a missing --network, a bundle without a manifestHash, and --hidden without a pinned model manifest", async () => {
    const { manifestHash: _m, ...noManifest } = bundle;
    const noManifestPath = join(dir, "no-manifest.json");
    writeFileSync(noManifestPath, JSON.stringify(noManifest));
    const cases: Array<[string[], RegExp]> = [
      [["anchor", "midnight", "--key", keyPath, "--bundle", bundlePath], /--network must be mainnet or preprod/],
      [["anchor", "midnight", "--network", "preprod", "--bundle", bundlePath], /--key <file> is required/],
      [["anchor", "midnight", "--network", "preprod", "--key", keyPath, "--bundle", noManifestPath], /no-manifest\.json has no manifestHash: anchor a bundle once its storage manifest is created/],
    ];
    for (const [argv, expected] of cases) {
      const r = await run(argv);
      expect([r.code, r.stderr]).toEqual([1, expect.stringMatching(expected)]);
    }
  });
});

describe("the orynq bin", () => {
  const bin = fileURLToPath(new URL("../../bin/orynq.mjs", import.meta.url));
  const orynq = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", input: "", env: { ...process.env, ORYNQ_MIDNIGHT_BLOCKFROST_FILE: "" } });

  it("lists the Midnight commands and runs them from the built package", () => {
    expect(existsSync(fileURLToPath(new URL("../../dist/midnight.js", import.meta.url)))).toBe(true);
    const help = orynq("help");
    for (const usage of ["orynq verify midnight", "orynq anchor midnight", "orynq keys init midnight"]) expect(help.stdout).toContain(usage);
    const path = join(dir, "bin-key.json");
    const keys = orynq("keys", "init", "midnight", "--out", path);
    expect([keys.status, readUserKey(path).authorKey]).toEqual([0, line(keys.stdout, "author key")]);
    const verify = orynq("verify", "midnight", user.anchors.public.txHash, "--indexer", served.indexer, "--rpc", served.node);
    expect([verify.status, line(verify.stdout, "status")]).toEqual([1, "invalid"]);
    expect(verify.stdout).toContain("no registry generation is deployed on mainnet");
  });

  it("refuses --submit from a pipe, which is how a model runs it", () => {
    const r = orynq("anchor", "midnight", "--network", "mainnet", "--key", keyPath, "--bundle", bundlePath, "--submit");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--submit needs a person at a terminal");
    expect(readFileSync(keyPath, "utf8")).toContain("orynq-midnight-user-key/v1");
  });
});
