import { readFileSync } from "node:fs";
import type { ProvingProvider } from "@midnight-ntwrk/ledger-v8";

const fixture = JSON.parse(readFileSync(new URL("../../anchors-midnight/src/__tests__/fixtures/registry-transactions.json", import.meta.url), "utf8")) as { proof: string };
// These bytes exercise transcript decoding and orchestration, never cryptographic acceptance.
export function withFixtureProof(provider: ProvingProvider): ProvingProvider {
  return { check: (p, l) => provider.check(p, l), prove: async () => Buffer.from(fixture.proof, "hex") };
}
