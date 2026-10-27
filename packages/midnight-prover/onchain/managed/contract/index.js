import * as __compactRuntime from '@midnight-ntwrk/compact-runtime';
__compactRuntime.checkRuntimeVersion('0.16.0');

const _descriptor_0 = new __compactRuntime.CompactTypeBytes(64);

const _descriptor_1 = new __compactRuntime.CompactTypeBytes(32);

const _descriptor_2 = new __compactRuntime.CompactTypeUnsignedInteger(18446744073709551615n, 8);

const _descriptor_3 = new __compactRuntime.CompactTypeUnsignedInteger(255n, 1);

class _Presentation_0 {
  alignment() {
    return _descriptor_3.alignment().concat(_descriptor_0.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment().concat(_descriptor_2.alignment()))))));
  }
  fromValue(value_0) {
    return {
      kind: _descriptor_3.fromValue(value_0),
      genesisHash: _descriptor_0.fromValue(value_0),
      rootHash: _descriptor_1.fromValue(value_0),
      anchorHash: _descriptor_1.fromValue(value_0),
      contextDigest: _descriptor_1.fromValue(value_0),
      commitment: _descriptor_1.fromValue(value_0),
      notAfter: _descriptor_2.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_3.toValue(value_0.kind).concat(_descriptor_0.toValue(value_0.genesisHash).concat(_descriptor_1.toValue(value_0.rootHash).concat(_descriptor_1.toValue(value_0.anchorHash).concat(_descriptor_1.toValue(value_0.contextDigest).concat(_descriptor_1.toValue(value_0.commitment).concat(_descriptor_2.toValue(value_0.notAfter)))))));
  }
}

const _descriptor_4 = new _Presentation_0();

const _descriptor_5 = new __compactRuntime.CompactTypeVector(2, _descriptor_1);

const _descriptor_6 = new __compactRuntime.CompactTypeBytes(18);

const _descriptor_7 = new __compactRuntime.CompactTypeBytes(1);

class _RollingPreimage_0 {
  alignment() {
    return _descriptor_6.alignment().concat(_descriptor_0.alignment().concat(_descriptor_7.alignment().concat(_descriptor_0.alignment())));
  }
  fromValue(value_0) {
    return {
      domain: _descriptor_6.fromValue(value_0),
      previous: _descriptor_0.fromValue(value_0),
      separator: _descriptor_7.fromValue(value_0),
      event: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_6.toValue(value_0.domain).concat(_descriptor_0.toValue(value_0.previous).concat(_descriptor_7.toValue(value_0.separator).concat(_descriptor_0.toValue(value_0.event))));
  }
}

const _descriptor_8 = new _RollingPreimage_0();

const _descriptor_9 = __compactRuntime.CompactTypeBoolean;

class _Either_0 {
  alignment() {
    return _descriptor_9.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_9.fromValue(value_0),
      left: _descriptor_1.fromValue(value_0),
      right: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_9.toValue(value_0.is_left).concat(_descriptor_1.toValue(value_0.left).concat(_descriptor_1.toValue(value_0.right)));
  }
}

const _descriptor_10 = new _Either_0();

const _descriptor_11 = new __compactRuntime.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);

class _ContractAddress_0 {
  alignment() {
    return _descriptor_1.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_1.toValue(value_0.bytes);
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
    if (typeof(witnesses_0.eventDigestHex) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named eventDigestHex');
    }
    if (typeof(witnesses_0.capability) !== 'function') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor does not contain a function-valued field named capability');
    }
    this.witnesses = witnesses_0;
    this.circuits = {
      presentationId(context, ...args_1) {
        return { result: pureCircuits.presentationId(...args_1), context };
      },
      proveRolling1: (...args_1) => {
        if (args_1.length !== 6) {
          throw new __compactRuntime.CompactError(`proveRolling1: expected 6 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const genesis_0 = args_1[1];
        const root_0 = args_1[2];
        const anchor_0 = args_1[3];
        const context_0 = args_1[4];
        const deadline_0 = args_1[5];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('proveRolling1',
                                     'argument 1 (as invoked from Typescript)',
                                     'orynq.compact line 48 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(genesis_0.buffer instanceof ArrayBuffer && genesis_0.BYTES_PER_ELEMENT === 1 && genesis_0.length === 64)) {
          __compactRuntime.typeError('proveRolling1',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'orynq.compact line 48 char 1',
                                     'Bytes<64>',
                                     genesis_0)
        }
        if (!(root_0.buffer instanceof ArrayBuffer && root_0.BYTES_PER_ELEMENT === 1 && root_0.length === 32)) {
          __compactRuntime.typeError('proveRolling1',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'orynq.compact line 48 char 1',
                                     'Bytes<32>',
                                     root_0)
        }
        if (!(anchor_0.buffer instanceof ArrayBuffer && anchor_0.BYTES_PER_ELEMENT === 1 && anchor_0.length === 32)) {
          __compactRuntime.typeError('proveRolling1',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'orynq.compact line 48 char 1',
                                     'Bytes<32>',
                                     anchor_0)
        }
        if (!(context_0.buffer instanceof ArrayBuffer && context_0.BYTES_PER_ELEMENT === 1 && context_0.length === 32)) {
          __compactRuntime.typeError('proveRolling1',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'orynq.compact line 48 char 1',
                                     'Bytes<32>',
                                     context_0)
        }
        if (!(typeof(deadline_0) === 'bigint' && deadline_0 >= 0n && deadline_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('proveRolling1',
                                     'argument 5 (argument 6 as invoked from Typescript)',
                                     'orynq.compact line 48 char 1',
                                     'Uint<0..18446744073709551616>',
                                     deadline_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_0.toValue(genesis_0).concat(_descriptor_1.toValue(root_0).concat(_descriptor_1.toValue(anchor_0).concat(_descriptor_1.toValue(context_0).concat(_descriptor_2.toValue(deadline_0))))),
            alignment: _descriptor_0.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment().concat(_descriptor_1.alignment().concat(_descriptor_2.alignment()))))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._proveRolling1_0(context,
                                               partialProofData,
                                               genesis_0,
                                               root_0,
                                               anchor_0,
                                               context_0,
                                               deadline_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      },
      proveCapability: (...args_1) => {
        if (args_1.length !== 4) {
          throw new __compactRuntime.CompactError(`proveCapability: expected 4 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const expectedCommitment_0 = args_1[1];
        const context_0 = args_1[2];
        const deadline_0 = args_1[3];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.currentQueryContext != undefined)) {
          __compactRuntime.typeError('proveCapability',
                                     'argument 1 (as invoked from Typescript)',
                                     'orynq.compact line 57 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(expectedCommitment_0.buffer instanceof ArrayBuffer && expectedCommitment_0.BYTES_PER_ELEMENT === 1 && expectedCommitment_0.length === 32)) {
          __compactRuntime.typeError('proveCapability',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'orynq.compact line 57 char 1',
                                     'Bytes<32>',
                                     expectedCommitment_0)
        }
        if (!(context_0.buffer instanceof ArrayBuffer && context_0.BYTES_PER_ELEMENT === 1 && context_0.length === 32)) {
          __compactRuntime.typeError('proveCapability',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'orynq.compact line 57 char 1',
                                     'Bytes<32>',
                                     context_0)
        }
        if (!(typeof(deadline_0) === 'bigint' && deadline_0 >= 0n && deadline_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('proveCapability',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'orynq.compact line 57 char 1',
                                     'Uint<0..18446744073709551616>',
                                     deadline_0)
        }
        const context = { ...contextOrig_0, gasCost: __compactRuntime.emptyRunningCost() };
        const partialProofData = {
          input: {
            value: _descriptor_1.toValue(expectedCommitment_0).concat(_descriptor_1.toValue(context_0).concat(_descriptor_2.toValue(deadline_0))),
            alignment: _descriptor_1.alignment().concat(_descriptor_1.alignment().concat(_descriptor_2.alignment()))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = this._proveCapability_0(context,
                                                 partialProofData,
                                                 expectedCommitment_0,
                                                 context_0,
                                                 deadline_0);
        partialProofData.output = { value: [], alignment: [] };
        return { result: result_0, context: context, proofData: partialProofData, gasCost: context.gasCost };
      }
    };
    this.impureCircuits = {
      proveRolling1: this.circuits.proveRolling1,
      proveCapability: this.circuits.proveCapability
    };
    this.provableCircuits = {
      proveRolling1: this.circuits.proveRolling1,
      proveCapability: this.circuits.proveCapability
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
    state_0.data = new __compactRuntime.ChargedState(stateValue_0);
    state_0.setOperation('proveRolling1', new __compactRuntime.ContractOperation());
    state_0.setOperation('proveCapability', new __compactRuntime.ContractOperation());
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
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(0n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(1n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(0n),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(new Uint8Array([111, 114, 121, 110, 113, 58, 112, 114, 111, 111, 102, 45, 112, 114, 101, 115, 101, 110, 116, 97, 116, 105, 111, 110, 115, 58, 118, 49, 0, 0, 0, 0])),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    state_0.data = new __compactRuntime.ChargedState(context.currentQueryContext.state.state);
    return {
      currentContractState: state_0,
      currentPrivateState: context.currentPrivateState,
      currentZswapLocalState: context.currentZswapLocalState
    }
  }
  _blockTimeLt_0(context, partialProofData, time_0) {
    return _descriptor_9.fromValue(__compactRuntime.queryLedgerState(context,
                                                                     partialProofData,
                                                                     [
                                                                      { dup: { n: 2 } },
                                                                      { idx: { cached: true,
                                                                               pushPath: false,
                                                                               path: [
                                                                                      { tag: 'value',
                                                                                        value: { value: _descriptor_3.toValue(2n),
                                                                                                 alignment: _descriptor_3.alignment() } }] } },
                                                                      { push: { storage: false,
                                                                                value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(time_0),
                                                                                                                             alignment: _descriptor_2.alignment() }).encode() } },
                                                                      'lt',
                                                                      { popeq: { cached: true,
                                                                                 result: undefined } }]).value);
  }
  _persistentHash_0(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_4, value_0);
    return result_0;
  }
  _persistentHash_1(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_8, value_0);
    return result_0;
  }
  _persistentHash_2(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_5, value_0);
    return result_0;
  }
  _eventDigestHex_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.eventDigestHex(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(result_0.buffer instanceof ArrayBuffer && result_0.BYTES_PER_ELEMENT === 1 && result_0.length === 64)) {
      __compactRuntime.typeError('eventDigestHex',
                                 'return value',
                                 'orynq.compact line 17 char 1',
                                 'Bytes<64>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_0.toValue(result_0),
      alignment: _descriptor_0.alignment()
    });
    return result_0;
  }
  _capability_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.capability(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    if (!(result_0.buffer instanceof ArrayBuffer && result_0.BYTES_PER_ELEMENT === 1 && result_0.length === 32)) {
      __compactRuntime.typeError('capability',
                                 'return value',
                                 'orynq.compact line 18 char 1',
                                 'Bytes<32>',
                                 result_0)
    }
    partialProofData.privateTranscriptOutputs.push({
      value: _descriptor_1.toValue(result_0),
      alignment: _descriptor_1.alignment()
    });
    return result_0;
  }
  _assertHex_0(value_0) {
    this._folder_0(((t_0, byte_0) =>
                    {
                      __compactRuntime.assert(byte_0 >= 48n && byte_0 <= 57n
                                              ||
                                              byte_0 >= 97n && byte_0 <= 102n,
                                              'noncanonical hex digest');
                      return t_0;
                    }),
                   [],
                   Array.from(value_0, BigInt));
    return [];
  }
  _presentationId_0(p_0) { return this._persistentHash_0(p_0); }
  _record_0(context, partialProofData, p_0) {
    const disclosed_0 = p_0;
    __compactRuntime.assert(this._blockTimeLt_0(context,
                                                partialProofData,
                                                disclosed_0.notAfter),
                            'proof deadline passed');
    const tmp_0 = this._presentationId_0(disclosed_0);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_3.toValue(1n),
                                                                  alignment: _descriptor_3.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(tmp_0),
                                                                                              alignment: _descriptor_1.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_4.toValue(disclosed_0),
                                                                                              alignment: _descriptor_4.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    return [];
  }
  _proveRolling1_0(context,
                   partialProofData,
                   genesis_0,
                   root_0,
                   anchor_0,
                   context_0,
                   deadline_0)
  {
    this._assertHex_0(genesis_0);
    const event_0 = this._eventDigestHex_0(context, partialProofData);
    this._assertHex_0(event_0);
    const input_0 = { domain:
                        new Uint8Array([112, 111, 105, 45, 116, 114, 97, 99, 101, 58, 114, 111, 108, 108, 58, 118, 49, 124]),
                      previous: genesis_0,
                      separator: new Uint8Array([124]),
                      event: event_0 };
    __compactRuntime.assert(this._equal_0(this._persistentHash_1(input_0),
                                          root_0),
                            'rolling root mismatch');
    this._record_0(context,
                   partialProofData,
                   { kind: 1n,
                     genesisHash: genesis_0,
                     rootHash: root_0,
                     anchorHash: anchor_0,
                     contextDigest: context_0,
                     commitment: new Uint8Array(32),
                     notAfter: deadline_0 });
    return [];
  }
  _proveCapability_0(context,
                     partialProofData,
                     expectedCommitment_0,
                     context_0,
                     deadline_0)
  {
    __compactRuntime.assert(this._equal_1(this._persistentHash_2([this._capability_0(context,
                                                                                     partialProofData),
                                                                  context_0]),
                                          expectedCommitment_0),
                            'capability mismatch');
    this._record_0(context,
                   partialProofData,
                   { kind: 2n,
                     genesisHash: new Uint8Array(64),
                     rootHash: new Uint8Array(32),
                     anchorHash: new Uint8Array(32),
                     contextDigest: context_0,
                     commitment: expectedCommitment_0,
                     notAfter: deadline_0 });
    return [];
  }
  _folder_0(f, x, a0) {
    for (let i = 0; i < 64; i++) { x = f(x, a0[i]); }
    return x;
  }
  _equal_0(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_1(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
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
      return _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_3.toValue(0n),
                                                                                                   alignment: _descriptor_3.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    presentations: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_9.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(1n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(0n),
                                                                                                                                 alignment: _descriptor_2.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(1n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'orynq.compact line 15 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_9.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(1n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_1.toValue(key_0),
                                                                                                                                 alignment: _descriptor_1.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(key_0.buffer instanceof ArrayBuffer && key_0.BYTES_PER_ELEMENT === 1 && key_0.length === 32)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'orynq.compact line 15 char 1',
                                     'Bytes<32>',
                                     key_0)
        }
        return _descriptor_4.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_3.toValue(1n),
                                                                                                     alignment: _descriptor_3.alignment() } }] } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_1.toValue(key_0),
                                                                                                     alignment: _descriptor_1.alignment() } }] } },
                                                                          { popeq: { cached: false,
                                                                                     result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[1];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_1.fromValue(key.value),      _descriptor_4.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    }
  };
}
const _emptyContext = {
  currentQueryContext: new __compactRuntime.QueryContext(new __compactRuntime.ContractState().data, __compactRuntime.dummyContractAddress())
};
const _dummyContract = new Contract({
  eventDigestHex: (...args) => undefined, capability: (...args) => undefined
});
export const pureCircuits = {
  presentationId: (...args_0) => {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`presentationId: expected 1 argument (as invoked from Typescript), received ${args_0.length}`);
    }
    const p_0 = args_0[0];
    if (!(typeof(p_0) === 'object' && typeof(p_0.kind) === 'bigint' && p_0.kind >= 0n && p_0.kind <= 255n && p_0.genesisHash.buffer instanceof ArrayBuffer && p_0.genesisHash.BYTES_PER_ELEMENT === 1 && p_0.genesisHash.length === 64 && p_0.rootHash.buffer instanceof ArrayBuffer && p_0.rootHash.BYTES_PER_ELEMENT === 1 && p_0.rootHash.length === 32 && p_0.anchorHash.buffer instanceof ArrayBuffer && p_0.anchorHash.BYTES_PER_ELEMENT === 1 && p_0.anchorHash.length === 32 && p_0.contextDigest.buffer instanceof ArrayBuffer && p_0.contextDigest.BYTES_PER_ELEMENT === 1 && p_0.contextDigest.length === 32 && p_0.commitment.buffer instanceof ArrayBuffer && p_0.commitment.BYTES_PER_ELEMENT === 1 && p_0.commitment.length === 32 && typeof(p_0.notAfter) === 'bigint' && p_0.notAfter >= 0n && p_0.notAfter <= 18446744073709551615n)) {
      __compactRuntime.typeError('presentationId',
                                 'argument 1',
                                 'orynq.compact line 37 char 1',
                                 'struct Presentation<kind: Uint<0..256>, genesisHash: Bytes<64>, rootHash: Bytes<32>, anchorHash: Bytes<32>, contextDigest: Bytes<32>, commitment: Bytes<32>, notAfter: Uint<0..18446744073709551616>>',
                                 p_0)
    }
    return _dummyContract._presentationId_0(p_0);
  }
};
export const contractReferenceLocations =
  { tag: 'publicLedgerArray', indices: { } };
//# sourceMappingURL=index.js.map
