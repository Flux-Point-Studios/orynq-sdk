import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as L from "@midnight-ntwrk/ledger-v8";
import { headerFromRpc, headerHash } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { NETWORK_IDENTITY } from "../src/preflight.js";

it("binds observed mainnet pricing to its exact read-only RPC request and canonical header", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/mainnet-ledger-prices.json", import.meta.url), "utf8"));
  const bytes = Buffer.from(fixture.parametersHex, "hex");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.parametersSha256);
  const returned = Buffer.from(fixture.runtimeApiResult.slice(2), "hex");
  expect(returned[0]).toBe(0); // Runtime API Result::Ok.
  expect(returned.readUInt16LE(1) & 3).toBe(1); // SCALE compact two-byte Vec length.
  expect(returned.readUInt16LE(1) >> 2).toBe(bytes.length);
  expect(returned.subarray(3)).toEqual(bytes);
  expect(fixture.request).toEqual({ method: "state_call", params: ["MidnightRuntimeApi_get_ledger_parameters", "0x", `0x${fixture.blockHash}`] });
  expect(fixture.genesis).toBe(NETWORK_IDENTITY.mainnet.genesis);
  const header = headerFromRpc(fixture.header);
  expect(header.number).toBe(fixture.blockHeight);
  expect(Buffer.from(headerHash(header)).toString("hex")).toBe(fixture.blockHash);
  const parameters = L.LedgerParameters.deserialize(bytes);
  expect(parameters.serialize()).toEqual(new Uint8Array(bytes));
  for (const value of Object.values(parameters.feePrices)) expect(value).toBeGreaterThanOrEqual(0);
});
