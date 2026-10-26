import * as __compactRuntime from '@midnight-ntwrk/compact-runtime';
__compactRuntime.checkRuntimeVersion('0.16.0');

const _descriptor_0 = new __compactRuntime.CompactTypeBytes(32);

const _descriptor_1 = new __compactRuntime.CompactTypeUnsignedInteger(255n, 1);

const _descriptor_2 = new __compactRuntime.CompactTypeUnsignedInteger(65535n, 2);

class _HiddenEntry_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment())));
  }
  fromValue(value_0) {
    return {
      root_hash: _descriptor_0.fromValue(value_0),
      manifest_hash: _descriptor_0.fromValue(value_0),
      merkle_root: _descriptor_0.fromValue(value_0),
      salt: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.root_hash).concat(_descriptor_0.toValue(value_0.manifest_hash).concat(_descriptor_0.toValue(value_0.merkle_root).concat(_descriptor_0.toValue(value_0.salt))));
  }
}

const _descriptor_3 = new _HiddenEntry_0();

const _descriptor_4 = new __compactRuntime.CompactTypeVector(3, _descriptor_0);

const _descriptor_5 = new __compactRuntime.CompactTypeVector(4, _descriptor_0);

const _descriptor_6 = new __compactRuntime.CompactTypeVector(5, _descriptor_0);

const _descriptor_7 = new __compactRuntime.CompactTypeVector(2, _descriptor_0);

const _descriptor_8 = new __compactRuntime.CompactTypeUnsignedInteger(18446744073709551615n, 8);

const _descriptor_9 = __compactRuntime.CompactTypeBoolean;

class _Either_0 {
  alignment() {
    return _descriptor_9.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_9.fromValue(value_0),
      left: _descriptor_0.fromValue(value_0),
      right: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_9.toValue(value_0.is_left).concat(_descriptor_0.toValue(value_0.left).concat(_descriptor_0.toValue(value_0.right)));
  }
}

const _descriptor_10 = new _Either_0();

const _descriptor_11 = new __compactRuntime.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);

class _ContractAddress_0 {
  alignment() {
    return _descriptor_0.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.bytes);
  }
}

const _descriptor_12 = new _ContractAddress_0();

export class Contract {
  witnesses;
  constructor(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`Contract constructor: expected 1 argument, received ${args_0.length}`);
    }
    const witnesses_0 = args_0[0];
    if (typeof(witnesses_0) !== 'object') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor is not an object');
    }
    if (typeof(witnesses_0.author_secret) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named author_secret');
    }
    if (typeof(witnesses_0.hidden_entry) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named hidden_entry');
    }
    this.witnesses = witnesses_0;
    this.circuits = {
      author_key(context, ...args_1) {
        return { result: pureCircuits.author_key(...args_1), context };
      },
      entry_digest(context, ...args_1) {
        return { result: pureCircuits.entry_digest(...args_1), context };
      },
      hidden_digest(context, ...args_1) {
        return { result: pureCircuits.hidden_digest(...args_1), context };
      },
      hiding_commitment(context, ...args_1) {
        return { result: pureCircuits.hiding_commitment(...args_1), context };
      },
      derive_salt(context, ...args_1) {
        return { result: pureCircuits.derive_salt(...args_1), context };
      },
      anchor: (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(`anchor: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const commitment_0 = args_1[1];
        const kind_0 = args_1[2];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('anchor',
                                     'argument 1 (as invoked from Typescript)',
                                     'orynq-anchor-registry.compact line 66 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(commitment_0.buffer instanceof ArrayBuffer && commitment_0.BYTES_PER_ELEMENT === 1 && commitment_0.length === 32)) {
          __compactRuntime.typeError('anchor',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'orynq-anchor-registry.compact line 66 char 1',
                                     'Bytes<32>',
                                     commitment_0)
        }
        if (!(typeof(kind_0) === 'bigint' && kind_0 >= 0n && kind_0 <= 255n)) {
          __compactRuntime.typeError('anchor',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'orynq-anchor-registry.compact line 66 char 1',
                                     'Uint<0..256>',
                                     kind_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(commitment_0).concat(_descriptor_1.toValue(kind_0)),
            alignment: _descriptor_0.alignment().concat(_descriptor_1.alignment())
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._anchor_0(context,
                                        partialProofData,
                                        commitment_0,
                                        kind_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      anchor_hiding: (...args_1) => {
        if (args_1.length !== 2) {
          throw new __compactRuntime.CompactError(`anchor_hiding: expected 2 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const attribute_0 = args_1[1];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('anchor_hiding',
                                     'argument 1 (as invoked from Typescript)',
                                     'orynq-anchor-registry.compact line 75 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(attribute_0.buffer instanceof ArrayBuffer && attribute_0.BYTES_PER_ELEMENT === 1 && attribute_0.length === 32)) {
          __compactRuntime.typeError('anchor_hiding',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'orynq-anchor-registry.compact line 75 char 1',
                                     'Bytes<32>',
                                     attribute_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(attribute_0),
            alignment: _descriptor_0.alignment()
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._anchor_hiding_0(context,
                                               partialProofData,
                                               attribute_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      }
    };
    this.impureCircuits = {
      anchor: this.circuits.anchor,
      anchor_hiding: this.circuits.anchor_hiding
    };
    this.provableCircuits = {
      anchor: this.circuits.anchor,
      anchor_hiding: this.circuits.anchor_hiding
    };
  }
  initialState(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 1 argument (as invoked from Typescript), received ${args_0.length}`);
    }
    const constructorContext_0 = args_0[0];
    if (typeof(constructorContext_0) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'constructorContext' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!('initialPrivateState' in constructorContext_0)) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialPrivateState' in argument 1 (as invoked from Typescript)`);
    }
    if (!('initialZswapLocalState' in constructorContext_0)) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript)`);
    }
    if (typeof(constructorContext_0.initialZswapLocalState) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript) to be an object`);
    }
    const state_0 = new __compactRuntime.ContractState();
    let stateValue_0 = __compactRuntime.StateValue.newArray();
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    state_0.data = new __compactRuntime.ChargedState(stateValue_0);
    state_0.setOperation('anchor', new __compactRuntime.ContractOperation());
    state_0.setOperation('anchor_hiding', new __compactRuntime.ContractOperation());
    const context = __compactRuntime.createCircuitContext(__compactRuntime.dummyContractAddress(), constructorContext_0.initialZswapLocalState.coinPublicKey, state_0.data, constructorContext_0.initialPrivateState);
    const partialProofData = {
      input: { value: [], alignment: [] },
      output: undefined,
      publicTranscript: [],
      privateTranscriptOutputs: []
    };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(1n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_8.toValue(0n),
                                                                                              alignment: _descriptor_8.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(2n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(3n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(4n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(5n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(0n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array([111, 114, 121, 110, 113, 45, 97, 110, 99, 104, 111, 114, 45, 114, 101, 103, 105, 115, 116, 114, 121, 58, 118, 49, 0, 0, 0, 0, 0, 0, 0, 0])),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    state_0.data = new __compactRuntime.ChargedState(context.currentQueryContext.state.state);
    return {
      currentContractState: state_0,
      currentPrivateState: context.currentPrivateState,
      currentZswapLocalState: context.currentZswapLocalState
    }
  }
  _persistentHash_0(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_7, value_0);
    return result_0;
  }
  _persistentHash_1(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_5, value_0);
    return result_0;
  }
  _persistentHash_2(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_6, value_0);
    return result_0;
  }
  _persistentHash_3(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_4, value_0);
    return result_0;
  }
  _persistentCommit_0(value_0, rand_0) {
    const result_0 = __compactRuntime.persistentCommit(_descriptor_0,
                                                       value_0,
                                                       rand_0);
    return result_0;
  }
  _author_secret_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.author_secret(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(result_0.buffer instanceof ArrayBuffer && result_0.BYTES_PER_ELEMENT === 1 && result_0.length === 32)) {
      __compactRuntime.typeError('author_secret',
                                 'return value',
                                 'orynq-anchor-registry.compact line 38 char 1',
                                 'Bytes<32>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_0.toValue(result_0),
      alignment: _descriptor_0.alignment()
    });
    return result_0;
  }
  _hidden_entry_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.hidden_entry(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(typeof(result_0) === 'object' && result_0.root_hash.buffer instanceof ArrayBuffer && result_0.root_hash.BYTES_PER_ELEMENT === 1 && result_0.root_hash.length === 32 && result_0.manifest_hash.buffer instanceof ArrayBuffer && result_0.manifest_hash.BYTES_PER_ELEMENT === 1 && result_0.manifest_hash.length === 32 && result_0.merkle_root.buffer instanceof ArrayBuffer && result_0.merkle_root.BYTES_PER_ELEMENT === 1 && result_0.merkle_root.length === 32 && result_0.salt.buffer instanceof ArrayBuffer && result_0.salt.BYTES_PER_ELEMENT === 1 && result_0.salt.length === 32)) {
      __compactRuntime.typeError('hidden_entry',
                                 'return value',
                                 'orynq-anchor-registry.compact line 39 char 1',
                                 'struct HiddenEntry<root_hash: Bytes<32>, manifest_hash: Bytes<32>, merkle_root: Bytes<32>, salt: Bytes<32>>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_3.toValue(result_0),
      alignment: _descriptor_3.alignment()
    });
    return result_0;
  }
  _author_key_0(sk_0) {
    return this._persistentHash_0([new Uint8Array([111, 114, 121, 110, 113, 58, 97, 110, 99, 104, 111, 114, 58, 97, 117, 116, 104, 111, 114, 58, 118, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                   sk_0]);
  }
  _entry_digest_0(root_hash_0, manifest_hash_0, merkle_root_0) {
    return this._persistentHash_1([new Uint8Array([111, 114, 121, 110, 113, 58, 97, 110, 99, 104, 111, 114, 45, 101, 110, 116, 114, 121, 58, 118, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                   root_hash_0,
                                   manifest_hash_0,
                                   merkle_root_0]);
  }
  _hidden_digest_0(root_hash_0, manifest_hash_0, merkle_root_0, attribute_0) {
    return this._persistentHash_2([new Uint8Array([111, 114, 121, 110, 113, 58, 97, 110, 99, 104, 111, 114, 45, 104, 105, 100, 100, 101, 110, 58, 118, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                   root_hash_0,
                                   manifest_hash_0,
                                   merkle_root_0,
                                   attribute_0]);
  }
  _hiding_commitment_0(digest_0, salt_0) {
    return this._persistentCommit_0(digest_0, salt_0);
  }
  _derive_salt_0(salt_key_0, digest_0) {
    return this._persistentHash_3([new Uint8Array([111, 114, 121, 110, 113, 58, 97, 110, 99, 104, 111, 114, 45, 115, 97, 108, 116, 58, 118, 49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
                                   salt_key_0,
                                   digest_0]);
  }
  _anchor_0(context, partialProofData, commitment_0, kind_0) {
    __compactRuntime.assert(!this._equal_0(kind_0, 2n),
                            'kind 2 is written only by anchor_hiding');
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(2n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(commitment_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(3n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(kind_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    const tmp_0 = new Uint8Array(32);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(5n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(tmp_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    const tmp_1 = this._author_key_0(this._author_secret_0(context,
                                                           partialProofData));
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(4n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(tmp_1),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    const tmp_2 = 1n;
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_1.toValue(1n),
                                                                  alignment: _descriptor_1.alignment() } }] } },
                                       { addi: { immediate: parseInt(__compactRuntime.valueToBigInt(
                                                              { value: _descriptor_2.toValue(tmp_2),
                                                                alignment: _descriptor_2.alignment() }
                                                                .value
                                                            )) } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  _anchor_hiding_0(context, partialProofData, attribute_0) {
    const e_0 = this._hidden_entry_0(context, partialProofData);
    const c_0 = this._hiding_commitment_0(this._hidden_digest_0(e_0.root_hash,
                                                                e_0.manifest_hash,
                                                                e_0.merkle_root,
                                                                attribute_0),
                                          e_0.salt);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(2n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(c_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    const tmp_0 = 2n;
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(3n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(tmp_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(5n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(attribute_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    const tmp_1 = this._author_key_0(this._author_secret_0(context,
                                                           partialProofData));
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(4n),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(tmp_1),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    const tmp_2 = 1n;
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_1.toValue(1n),
                                                                  alignment: _descriptor_1.alignment() } }] } },
                                       { addi: { immediate: parseInt(__compactRuntime.valueToBigInt(
                                                              { value: _descriptor_2.toValue(tmp_2),
                                                                alignment: _descriptor_2.alignment() }
                                                                .value
                                                            )) } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  _equal_0(x0, y0) {
    if (x0 !== y0) { return false; }
    return true;
  }
}
export function ledger(stateOrChargedState) {
  const state = stateOrChargedState instanceof __compactRuntime.StateValue ? stateOrChargedState : stateOrChargedState.state;
  const chargedState = stateOrChargedState instanceof __compactRuntime.StateValue ? new __compactRuntime.ChargedState(stateOrChargedState) : stateOrChargedState;
  const context = {
    currentQueryContext: new __compactRuntime.QueryContext(chargedState, __compactRuntime.dummyContractAddress()),
    costModel: __compactRuntime.CostModel.initialCostModel()
  };
  const partialProofData = {
    input: { value: [], alignment: [] },
    output: undefined,
    publicTranscript: [],
    privateTranscriptOutputs: []
  };
  return {
    get schema() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_1.toValue(0n),
                                                                                                   alignment: _descriptor_1.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get anchors() {
      return _descriptor_8.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_1.toValue(1n),
                                                                                                   alignment: _descriptor_1.alignment() } }] } },
                                                                        { popeq: { cached: true,
                                                                                   result: undefined } }]).value);
    },
    get last_commitment() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_1.toValue(2n),
                                                                                                   alignment: _descriptor_1.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get last_kind() {
      return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_1.toValue(3n),
                                                                                                   alignment: _descriptor_1.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get last_author() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_1.toValue(4n),
                                                                                                   alignment: _descriptor_1.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get last_attribute() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_1.toValue(5n),
                                                                                                   alignment: _descriptor_1.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    }
  };
}
const _emptyContext = {
  currentQueryContext: new __compactRuntime.QueryContext(new __compactRuntime.ContractState().data, __compactRuntime.dummyContractAddress())
};
const _dummyContract = new Contract({
  author_secret: (...args) => undefined, hidden_entry: (...args) => undefined
});
export const pureCircuits = {
  author_key: (...args_0) => {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`author_key: expected 1 argument (as invoked from Typescript), received ${args_0.length}`);
    }
    const sk_0 = args_0[0];
    if (!(sk_0.buffer instanceof ArrayBuffer && sk_0.BYTES_PER_ELEMENT === 1 && sk_0.length === 32)) {
      __compactRuntime.typeError('author_key',
                                 'argument 1',
                                 'orynq-anchor-registry.compact line 45 char 1',
                                 'Bytes<32>',
                                 sk_0)
    }
    return _dummyContract._author_key_0(sk_0);
  },
  entry_digest: (...args_0) => {
    if (args_0.length !== 3) {
      throw new __compactRuntime.CompactError(`entry_digest: expected 3 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const root_hash_0 = args_0[0];
    const manifest_hash_0 = args_0[1];
    const merkle_root_0 = args_0[2];
    if (!(root_hash_0.buffer instanceof ArrayBuffer && root_hash_0.BYTES_PER_ELEMENT === 1 && root_hash_0.length === 32)) {
      __compactRuntime.typeError('entry_digest',
                                 'argument 1',
                                 'orynq-anchor-registry.compact line 49 char 1',
                                 'Bytes<32>',
                                 root_hash_0)
    }
    if (!(manifest_hash_0.buffer instanceof ArrayBuffer && manifest_hash_0.BYTES_PER_ELEMENT === 1 && manifest_hash_0.length === 32)) {
      __compactRuntime.typeError('entry_digest',
                                 'argument 2',
                                 'orynq-anchor-registry.compact line 49 char 1',
                                 'Bytes<32>',
                                 manifest_hash_0)
    }
    if (!(merkle_root_0.buffer instanceof ArrayBuffer && merkle_root_0.BYTES_PER_ELEMENT === 1 && merkle_root_0.length === 32)) {
      __compactRuntime.typeError('entry_digest',
                                 'argument 3',
                                 'orynq-anchor-registry.compact line 49 char 1',
                                 'Bytes<32>',
                                 merkle_root_0)
    }
    return _dummyContract._entry_digest_0(root_hash_0,
                                          manifest_hash_0,
                                          merkle_root_0);
  },
  hidden_digest: (...args_0) => {
    if (args_0.length !== 4) {
      throw new __compactRuntime.CompactError(`hidden_digest: expected 4 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const root_hash_0 = args_0[0];
    const manifest_hash_0 = args_0[1];
    const merkle_root_0 = args_0[2];
    const attribute_0 = args_0[3];
    if (!(root_hash_0.buffer instanceof ArrayBuffer && root_hash_0.BYTES_PER_ELEMENT === 1 && root_hash_0.length === 32)) {
      __compactRuntime.typeError('hidden_digest',
                                 'argument 1',
                                 'orynq-anchor-registry.compact line 53 char 1',
                                 'Bytes<32>',
                                 root_hash_0)
    }
    if (!(manifest_hash_0.buffer instanceof ArrayBuffer && manifest_hash_0.BYTES_PER_ELEMENT === 1 && manifest_hash_0.length === 32)) {
      __compactRuntime.typeError('hidden_digest',
                                 'argument 2',
                                 'orynq-anchor-registry.compact line 53 char 1',
                                 'Bytes<32>',
                                 manifest_hash_0)
    }
    if (!(merkle_root_0.buffer instanceof ArrayBuffer && merkle_root_0.BYTES_PER_ELEMENT === 1 && merkle_root_0.length === 32)) {
      __compactRuntime.typeError('hidden_digest',
                                 'argument 3',
                                 'orynq-anchor-registry.compact line 53 char 1',
                                 'Bytes<32>',
                                 merkle_root_0)
    }
    if (!(attribute_0.buffer instanceof ArrayBuffer && attribute_0.BYTES_PER_ELEMENT === 1 && attribute_0.length === 32)) {
      __compactRuntime.typeError('hidden_digest',
                                 'argument 4',
                                 'orynq-anchor-registry.compact line 53 char 1',
                                 'Bytes<32>',
                                 attribute_0)
    }
    return _dummyContract._hidden_digest_0(root_hash_0,
                                           manifest_hash_0,
                                           merkle_root_0,
                                           attribute_0);
  },
  hiding_commitment: (...args_0) => {
    if (args_0.length !== 2) {
      throw new __compactRuntime.CompactError(`hiding_commitment: expected 2 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const digest_0 = args_0[0];
    const salt_0 = args_0[1];
    if (!(digest_0.buffer instanceof ArrayBuffer && digest_0.BYTES_PER_ELEMENT === 1 && digest_0.length === 32)) {
      __compactRuntime.typeError('hiding_commitment',
                                 'argument 1',
                                 'orynq-anchor-registry.compact line 57 char 1',
                                 'Bytes<32>',
                                 digest_0)
    }
    if (!(salt_0.buffer instanceof ArrayBuffer && salt_0.BYTES_PER_ELEMENT === 1 && salt_0.length === 32)) {
      __compactRuntime.typeError('hiding_commitment',
                                 'argument 2',
                                 'orynq-anchor-registry.compact line 57 char 1',
                                 'Bytes<32>',
                                 salt_0)
    }
    return _dummyContract._hiding_commitment_0(digest_0, salt_0);
  },
  derive_salt: (...args_0) => {
    if (args_0.length !== 2) {
      throw new __compactRuntime.CompactError(`derive_salt: expected 2 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const salt_key_0 = args_0[0];
    const digest_0 = args_0[1];
    if (!(salt_key_0.buffer instanceof ArrayBuffer && salt_key_0.BYTES_PER_ELEMENT === 1 && salt_key_0.length === 32)) {
      __compactRuntime.typeError('derive_salt',
                                 'argument 1',
                                 'orynq-anchor-registry.compact line 62 char 1',
                                 'Bytes<32>',
                                 salt_key_0)
    }
    if (!(digest_0.buffer instanceof ArrayBuffer && digest_0.BYTES_PER_ELEMENT === 1 && digest_0.length === 32)) {
      __compactRuntime.typeError('derive_salt',
                                 'argument 2',
                                 'orynq-anchor-registry.compact line 62 char 1',
                                 'Bytes<32>',
                                 digest_0)
    }
    return _dummyContract._derive_salt_0(salt_key_0, digest_0);
  }
};
export const contractReferenceLocations =
  { tag: 'publicLedgerArray', indices: { } };
//# sourceMappingURL=index.js.map
