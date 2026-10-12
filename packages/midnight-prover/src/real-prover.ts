import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as runtime from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import { provingProvider } from "@midnight-ntwrk/zkir-v2";
import type { Contract } from "../managed/contract/index.js";

const HASH = /^[0-9a-f]{64}$/;
const MAX_LINKS = 128;
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const CIRCUITS = {
  "rolling-hash-chain-v1": "proveRolling1",
  "lease-capability-v1": "proveCapability",
} as const;

export interface RealProverOptions {
  artifactsDir: string;
  nativeVerifierPath: string;
  paramsDir: string;
}

export interface CircuitProof {
  version: 1;
  circuitId: keyof typeof CIRCUITS;
  transactionBase64: string;
  referenceStateBase64: string;
  verificationTimeUnixSeconds: number;
}

export interface CapabilityProof extends CircuitProof {
  proofType: "lease-capability-v1";
  publicInputs: { contextDigest: string; commitment: string };
}

export interface RollingHashChainProof {
  version: 1;
  proofType: "rolling-hash-chain-v1";
  publicInputs: {
    genesisHash: string;
    rootHash: string;
    eventCount: number;
    anchorHash: string;
    contextDigest: string;
  };
  links: CircuitProof[];
}

function requireHash(value: string): Uint8Array {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error("Expected a canonical SHA-256 digest");
  return new Uint8Array(Buffer.from(value, "hex"));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > MAX_ENVELOPE_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Malformed proof encoding");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) throw new Error("Malformed proof encoding");
  return bytes;
}

export class RealMidnightProver {
  private readonly options: Readonly<RealProverOptions>;

  constructor(options: RealProverOptions) {
    if (![options.artifactsDir, options.nativeVerifierPath, options.paramsDir].every(isAbsolute)) {
      throw new Error("Trusted artifact and verifier paths must be absolute");
    }
    this.options = Object.freeze({ ...options });
  }

  async proveCapability(input: { capability: Uint8Array; contextDigest: string; commitment: string }): Promise<CapabilityProof> {
    if (!(input.capability instanceof Uint8Array) || input.capability.length !== 32) throw new Error("Capability must contain 32 bytes");
    const context = requireHash(input.contextDigest);
    const commitment = requireHash(input.commitment);
    const publicInputs = { contextDigest: input.contextDigest, commitment: input.commitment };
    const secret = new Uint8Array(input.capability);
    try {
      const proof = await this.proveCircuit("lease-capability-v1", new Uint8Array(64), secret, [commitment, context]);
      return { ...proof, proofType: "lease-capability-v1", publicInputs };
    } finally {
      secret.fill(0);
    }
  }

  async proveRollingHashChain(input: { eventHashes: string[]; genesisHash: string; rootHash: string; anchorHash: string; contextDigest: string }): Promise<RollingHashChainProof> {
    input = { ...input, eventHashes: [...input.eventHashes] };
    if (input.eventHashes.length === 0 || input.eventHashes.length > MAX_LINKS) throw new Error("Rolling chain must contain 1 to 128 digests");
    requireHash(input.genesisHash);
    requireHash(input.rootHash);
    const anchor = requireHash(input.anchorHash);
    const context = requireHash(input.contextDigest);
    const roots = input.eventHashes.reduce<string[]>((values, event) => {
      requireHash(event);
      const previous = values.at(-1) ?? input.genesisHash;
      values.push(createHash("sha256").update(`poi-trace:roll:v1|${previous}|${event}`).digest("hex"));
      return values;
    }, []);
    if (roots.at(-1) !== input.rootHash) throw new Error("Rolling root mismatch");
    const links: CircuitProof[] = [];
    for (let index = 0; index < roots.length; index++) {
      const previous = roots[index - 1] ?? input.genesisHash;
      const event = new TextEncoder().encode(input.eventHashes[index]!);
      links.push(await this.proveCircuit("rolling-hash-chain-v1", event, new Uint8Array(32), [new TextEncoder().encode(previous), requireHash(roots[index]!), anchor, context]));
    }
    return {
      version: 1,
      proofType: "rolling-hash-chain-v1",
      publicInputs: { genesisHash: input.genesisHash, rootHash: input.rootHash, eventCount: links.length, anchorHash: input.anchorHash, contextDigest: input.contextDigest },
      links,
    };
  }

  async verify(value: unknown): Promise<boolean> {
    try {
      if (!record(value) || value["version"] !== 1 || value["simulation"] !== undefined) return false;
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized) > MAX_ENVELOPE_BYTES) return false;
      value = JSON.parse(serialized) as unknown;
      if (!record(value) || value["version"] !== 1 || value["simulation"] !== undefined) return false;
      if (value["proofType"] === "lease-capability-v1") {
        const proof = value as unknown as CapabilityProof;
        requireHash(proof.publicInputs.contextDigest);
        requireHash(proof.publicInputs.commitment);
        const result = await this.verifyCircuit(proof, "lease-capability-v1");
        return result !== undefined &&
          Buffer.from(result.contextDigest).toString("hex") === proof.publicInputs.contextDigest &&
          Buffer.from(result.commitment).toString("hex") === proof.publicInputs.commitment;
      }
      if (value["proofType"] !== "rolling-hash-chain-v1") return false;
      const proof = value as unknown as RollingHashChainProof;
      const inputs = proof.publicInputs;
      for (const digest of [inputs.genesisHash, inputs.rootHash, inputs.anchorHash, inputs.contextDigest]) requireHash(digest);
      if (!Array.isArray(proof.links) || proof.links.length === 0 || proof.links.length > MAX_LINKS || inputs.eventCount !== proof.links.length) return false;
      let previous = inputs.genesisHash;
      for (const link of proof.links) {
        const result = await this.verifyCircuit(link, "rolling-hash-chain-v1");
        if (result === undefined || result.eventCount !== 1n || Buffer.from(result.genesisHash).toString("utf8") !== previous || Buffer.from(result.anchorHash).toString("hex") !== inputs.anchorHash || Buffer.from(result.contextDigest).toString("hex") !== inputs.contextDigest) return false;
        previous = Buffer.from(result.rootHash).toString("hex");
      }
      return previous === inputs.rootHash;
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  }

  private async contract() {
    return await import(pathToFileURL(join(this.options.artifactsDir, "contract/index.js")).href) as typeof import("../managed/contract/index.js");
  }

  private async proveCircuit(circuitId: keyof typeof CIRCUITS, event: Uint8Array, secret: Uint8Array, args: Uint8Array[]): Promise<CircuitProof> {
    const entryPoint = CIRCUITS[circuitId];
    const module = await this.contract();
    const contract = new module.Contract({ eventDigestHex: ctx => [ctx.privateState, event], capability: ctx => [ctx.privateState, secret] });
    const coinKey = ledger.sampleCoinPublicKey();
    const initial = contract.initialState(runtime.createConstructorContext(undefined, coinKey));
    const template = ledger.ContractState.deserialize(await readFile(join(this.options.artifactsDir, "initial-state.bin")));
    const deploy = new ledger.ContractDeploy(template);
    const reference = ledger.LedgerState.blank("undeployed");
    const now = new Date();
    const seconds = BigInt(Math.floor(now.getTime() / 1000));
    const block = { secondsSinceEpoch: seconds, secondsSinceEpochErr: 0, parentBlockHash: "0".repeat(64), lastBlockTime: seconds - 1n };
    const ttl = new Date(now.getTime() + 3_600_000);
    const strictness = new ledger.WellFormedStrictness();
    strictness.enforceBalancing = false;
    const provider = provingProvider({
      lookupKey: async name => {
        if (!Object.values(CIRCUITS).includes(name as "proveRolling1" | "proveCapability")) return undefined;
        return {
          proverKey: new Uint8Array(await readFile(join(this.options.artifactsDir, "keys", `${name}.prover`))),
          verifierKey: new Uint8Array(await readFile(join(this.options.artifactsDir, "keys", `${name}.verifier`))),
          ir: new Uint8Array(await readFile(join(this.options.artifactsDir, "zkir", `${name}.bzkir`))),
        };
      },
      getParams: async k => new Uint8Array(await readFile(join(this.options.paramsDir, `bls_midnight_2p${k}`))),
    });
    const deployment = ledger.Transaction.fromParts("undeployed", undefined, undefined, ledger.Intent.new(ttl).addDeploy(deploy));
    const finalizedDeploy = (await deployment.prove(provider, ledger.CostModel.initialCostModel())).bind();
    const [state, result] = reference.apply(finalizedDeploy.wellFormed(reference, strictness, now), new ledger.TransactionContext(reference, block));
    if (result.type !== "success") throw new Error("Local proof reference initialization failed");
    const context = runtime.createCircuitContext(deploy.address, coinKey, initial.currentContractState, undefined);
    const circuit = contract.circuits[entryPoint] as Contract["circuits"]["proveRolling1"];
    const circuitResult = entryPoint === "proveRolling1"
      ? circuit(context, args[0]!, args[1]!, args[2]!, args[3]!)
      : contract.circuits.proveCapability(context, args[0]!, args[1]!);
    const data = circuitResult.proofData;
    const operation = template.operation(entryPoint);
    if (operation === undefined) throw new Error("Missing trusted circuit operation");
    const call = new ledger.PrePartitionContractCall(deploy.address, entryPoint, operation,
      new ledger.PreTranscript(new ledger.QueryContext(template.data, deploy.address), data.publicTranscript),
      data.privateTranscriptOutputs, data.input, data.output, ledger.communicationCommitmentRandomness(), entryPoint);
    const transaction = ledger.Transaction.fromParts("undeployed").addCalls({ tag: "first" }, [call], ledger.LedgerParameters.initialParameters(), ttl);
    const proven = (await transaction.prove(provider, ledger.CostModel.initialCostModel())).bind();
    const proof: CircuitProof = { version: 1, circuitId, transactionBase64: Buffer.from(proven.serialize()).toString("base64"), referenceStateBase64: Buffer.from(state.serialize()).toString("base64"), verificationTimeUnixSeconds: Number(seconds) };
    if (!await this.nativeVerify({ circuitId, transactionBase64: proof.transactionBase64, referenceStateBase64: proof.referenceStateBase64, verificationTimeUnixSeconds: Math.floor(Date.now() / 1000) })) {
      throw new Error("Generated proof failed native verification");
    }
    return proof;
  }

  private async verifyCircuit(proof: CircuitProof, circuitId: keyof typeof CIRCUITS) {
    if (!record(proof) || proof.version !== 1 || proof.circuitId !== circuitId || proof["simulation"] !== undefined) return undefined;
    const txBytes = strictBase64(proof.transactionBase64);
    const stateBytes = strictBase64(proof.referenceStateBase64);
    const verified = await this.nativeVerify({ circuitId, transactionBase64: proof.transactionBase64, referenceStateBase64: proof.referenceStateBase64, verificationTimeUnixSeconds: Math.floor(Date.now() / 1000) });
    if (!verified) return undefined;
    const module = await this.contract();
    const state = ledger.LedgerState.deserialize(stateBytes);
    const transaction = ledger.Transaction.deserialize("signature", "proof", "binding", txBytes);
    const strictness = new ledger.WellFormedStrictness();
    strictness.enforceBalancing = false;
    const now = new Date();
    const seconds = BigInt(Math.floor(now.getTime() / 1000));
    const block = { secondsSinceEpoch: seconds, secondsSinceEpochErr: 0, parentBlockHash: "0".repeat(64), lastBlockTime: seconds - 1n };
    // Cryptographic acceptance comes from the native verifier; WASM only decodes the proven state change.
    const [updated, result] = state.apply(transaction.wellFormed(state, strictness, now), new ledger.TransactionContext(state, block));
    if (result.type !== "success") return undefined;
    const calls = [...(transaction.intents?.values() ?? [])].flatMap(intent => intent.actions).filter(action => action instanceof ledger.ContractCall);
    if (calls.length !== 1) return undefined;
    const contractState = updated.index(calls[0]!.address);
    if (contractState === undefined) return undefined;
    return module.ledger(runtime.ContractState.deserialize(contractState.serialize()).data);
  }

  private nativeVerify(input: Omit<CircuitProof, "version">): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn(this.options.nativeVerifierPath, ["--registry", join(this.options.artifactsDir, "registry.json")], { shell: false, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
      let stdout = "";
      let overflow = false;
      child.stdout.on("data", (data: Buffer) => {
        if (stdout.length + data.length > 4096) overflow = true;
        if (!overflow) stdout += data.toString("utf8");
      });
      child.stderr.resume();
      child.on("error", () => resolve(false));
      child.on("close", code => {
        if (code !== 0 || overflow) { resolve(false); return; }
        try {
          const result: unknown = JSON.parse(stdout);
          resolve(record(result) && Object.keys(result).length === 2 && result["valid"] === true && result["code"] === "verified");
        } catch (error) {
          if (error instanceof SyntaxError) resolve(false);
          else throw error;
        }
      });
      child.stdin.on("error", () => resolve(false));
      child.stdin.end(JSON.stringify(input));
    });
  }
}
