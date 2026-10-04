import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type HiddenEntry = { root_hash: Uint8Array;
                            manifest_hash: Uint8Array;
                            merkle_root: Uint8Array;
                            salt: Uint8Array
                          };

export type Witnesses<PS> = {
  author_secret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  hidden_entry(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, HiddenEntry];
}

export type ImpureCircuits<PS> = {
  anchor(context: __compactRuntime.CircuitContext<PS>,
         commitment_0: Uint8Array,
         kind_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  anchor_hiding(context: __compactRuntime.CircuitContext<PS>,
                attribute_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  anchor(context: __compactRuntime.CircuitContext<PS>,
         commitment_0: Uint8Array,
         kind_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  anchor_hiding(context: __compactRuntime.CircuitContext<PS>,
                attribute_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
  author_key(sk_0: Uint8Array): Uint8Array;
  entry_digest(root_hash_0: Uint8Array,
               manifest_hash_0: Uint8Array,
               merkle_root_0: Uint8Array): Uint8Array;
  hidden_digest(root_hash_0: Uint8Array,
                manifest_hash_0: Uint8Array,
                merkle_root_0: Uint8Array,
                attribute_0: Uint8Array): Uint8Array;
  hiding_commitment(digest_0: Uint8Array, salt_0: Uint8Array): Uint8Array;
  derive_salt(salt_key_0: Uint8Array, digest_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  author_key(context: __compactRuntime.CircuitContext<PS>, sk_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  entry_digest(context: __compactRuntime.CircuitContext<PS>,
               root_hash_0: Uint8Array,
               manifest_hash_0: Uint8Array,
               merkle_root_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  hidden_digest(context: __compactRuntime.CircuitContext<PS>,
                root_hash_0: Uint8Array,
                manifest_hash_0: Uint8Array,
                merkle_root_0: Uint8Array,
                attribute_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  hiding_commitment(context: __compactRuntime.CircuitContext<PS>,
                    digest_0: Uint8Array,
                    salt_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  derive_salt(context: __compactRuntime.CircuitContext<PS>,
              salt_key_0: Uint8Array,
              digest_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  anchor(context: __compactRuntime.CircuitContext<PS>,
         commitment_0: Uint8Array,
         kind_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  anchor_hiding(context: __compactRuntime.CircuitContext<PS>,
                attribute_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly schema: Uint8Array;
  readonly anchors: bigint;
  readonly last_commitment: Uint8Array;
  readonly last_kind: bigint;
  readonly last_author: Uint8Array;
  readonly last_attribute: Uint8Array;
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
