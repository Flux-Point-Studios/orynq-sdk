import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Presentation = { kind: bigint;
                             genesisHash: Uint8Array;
                             rootHash: Uint8Array;
                             anchorHash: Uint8Array;
                             contextDigest: Uint8Array;
                             commitment: Uint8Array;
                             notAfter: bigint
                           };

export type Witnesses<PS> = {
  eventDigestHex(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  capability(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  proveRolling1(context: __compactRuntime.CircuitContext<PS>,
                genesis_0: Uint8Array,
                root_0: Uint8Array,
                anchor_0: Uint8Array,
                context_0: Uint8Array,
                deadline_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  proveCapability(context: __compactRuntime.CircuitContext<PS>,
                  expectedCommitment_0: Uint8Array,
                  context_0: Uint8Array,
                  deadline_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  proveRolling1(context: __compactRuntime.CircuitContext<PS>,
                genesis_0: Uint8Array,
                root_0: Uint8Array,
                anchor_0: Uint8Array,
                context_0: Uint8Array,
                deadline_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  proveCapability(context: __compactRuntime.CircuitContext<PS>,
                  expectedCommitment_0: Uint8Array,
                  context_0: Uint8Array,
                  deadline_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
  presentationId(p_0: Presentation): Uint8Array;
}

export type Circuits<PS> = {
  presentationId(context: __compactRuntime.CircuitContext<PS>, p_0: Presentation): __compactRuntime.CircuitResults<PS, Uint8Array>;
  proveRolling1(context: __compactRuntime.CircuitContext<PS>,
                genesis_0: Uint8Array,
                root_0: Uint8Array,
                anchor_0: Uint8Array,
                context_0: Uint8Array,
                deadline_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  proveCapability(context: __compactRuntime.CircuitContext<PS>,
                  expectedCommitment_0: Uint8Array,
                  context_0: Uint8Array,
                  deadline_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly schema: Uint8Array;
  presentations: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Presentation;
    [Symbol.iterator](): Iterator<[Uint8Array, Presentation]>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
