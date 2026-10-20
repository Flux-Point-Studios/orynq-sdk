import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as runtime from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnight-ntwrk/ledger-v8";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(directory, "managed");
const compiler = process.env.COMPACTC ?? "compactc";
const version = execFileSync(compiler, ["--version"], { encoding: "utf8" }).trim();
if (version !== "0.31.1") throw new Error("Compact compiler 0.31.1 is required");
await rm(output, { recursive: true, force: true });
execFileSync(compiler, [join(directory, "circuits/orynq.compact"), output], { stdio: "inherit" });
const { Contract } = await import(pathToFileURL(join(output, "contract/index.js")).href);
const contract = new Contract({ eventDigestHex: ctx => [ctx.privateState, new Uint8Array(64)], capability: ctx => [ctx.privateState, new Uint8Array(32)] });
const initial = contract.initialState(runtime.createConstructorContext(undefined, "0".repeat(64)));
const template = ledger.ContractState.deserialize(initial.currentContractState.serialize());
const circuits = { "rolling-hash-chain-v1": "proveRolling1", "lease-capability-v1": "proveCapability" };
for (const entryPoint of Object.values(circuits)) {
  const key = await readFile(join(output, "keys", `${entryPoint}.verifier`));
  const operation = new ledger.ContractOperation();
  operation.verifierKey = key;
  template.setOperation(entryPoint, operation);
}
await writeFile(join(output, "initial-state.bin"), template.serialize());
await writeFile(join(output, "registry.json"), JSON.stringify({ version: 1, circuits: Object.fromEntries(Object.entries(circuits).map(([id, entryPoint]) => [id, { entryPoint, verifierKeyPath: `keys/${entryPoint}.verifier`, initialContractStatePath: "initial-state.bin" }])) }, null, 2) + "\n");
console.log("Compiled real circuits and trusted verifier registry");
