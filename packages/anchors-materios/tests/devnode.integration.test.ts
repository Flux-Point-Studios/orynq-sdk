/**
 * Submission contract against a real Materios node. Run a local dev node and point
 * MATERIOS_DEV_NODE_URL at its WebSocket RPC, for example ws://127.0.0.1:39944. The
 * signer is //Alice, so the node must be a --dev chain. Faults are injected by a
 * loopback proxy between the SDK and the node; the node itself is never altered.
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import { u8aConcat, u8aToHex } from "@polkadot/util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import { isStatus, startProxy } from "./support/rpc-proxy.js";

const NODE_URL = process.env.MATERIOS_DEV_NODE_URL;
const SKIP_REASON = "MATERIOS_DEV_NODE_URL is unset; these tests need a local Materios --dev node";
const NONCE_COLLISION = /^1014: Priority is too low/;

const hex32 = () => "0x" + randomBytes(32).toString("hex");
const freshInput = () => ({ contentHash: hex32(), rootHash: hex32(), manifestHash: hex32() });
const receiptIdOf = (input: { contentHash: string }) =>
  "0x" + createHash("sha256").update(Buffer.from(input.contentHash.slice(2), "hex")).digest("hex");
const entryOf = (input: { rootHash: string; manifestHash: string }) => ({
  type: "custom" as const, version: "1.0" as const, rootHash: input.rootHash, manifestHash: input.manifestHash,
  timestamp: new Date().toISOString(),
});
const failure = (promise: Promise<unknown>) => promise.then(
  value => { throw new Error(`expected a rejection, got ${JSON.stringify(value)}`); },
  (error: unknown) => error as any,
);
const isInBlock = (status: unknown) => typeof status === "object" && status !== null && "inBlock" in status;

describe("Materios dev node", () => {
  let chain: ApiPromise;
  const alice = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    if (NODE_URL) chain = await ApiPromise.create({ provider: new WsProvider(NODE_URL), noInitWarn: true });
  }, 60_000);
  afterAll(async () => { await chain?.disconnect(); });
  beforeEach(async context => {
    context.skip(!NODE_URL, SKIP_REASON);
    await untilBlock(async () => (await chain.rpc.author.pendingExtrinsics()).length === 0);
  }, 90_000);
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function provider(rpcUrl: string, signerUri = "//Alice") {
    const connected = new sdk.MateriosProvider({ rpcUrl, signerUri });
    await connected.connect();
    cleanups.push(() => connected.disconnect());
    return connected;
  }

  async function proxy() {
    const started = await startProxy(NODE_URL!);
    cleanups.push(started.close);
    return started;
  }

  const bestNumber = async () => (await chain.rpc.chain.getHeader()).number.toNumber();
  const stateNonce = async () => (await chain.call.accountNonceApi!.accountNonce!(alice.address) as any).toNumber() as number;
  const receiptStored = async (id: string) => !(await chain.query.orinqReceipts!.receipts!(id)).isEmpty;

  async function untilBlock(test: () => Promise<boolean>, blocks = 10) {
    const start = await bestNumber();
    for (;;) {
      if (await test()) return;
      if (await bestNumber() > start + blocks) throw new Error(`condition not met within ${blocks} blocks`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  const nextBlock = async () => { const start = await bestNumber(); await untilBlock(async () => await bestNumber() > start, 2); };

  async function finalizeRemark(nonce: number) {
    const remark = await chain.tx.system!.remark!("0x7072323131").signAsync(alice, { nonce });
    await new Promise<void>((resolve, reject) => {
      remark.send(result => {
        if (result.dispatchError) reject(new Error(result.dispatchError.toString()));
        else if (result.status.isFinalized) resolve();
      }).catch(reject);
    });
  }

  it("keeps the happy-path receipt and anchor result shapes", async () => {
    const p = await provider(NODE_URL!);
    const input = freshInput();
    const receipt = await sdk.submitReceipt(p, input, { timeoutMs: 60_000 });
    expect(Object.keys(receipt).sort()).toEqual(["blockHash", "blockNumber", "confirmed", "receiptId", "status", "txHash"]);
    expect(receipt).toMatchObject({ receiptId: receiptIdOf(input), confirmed: true, status: "submitted" });
    const anchor = await sdk.submitAnchor(p, entryOf(input), { timeoutMs: 90_000 });
    expect(Object.keys(anchor).sort()).toEqual(["anchorId", "blockHash", "contentHash", "manifestHash", "rootHash"]);
  }, 150_000);

  it("reports a same-nonce collision as not-landed with the node's 1014 text, and the same id lands on retry (sk1/s3)", async () => {
    const p = await provider(NODE_URL!);
    const input = freshInput();
    await nextBlock();
    const nonce = await stateNonce();
    await chain.rpc.author.submitExtrinsic(await chain.tx.system!.remark!("0x7072323131").signAsync(alice, { nonce }));
    const error = await failure(sdk.submitReceipt(p, input, { timeoutMs: 30_000 }));
    expect(error).toMatchObject({ name: "MateriosSubmissionError", code: "not-landed", safeToResubmit: true, nonce, signer: alice.address });
    expect(error.message).toMatch(NONCE_COLLISION);
    expect(error.cause.code).toBe(1014);
    await untilBlock(async () => await stateNonce() > nonce);
    const retried = await sdk.submitReceipt(p, input, { timeoutMs: 60_000 });
    expect(retried).toMatchObject({ receiptId: receiptIdOf(input), status: "submitted", confirmed: true });
  }, 120_000);

  it("reports an unfunded signer's 1010 behind a dry-run filter as not-landed with the node's text (s4)", async () => {
    const px = await proxy();
    px.hooks.onClient = (_connection, message) => message.method === "system_dryRun"
      ? { respond: { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "RPC call is unsafe to be called externally" } } }
      : undefined;
    const p = await provider(px.url, "//Pr211FixRoundUnfunded");
    const error = await failure(sdk.submitReceipt(p, freshInput(), { timeoutMs: 30_000 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true });
    expect(error.message).toMatch(/^1010: Invalid Transaction/);
    expect(error.cause.code).toBe(1010);
  }, 60_000);

  it("reports an anchor whose connection drops while signing as not-landed, with nothing sent (s12)", async () => {
    const px = await proxy();
    const p = await provider(px.url);
    const main = px.connections[0]!;
    px.hooks.onClient = (connection, message) =>
      connection === main && message.method === "state_call" && (message.params as unknown[])[0] === "AccountNonceApi_account_nonce"
        ? "kill" : undefined;
    const error = await failure(sdk.submitAnchor(p, entryOf(freshInput()), { timeoutMs: 30_000 }));
    expect(error).toMatchObject({ code: "not-landed", safeToResubmit: true });
    expect(error.cause).toBeInstanceOf(Error);
    expect(px.methods()).not.toContain("author_submitAndWatchExtrinsic");
  }, 60_000);

  it("reconciles a receipt whose watch drops after ready, once it lands (s2/sk2)", async () => {
    const px = await proxy();
    const p = await provider(px.url);
    const main = px.connections[0]!;
    let killedAt = 0;
    px.hooks.onUpstream = (connection, message) => {
      if (connection !== main || killedAt || !isStatus(message, status => status === "ready")) return undefined;
      killedAt = Date.now();
      return "kill-after";
    };
    const input = freshInput();
    const result = await sdk.submitReceipt(p, input, { timeoutMs: 120_000 });
    expect(killedAt).toBeGreaterThan(0);
    expect(result).toMatchObject({ receiptId: receiptIdOf(input), reconciled: true, confirmed: true, status: "submitted" });
    expect(await receiptStored(result.receiptId)).toBe(true);
  }, 150_000);

  it("reconciles an anchor whose watch drops after ready, once finalized (s9)", async () => {
    const px = await proxy();
    const p = await provider(px.url);
    const main = px.connections[0]!;
    let killed = false;
    px.hooks.onUpstream = (connection, message) => {
      if (connection !== main || killed || !isStatus(message, status => status === "ready")) return undefined;
      killed = true;
      return "kill-after";
    };
    const result = await sdk.submitAnchor(p, entryOf(freshInput()), { timeoutMs: 120_000 });
    expect(killed).toBe(true);
    expect(result).toMatchObject({ reconciled: true });
    const finalizedAt = await chain.at(await chain.rpc.chain.getFinalizedHead());
    expect((await finalizedAt.query.orinqReceipts!.anchors!(result.anchorId)).isEmpty).toBe(false);
  }, 150_000);

  it("lets the next receipt land after a dropped watch (s11)", async () => {
    const px = await proxy();
    const p = await provider(px.url);
    const main = px.connections[0]!;
    let killed = false;
    px.hooks.onUpstream = (connection, message) => {
      if (connection !== main || killed || !isStatus(message, status => status === "ready")) return undefined;
      killed = true;
      return "kill-after";
    };
    const first = freshInput();
    const next = freshInput();
    expect(await sdk.submitReceipt(p, first, { timeoutMs: 60_000 })).toMatchObject({ reconciled: true });
    expect(await sdk.submitReceipt(p, next, { timeoutMs: 60_000 })).toMatchObject({ receiptId: receiptIdOf(next), status: "submitted" });
    expect(await receiptStored(receiptIdOf(first))).toBe(true);
    expect(await receiptStored(receiptIdOf(next))).toBe(true);
  }, 150_000);

  it("resolves an inclusion-unknown receipt as landed from finalized storage", async () => {
    const px = await proxy();
    const p = await provider(px.url);
    const main = px.connections[0]!;
    px.hooks.onUpstream = (connection, message) => {
      if (connection !== main || !isStatus(message, status => status === "ready")) return undefined;
      px.flags.blackholeNew = true;
      return "kill-after";
    };
    const signedAt = await bestNumber();
    const input = freshInput();
    const error = await failure(sdk.submitReceipt(p, input, { timeoutMs: 8_000 }));
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false, id: receiptIdOf(input), signer: alice.address });
    expect(error.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number.isInteger(error.nonce)).toBe(true);
    expect(error.mortalityEnd).toBeGreaterThanOrEqual(signedAt + 50);
    expect(error.mortalityEnd).toBeLessThanOrEqual(signedAt + 64);
    expect(error.cause).toBeInstanceOf(Error);
    px.flags.blackholeNew = false;
    const resolution = await sdk.resolveInclusion(p, error, { intervalMs: 1000, timeoutMs: 120_000 });
    expect(resolution).toMatchObject({ status: "landed", id: receiptIdOf(input) });
    const finalized = (await chain.rpc.chain.getHeader(await chain.rpc.chain.getFinalizedHead())).number.toNumber();
    expect(resolution.blockNumber).toBeLessThanOrEqual(finalized);
  }, 180_000);

  it("resolves a receipt that never reached the node as not-landed once its nonce is consumed", async () => {
    const px = await proxy();
    const p = await provider(px.url);
    px.hooks.onClient = (_connection, message) => message.method === "author_submitAndWatchExtrinsic" ? "kill" : undefined;
    const input = freshInput();
    const error = await failure(sdk.submitReceipt(p, input, { timeoutMs: 6_000 }));
    expect(error).toMatchObject({ code: "inclusion-unknown", safeToResubmit: false });
    delete px.hooks.onClient;
    await finalizeRemark(error.nonce);
    const resolution = await sdk.resolveInclusion(p, error, { intervalMs: 1000, timeoutMs: 120_000 });
    expect(resolution).toMatchObject({ status: "not-landed", reason: "nonce-consumed", id: receiptIdOf(input) });
    expect(await receiptStored(receiptIdOf(input))).toBe(false);
  }, 180_000);

  it("keeps an orchestrated receipt's on-chain result through a lost socket, and a retry does not rebroadcast (s5/sk3)", async () => {
    const gateway = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
    });
    await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise(resolve => gateway.close(resolve)));
    const address = gateway.address();
    if (typeof address === "string" || !address) throw new Error("Missing gateway port");
    const px = await proxy();
    const p = await provider(px.url);
    const main = px.connections[0]!;
    let killed = false;
    px.hooks.onUpstream = (connection, message) => {
      if (connection !== main || killed || !isStatus(message, isInBlock)) return undefined;
      killed = true;
      return "kill-before";
    };
    const content = randomBytes(64);
    const opts = {
      blobGateway: { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "local-stub" },
      submissionOpts: { timeoutMs: 60_000 }, certificationPollOpts: { timeoutMs: 8_000, intervalMs: 1_000 },
    };
    const blank = { contentHash: "", rootHash: "", manifestHash: "" };
    const first = await failure(sdk.submitCertifiedReceipt(p, blank, content, opts));
    expect(killed).toBe(true);
    expect(first).toBeInstanceOf(sdk.MateriosCertificationError);
    expect(first).toMatchObject({ stage: "certification" });
    expect(first.result).toMatchObject({ reconciled: true, confirmed: true });
    expect(await receiptStored(first.result.receiptId)).toBe(true);
    const nonce = await stateNonce();
    const submitted = px.methods().filter(method => method === "author_submitAndWatchExtrinsic").length;
    const retry = await failure(sdk.submitCertifiedReceipt(p, blank, content, opts));
    expect(retry).toBeInstanceOf(sdk.MateriosCertificationError);
    expect(retry.result).toMatchObject({ receiptId: first.result.receiptId, reconciled: true });
    expect(px.methods().filter(method => method === "author_submitAndWatchExtrinsic").length).toBe(submitted);
    await nextBlock();
    expect(await stateNonce()).toBe(nonce);
  }, 180_000);

  it("reconciles receipt and anchor retries from storage without broadcasting again (s6/s9)", async () => {
    const px = await proxy();
    const p = await provider(px.url);
    const input = freshInput();
    const receipt = await sdk.submitReceipt(p, input, { timeoutMs: 60_000 });
    const anchor = await sdk.submitAnchor(p, entryOf(input), { timeoutMs: 90_000 });
    const submitted = px.methods().filter(method => method === "author_submitAndWatchExtrinsic").length;
    expect(await sdk.submitReceipt(p, input, { timeoutMs: 60_000 }))
      .toMatchObject({ receiptId: receipt.receiptId, reconciled: true, confirmed: true, status: "submitted" });
    expect(await sdk.submitAnchor(p, entryOf(input), { timeoutMs: 90_000 }))
      .toMatchObject({ anchorId: anchor.anchorId, reconciled: true });
    expect(px.methods().filter(method => method === "author_submitAndWatchExtrinsic").length).toBe(submitted);
  }, 240_000);

  it("lands a receipt submitted while a full best block makes the dry-run report exhaustsResources", async () => {
    const px = await proxy();
    const p = await provider(px.url);
    const dryRunIds = new Set<number | undefined>();
    const verdicts: string[] = [];
    px.hooks.onClient = (_connection, message) => {
      if (message.method === "system_dryRun") dryRunIds.add(message.id);
      return undefined;
    };
    px.hooks.onUpstream = (_connection, message) => {
      const result = (message as { result?: string }).result;
      if (dryRunIds.has(message.id) && result) {
        verdicts.push(JSON.stringify(chain.registry.createType("ApplyExtrinsicResult", result).toJSON()));
      }
      return undefined;
    };
    // The runtime fills some blocks with mandatory weight (every 60 blocks on a dev chain); a
    // dry-run applies on the best block's own state, so it reports those as exhausted.
    const maxWeight = BigInt(chain.consts.system!.blockWeights!.maxBlock.refTime.toString());
    let full = 0;
    await untilBlock(async () => {
      const header = await chain.rpc.chain.getHeader();
      const weight = await (await chain.at(header.hash)).query.system!.blockWeight!() as any;
      if (BigInt(weight.mandatory.refTime.toString()) < maxWeight) return false;
      full = header.number.toNumber();
      return true;
    }, 70);
    const input = freshInput();
    const result = await sdk.submitReceipt(p, input, { timeoutMs: 60_000 });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatch(/exhaustsResources/i);
    expect(result).toMatchObject({ receiptId: receiptIdOf(input), status: "submitted", confirmed: true });
    expect(result.blockNumber).toBeGreaterThan(full);
  }, 600_000);

  it("replaces a blackholed main connection so the next submission lands (H3a)", async () => {
    const px = await proxy();
    const p = await provider(px.url);
    px.connections[0]!.blackhole = true;
    const first = await failure(sdk.submitReceipt(p, freshInput(), { timeoutMs: 8_000 }));
    expect(first).toMatchObject({ code: "not-landed", safeToResubmit: true });
    const input = freshInput();
    expect(await sdk.submitReceipt(p, input, { timeoutMs: 60_000 })).toMatchObject({ receiptId: receiptIdOf(input), status: "submitted" });
    expect(px.connections.length).toBeGreaterThan(1);
  }, 120_000);

  it("computes the mortality end as the last block the runtime lets include the extrinsic", async () => {
    const { mortalityEnd } = await import("../src/submission.js");
    await untilBlock(async () => await bestNumber() >= 80, 80);
    const birth = await bestNumber() - 70;
    const end = birth + 63;
    const era = chain.registry.createType("ExtrinsicEra", { current: birth, period: 64 });
    const birthHash = await chain.rpc.chain.getBlockHash(birth);
    /** A remark signed in that era with //Alice's nonce at `number`, which is valid there. */
    const signedOn = async (number: number) => {
      const at = await chain.rpc.chain.getBlockHash(number);
      const nonce = (await (await chain.at(at)).query.system!.account!(alice.address) as any).nonce.toNumber();
      return { at, signed: await chain.tx.system!.remark!("0x7072323131").signAsync(alice, { era, blockHash: birthHash, nonce }) };
    };
    expect(mortalityEnd((await signedOn(birth)).signed.era, birth + 5)).toBe(end);
    // The pool admits a transaction for block N by validating it on block N - 1 with the block
    // number set to N, exactly as block production applies it. polkadot.js mis-encodes this
    // runtime call for Materios ("Bad input data provided to validate_transaction"), so the
    // input is built by hand: source External (2), the extrinsic, the parent block hash.
    const admit = async ({ at, signed }: Awaited<ReturnType<typeof signedOn>>) => {
      const input = u8aToHex(u8aConcat(new Uint8Array([2]), signed.toU8a(), at.toU8a()));
      const validity = await chain.rpc.state.call("TaggedTransactionQueue_validate_transaction", input, at);
      return chain.registry.createType("TransactionValidity", validity) as any;
    };
    const forLastBlock = await admit(await signedOn(end - 1));
    expect(forLastBlock.isOk).toBe(true);
    expect(forLastBlock.asOk.longevity.toNumber()).toBe(1);
    const forNextBlock = await admit(await signedOn(end));
    expect(forNextBlock.isErr).toBe(true);
    expect(JSON.stringify(forNextBlock.asErr.toJSON())).toMatch(/ancientBirthBlock/i);
    // system_dryRun applies on a block's own state without opening the next block: it agrees.
    const dryRunOn = async (number: number) => {
      const { at, signed } = await signedOn(number);
      return chain.rpc.system.dryRun(signed.toHex(), at);
    };
    expect((await dryRunOn(end)).isOk).toBe(true);
    const expired = await dryRunOn(end + 1);
    expect(expired.isErr).toBe(true);
    expect(JSON.stringify(expired.asErr.toJSON())).toMatch(/ancientBirthBlock/i);
  }, 600_000);
});
