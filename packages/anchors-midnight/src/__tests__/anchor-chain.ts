import { readFileSync } from "node:fs";
import type { FinalityCheckpoint } from "../grandpa.js";
import { signKnownAuthors, knownAuthors, type KnownAuthor } from "../known-authors.js";
import type { RegistryInfo } from "../registries.js";
import { REGISTRY_VERIFIER_KEY_SHA256, registryInitialState } from "../registry.js";
import { concatBytes, encodeCompact, fromHex, toHex } from "../scale.js";
import type { IndexedTransaction, MidnightSource } from "../source.js";
import { headerHash, orderedTrieRoot } from "../substrate.js";
import { ed25519PublicKey } from "../ed25519.js";
import { syntheticChain } from "./grandpa-chain.js";
import { random32 } from "./registry-call.js";

export const fixture = JSON.parse(readFileSync(new URL("./fixtures/registry-transactions.json", import.meta.url), "utf8"));

// A bare v4 Midnight.send_mn_transaction(tx), framed as a block body holds it.
export const sendMnTransaction = (tx: Uint8Array) => {
  const call = concatBytes(new Uint8Array([4, 5, 0]), encodeCompact(tx.length), tx);
  return concatBytes(encodeCompact(call.length), call);
};
const inherent = (height: number) => concatBytes(new Uint8Array([0x28, 5, 1, 0]), new Uint8Array(Buffer.from(height.toString(16).padStart(14, "0").slice(-14), "hex")));

export const DEPLOY_HEIGHT = 1450;
export const HEIGHTS = { anchor: 2020, hiding: 2021, stranger: 2022 } as const;

// The registry fixture's transactions on a synthetic chain finalized by a synthetic GRANDPA
// set, read through a MidnightSource. `bodies` replaces a block's body (its header commits to
// whatever body it is given) and `node`/`indexer` replace answers, for adversarial variants.
export function anchorChain({
  bodies = new Map<number, Uint8Array[]>(),
  node = {},
  indexer = {},
  place = [],
}: {
  bodies?: Map<number, Uint8Array[]>;
  node?: Record<string, (params: unknown[], honest: () => unknown) => unknown>;
  indexer?: Record<string, (honest: IndexedTransaction[]) => IndexedTransaction[]>;
  // More transactions, each alone in a block: [height, "deploy" | "anchor", tx hex, tx hash].
  place?: Array<[number, "deploy" | "anchor", string, string]>;
} = {}) {
  const placed = new Map<number, { name: string; tx: string; txHash: string }>([
    [DEPLOY_HEIGHT, { name: "deploy", tx: fixture.registry.tx, txHash: fixture.registry.txHash }],
    [HEIGHTS.anchor, { name: "anchor", ...fixture.anchor }],
    [HEIGHTS.hiding, { name: "hiding", ...fixture.hiding }],
    [HEIGHTS.stranger, { name: "stranger", ...fixture.stranger }],
    ...place.map(([height, name, tx, txHash]) => [height, { name, tx, txHash }] as const),
  ]);
  const bodyAt = (h: number) =>
    bodies.get(h) ?? [inherent(h), ...(placed.has(h) ? [sendMnTransaction(fromHex(placed.get(h)!.tx, "tx"))] : [])];
  const chain = syntheticChain({ firstSetId: 40n, genesisEnd: 1000, setLengths: () => 300, setCount: 6, extrinsicsRootOf: (h) => orderedTrieRoot(bodyAt(h)) });
  const stateHex = toHex(registryInitialState().serialize());
  const indexed = new Map<string, IndexedTransaction>(
    [...placed].map(([height, p]) => [
      p.txHash,
      {
        hash: p.txHash,
        raw: p.tx,
        block: { height, hash: toHex(headerHash(chain.header(height))), timestamp: 1_791_000_000_000 + height * 6000 },
        status: "SUCCESS",
        contractActions: [{ kind: p.name === "deploy" ? "ContractDeploy" : "ContractCall", address: fixture.registry.address, state: stateHex, ...(p.name === "deploy" ? {} : { entryPoint: p.name === "hiding" ? "anchor_hiding" : "anchor" }) }],
      },
    ]),
  );
  const heightOf = (hash: string) => chain.byHash(hash).number;
  const honest: Record<string, (params: unknown[]) => unknown> = {
    chain_getBlockHash: ([h]) => `0x${toHex(headerHash(chain.header(h as number)))}`,
    chain_getBlock: ([hash]) => {
      const h = heightOf(hash as string);
      return { block: { header: chain.rpcHeader(chain.header(h)), extrinsics: bodyAt(h).map((e) => `0x${toHex(e)}`) }, justifications: null };
    },
    state_getRuntimeVersion: () => ({ specName: "midnight", specVersion: 1000300, transactionVersion: 3, stateVersion: 3 }),
    midnight_contractState: () => `0x${stateHex}`,
    chain_getHeader: ([hash]) => chain.rpcHeader(chain.header(heightOf(hash as string))),
  };
  const answer = async (method: string, params: unknown[]) => {
    if (method === "grandpa_proveFinality") {
      const [proof] = await chain.rpc.proveFinality([params[0] as number]);
      return proof ? `0x${toHex(proof)}` : null;
    }
    const base = honest[method];
    if (!base) throw new Error(`synthetic node: no ${method}`);
    return node[method] ? node[method]!(params, () => base(params)) : base(params);
  };
  const source: MidnightSource = {
    operator: "synthetic",
    indexer: {
      async transactions(hash) {
        const found = indexed.has(hash) ? [indexed.get(hash)!] : [];
        return indexer[hash] ? indexer[hash]!(found) : found;
      },
      async head() {
        const tip = chain.endOf(5);
        return { height: tip, hash: toHex(headerHash(chain.header(tip))), timestamp: 1_791_000_000_000 + tip * 6000 };
      },
      async latestAction() {
        const [height] = [...placed.keys()].sort((a, b) => b - a);
        return { height: height!, transactionId: height! };
      },
      async *contractActions(address, fromHeight) {
        for (const [height, p] of [...placed].sort(([a], [b]) => a - b)) {
          if (height >= fromHeight && address === fixture.registry.address) {
            yield { txHash: p.txHash, transactionId: height, raw: p.tx, block: { height, hash: toHex(headerHash(chain.header(height))) } };
          }
        }
      },
    },
    node: {
      async call<T>(method: string, params: unknown[] = []) {
        return (await answer(method, params)) as T;
      },
      async batch<T>(calls: Array<[string, unknown[]]>) {
        return Promise.all(calls.map(([m, p]) => answer(m, p) as Promise<T>));
      },
    },
  };

  const registry: RegistryInfo = {
    generation: 1,
    address: fixture.registry.address,
    deployTxHash: fixture.registry.txHash,
    deployHeight: DEPLOY_HEIGHT,
    runtimeSpecVersion: 1000300,
    circuits: { anchor: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor }, anchor_hiding: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor_hiding } },
  };
  const checkpoint: FinalityCheckpoint = chain.checkpoint(0);
  const rootSeed = random32();
  const authors = (entries: Array<Partial<KnownAuthor>> = [{}]) =>
    knownAuthors({
      trustRoots: [toHex(ed25519PublicKey(rootSeed))],
      documents: [
        signKnownAuthors(
          JSON.stringify({
            format: "orynq-known-authors/v1",
            serial: 1,
            issued: "2026-10-04T00:00:00Z",
            networks: {
              mainnet: {
                authors: entries.map((e) => ({ key: fixture.author.key, id: "fluxpoint-relay", role: "relay", validFrom: DEPLOY_HEIGHT, validTo: null, ...e })),
                checkpoints: [
                  {
                    setId: checkpoint.setId.toString(),
                    startsAfter: checkpoint.startsAfter,
                    authorities: checkpoint.authorities.map((a) => ({ key: a.key, weight: a.weight.toString() })),
                  },
                ],
              },
            },
          }),
          rootSeed,
        ),
      ],
    });
  return { source, registry, authors, chain, indexed, stateHex, block: (name: keyof typeof HEIGHTS) => chain.block(HEIGHTS[name]) };
}
