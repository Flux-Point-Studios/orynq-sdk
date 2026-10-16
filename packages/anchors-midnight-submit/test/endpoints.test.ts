import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkEndpoints } from "../src/endpoints.js";

const dir = mkdtempSync(join(tmpdir(), "orynq-endpoints-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const projectIdFile = join(dir, "project_id");
writeFileSync(projectIdFile, "preprodProjectId0123456789abcdefABCDEFG\n", { mode: 0o600 });

describe("networkEndpoints", () => {
  it("reads mainnet through Blockfrost only, with the project id from its owner-only file", () => {
    expect(networkEndpoints("mainnet", { blockfrostProjectIdFile: projectIdFile })).toEqual({
      operator: "blockfrost",
      indexer: "https://midnight-mainnet.blockfrost.io/api/v0",
      indexerWs: "wss://midnight-mainnet.blockfrost.io/api/v0/ws",
      node: "https://rpc.midnight-mainnet.blockfrost.io",
      headers: { project_id: "preprodProjectId0123456789abcdefABCDEFG" },
    });
    expect(() => networkEndpoints("mainnet")).toThrow(/mainnet needs a Blockfrost project id file: Midnight's hosted mainnet endpoints were retired on 2026-09-30/);
  });

  it("reads preprod through Blockfrost only too, since Midnight's hosted preprod node refuses a request the size of any deploy or anchor", () => {
    expect(networkEndpoints("preprod", { blockfrostProjectIdFile: projectIdFile })).toEqual({
      operator: "blockfrost",
      indexer: "https://midnight-preprod.blockfrost.io/api/v0",
      indexerWs: "wss://midnight-preprod.blockfrost.io/api/v0/ws",
      node: "https://rpc.midnight-preprod.blockfrost.io",
      headers: { project_id: "preprodProjectId0123456789abcdefABCDEFG" },
    });
    expect(() => networkEndpoints("preprod")).toThrow(
      "preprod needs a Blockfrost project id file: Midnight's hosted preprod node refuses JSON-RPC request bodies over about 7 KB, smaller than any deploy or anchor",
    );
  });
});
