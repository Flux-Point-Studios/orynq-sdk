import { createHash } from "node:crypto";
import { PROOF_PINS, type ProofStatement } from "@fluxpointstudios/orynq-sdk-midnight-prover";
import { LIMITS } from "./limits.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const PROOF_RELEASE_ACTION = "deploy immutable orynq proof presentations and post one synthetic proof per circuit on Midnight MAINNET";
export const PROOF_RELEASE_CAPABILITY = new Uint8Array(Buffer.from(hash("orynq:proof-release:synthetic-capability:v1"), "hex"));
export const PROOF_RELEASE_EVENT = hash("orynq:proof-release:synthetic-event:v1");
const contextDigest = hash("orynq:proof-release:synthetic-context:v1");
const genesisHash = hash("orynq:proof-release:synthetic-genesis:v1");
export function proofReleaseStatements(notAfter: number): ProofStatement[] {
  return [
    { circuit: "proveCapability", contextDigest, commitment: createHash("sha256").update(PROOF_RELEASE_CAPABILITY).update(Buffer.from(contextDigest, "hex")).digest("hex"), notAfter },
    { circuit: "proveRolling1", contextDigest, genesisHash, rootHash: hash(`poi-trace:roll:v1|${genesisHash}|${PROOF_RELEASE_EVENT}`), anchorHash: hash("orynq:proof-release:synthetic-anchor:v1"), notAfter },
  ];
}

export function proofReleaseIntent() {
  return {
    action: PROOF_RELEASE_ACTION,
    network: LIMITS.network,
    authority: "committee [] (0 members), threshold 1, counter 0",
    codeHash: PROOF_PINS.codeHash,
    initialStateSha256: PROOF_PINS.initialStateSha256,
    verifierKeys: PROOF_PINS.verifierKeys,
    payer: LIMITS.payer,
    statements: proofReleaseStatements(0).map(({ notAfter: _notAfter, ...statement }) => statement),
    maxFeeDust: "0.01",
  };
}
export type ProofReleaseIntent = ReturnType<typeof proofReleaseIntent>;
