import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIDNIGHT_HOSTED_PREPROD, networkEndpoints } from "../src/endpoints.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-endpoints-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const projectIdFile = join(dir, "project_id");
writeFileSync(projectIdFile, "preprodProjectId0123456789abcdef\n", { mode: 0o600 });

describe("networkEndpoints", () => {
  it("reads mainnet through Blockfrost only, with the project id from its owner-only file", () => {
    expect(networkEndpoints("mainnet", { blockfrostProjectIdFile: projectIdFile })).toEqual({
      operator: "blockfrost",
      indexer: "https://midnight-mainnet.blockfrost.io/api/v0",
      indexerWs: "wss://midnight-mainnet.blockfrost.io/api/v0/ws",
      node: "https://rpc.midnight-mainnet.blockfrost.io",
      headers: { project_id: "preprodProjectId0123456789abcdef" },
    });
    expect(() => networkEndpoints("mainnet")).toThrow(/mainnet needs a Blockfrost project id file: Midnight's hosted mainnet endpoints were retired on 2026-09-30/);
  });

  it("reads preprod through Midnight's hosted endpoints, or through Blockfrost when given a project id file", () => {
    expect(networkEndpoints("preprod")).toEqual(MIDNIGHT_HOSTED_PREPROD);
    expect(MIDNIGHT_HOSTED_PREPROD).toEqual({
      operator: "midnight",
      indexer: "https://indexer.preprod.midnight.network/api/v3/graphql",
      indexerWs: "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
      node: "https://rpc.preprod.midnight.network",
      headers: {},
    });
    expect(networkEndpoints("preprod", { blockfrostProjectIdFile: projectIdFile }).indexer).toBe("https://midnight-preprod.blockfrost.io/api/v0");
  });
});
