import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, mkdir, rm, mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as runtime from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnight-ntwrk/ledger-v8";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../onchain");
const check = process.argv.includes("--check");
const output = check ? await mkdtemp(join(directory, ".check-")) : join(directory, "managed");
const compiler = process.env.COMPACTC ?? "compactc";
if (execFileSync(compiler, ["--version"], { encoding: "utf8" }).trim() !== "0.31.1") throw new Error("Compact compiler 0.31.1 is required");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  await mkdir(output, { recursive: true });
  execFileSync(compiler, [join(directory, "orynq.compact"), output], { stdio: "inherit" });
  const { Contract } = await import(pathToFileURL(join(output, "contract/index.js")).href);
  const unavailable = () => { throw new Error("constructor cannot request a witness"); };
  const initial = new Contract({ eventDigestHex: unavailable, capability: unavailable }).initialState(runtime.createConstructorContext(undefined, "0".repeat(64)));
  const state = ledger.ContractState.deserialize(initial.currentContractState.serialize());
  const verifierKeys = {};
  for (const name of ["proveCapability", "proveRolling1"]) {
    const key = await readFile(join(output, `keys/${name}.verifier`));
    verifierKeys[name] = hash(key);
    const op = new ledger.ContractOperation();
    op.verifierKey = key;
    state.setOperation(name, op);
  }
  state.maintenanceAuthority = new ledger.ContractMaintenanceAuthority([], 1, 0n);
  await writeFile(join(output, "initial-state.bin"), state.serialize());
  const files = {};
  for (const sub of ["contract", "keys", "zkir", "compiler"]) {
    for (const name of (await readdir(join(output, sub))).sort()) {
      if (name.endsWith(".map") || name.endsWith(".zkir") || sub === "compiler") continue;
      files[`${sub}/${name}`] = hash(await readFile(join(output, sub, name)));
    }
  }
  files["initial-state.bin"] = hash(state.serialize());
  const pins = { compiler: "0.31.1", compactRuntime: "0.16.0", ledger: "8.1.3", onchainRuntime: "3.1.2", zkir: "2.1.1", sourceSha256: hash(await readFile(join(directory, "orynq.compact"))), verifierKeys, codeHash: hash(Buffer.concat([state.operation("proveCapability").serialize(), state.operation("proveRolling1").serialize()])), initialStateSha256: files["initial-state.bin"], files };
  const encoded = JSON.stringify(pins, null, 2) + "\n";
  if (check) {
    if (await readFile(join(directory, "pins.json"), "utf8") !== encoded) throw new Error("Compiled artifacts differ from the on-chain pins");
  } else await writeFile(join(directory, "pins.json"), encoded);
  console.log(check ? "On-chain artifacts reproduce their pins" : "Compiled and pinned immutable proof presentations");
} finally {
  if (check) await rm(output, { recursive: true, force: true });
}
