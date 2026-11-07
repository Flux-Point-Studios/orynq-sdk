import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as L from "@midnightntwrk/ledger-v8";
import * as L9 from "@midnightntwrk/ledger-v9";
import { headerFromRpc, headerHash } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { NETWORK_IDENTITY } from "../src/preflight.js";

it.each([
  ["mainnet-ledger-prices.json", 1000300, "midnight:ledger-parameters[v5]:", L],
  ["mainnet-ledger9-prices.json", 2001100, "midnight:ledger-parameters[v8]:", L9],
] as const)("binds observed mainnet pricing in %s to its exact read-only RPC request and canonical header", (name, runtime, tag, ledger) => {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  expect(fixture.runtimeSpecVersion).toBe(runtime);
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
  expect(bytes.subarray(0, tag.length).toString("latin1")).toBe(tag);
  const parameters = ledger.LedgerParameters.deserialize(bytes);
  expect(parameters.serialize()).toEqual(new Uint8Array(bytes));
  for (const value of Object.values(parameters.feePrices)) expect(value).toBeGreaterThanOrEqual(0);
});
