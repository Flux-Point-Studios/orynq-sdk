/**
 * `signAt` against polkadot.js itself (#213), offline: the real ApiPromise, types and signer over
 * polkadot.js's own MockProvider (Substrate dev metadata, no node). It shows that the explicit
 * era and block hash are the ones polkadot.js signs with by default, that the block hash is in
 * the signed payload, and that the reported mortality end is the real era's end.
 *
 * The mock provider and TypeRegistry are loaded from the packages installed next to
 * @polkadot/api, in the CommonJS build: the ESM mock imports JSON with a syntax Node 22 rejects.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiPromise } from "@polkadot/api";
import type { KeyringPair } from "@polkadot/keyring/types";
import { hexToU8a } from "@polkadot/util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mortalityEnd, signAt } from "../src/submission.js";

/** A block number above one era period, so an era read below its birth resolves one period early. */
const SIGNING_BLOCK = 1000;
const NONCE = 5;

describe("signAt with polkadot.js", () => {
  let api: ApiPromise;
  let alice: KeyringPair;
  const methods: string[] = [];

  beforeAll(async () => {
    const scope = dirname(realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../node_modules/@polkadot/api")));
    const load = createRequire(join(scope, "api/cjs/index.js"));
    const polkadot = load(join(scope, "api/cjs/index.js"));
    const { TypeRegistry } = load(join(scope, "types/cjs/index.js"));
    const { MockProvider } = load(join(scope, "rpc-provider/cjs/mock/index.js"));
    const registry = new TypeRegistry();
    const provider = new MockProvider(registry);
    const send = provider.send.bind(provider);
    provider.send = async (method: string, params: unknown[]) => {
      methods.push(method);
      if (method === "system_accountNextIndex") return NONCE;
      const result = await send(method, params);
      return method === "chain_getHeader" ? { ...result, number: SIGNING_BLOCK } : result;
    };
    api = await polkadot.ApiPromise.create({ provider, registry, noInitWarn: true });
    alice = new polkadot.Keyring({ type: "sr25519" }).addFromUri("//Alice");
  }, 30_000);
  afterAll(async () => { await api?.disconnect(); });

  /** Whether `signature` signs the extrinsic's payload when its era is anchored at `blockHash`. */
  function signsOver(signed: Awaited<ReturnType<typeof signAt>>["signed"], blockHash: string) {
    const payload = api.registry.createType("SignerPayload", {
      address: alice.address, blockHash, era: signed.era, genesisHash: api.genesisHash, method: signed.method,
      nonce: signed.nonce, runtimeVersion: api.runtimeVersion, signedExtensions: api.registry.signedExtensions,
      tip: signed.tip, version: api.extrinsicVersion,
    });
    return alice.verify(hexToU8a(payload.toRaw().data), signed.signature, alice.publicKey);
  }

  it("signs against the header polkadot.js picks, with its nonce, and reports that block as the birth", async () => {
    const info = await api.derive.tx.signingInfo(alice.address, -1);
    const { signed, born } = await signAt(api, api.tx.system!.remark!("0x00"), alice);
    expect(born).toBe(SIGNING_BLOCK);
    expect(info.header!.number.toNumber()).toBe(SIGNING_BLOCK);
    expect(signed.isSigned).toBe(true);
    expect(signed.nonce.toNumber()).toBe(NONCE);
    expect(signed.era.isMortalEra).toBe(true);
    expect(signed.era.asMortalEra.birth(born)).toBe(born);
    expect(signsOver(signed, info.header!.hash.toHex())).toBe(true);
    expect(signsOver(signed, api.genesisHash.toHex())).toBe(false);
  });

  it("puts the same era and nonce on the wire as polkadot.js's default signing", async () => {
    const { signed } = await signAt(api, api.tx.system!.remark!("0x00"), alice);
    const byDefault = await api.tx.system!.remark!("0x00").signAsync(alice, { nonce: -1 });
    expect(signed.era.toHex()).toBe(byDefault.era.toHex());
    expect(signed.nonce.toNumber()).toBe(byDefault.nonce.toNumber());
    expect(signed.tip.toString()).toBe(byDefault.tip.toString());
    expect(signed.method.toHex()).toBe(byDefault.method.toHex());
  });

  it("reads the nonce and the signing block once, not again inside signAsync", async () => {
    methods.length = 0;
    await signAt(api, api.tx.system!.remark!("0x00"), alice);
    expect(methods.filter(method => method === "system_accountNextIndex")).toHaveLength(1);
    expect(methods.filter(method => method === "chain_getFinalizedHead")).toHaveLength(1);
  });

  it("reports the era's real end from its birth block, where a best block below the birth ends it a period early", async () => {
    const { signed, born } = await signAt(api, api.tx.system!.remark!("0x00"), alice);
    const period = signed.era.asMortalEra.period.toNumber();
    expect(period).toBeGreaterThanOrEqual(4);
    expect(mortalityEnd(signed.era, born)).toBe(born + period - 1);
    // What a best block read after signing gives once a reorg leaves it below the birth block.
    expect(mortalityEnd(signed.era, born - 1)).toBe(born - 1);
    // Any block inside the window gives the same end; only the birth block is always inside it.
    expect(mortalityEnd(signed.era, born + period - 1)).toBe(born + period - 1);
  });
});
