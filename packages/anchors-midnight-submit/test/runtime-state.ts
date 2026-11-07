import { CODE_KEYS, FORK, PENDING_CODE_KEYS, forkBlock, recorded } from "../../anchors-midnight/src/__tests__/fork-chain.js";
import { replaceProofValue } from "../../anchors-midnight/src/__tests__/proof-node.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
// A block state whose code runs `spec` for the next block: the recorded mainnet state of a block
// before the Ledger 9 fork for 1000300 and after it for 2001100, with its :code and :pending_code
// read proof. Any other runtime gets 1000300's state with its code hash replaced, code no runtime
// table holds.
const RUNTIME_STATES = new Map<number, { root: Buffer; proof: string[] }>();
const CODE_1000300 = "39568eeb0802fa59d74ac0bc5c7ab62fc05c23ea947937458a4b011558516138";
export function runtimeState(spec: number) {
  let state = RUNTIME_STATES.get(spec);
  if (!state) {
    const block = forkBlock(spec === 2001100 ? FORK.firstLedger9 : FORK.setCode - 1);
    const { proof } = recorded<{ proof: string[] }>("state_getReadProof", [[CODE_KEYS, PENDING_CODE_KEYS], `0x${block.blockHash}`]);
    if (spec === 1000300 || spec === 2001100) state = { root: Buffer.from(block.header.stateRoot), proof };
    else {
      const code = proof.find((node) => node.includes(CODE_1000300))!;
      const forged = replaceProofValue(proof, `0x${hex(block.header.stateRoot)}`, code, code.replace(CODE_1000300, spec.toString(16).padStart(64, "c")));
      state = { root: Buffer.from(forged.root.slice(2), "hex"), proof: forged.nodes };
    }
    RUNTIME_STATES.set(spec, state);
  }
  return state;
}

