# Task #36: Hash-Chain Proof Generation Implementation

## Summary

Implemented hash-chain validity proof generation for the `@fluxpointstudios/poi-sdk-midnight-prover` package. This implementation enables ZK proofs that demonstrate a sequence of trace events produces an expected rolling hash, binding the proof to a Cardano anchor transaction for cross-chain verification.

## Files Created/Modified

### New Files

1. **`packages/midnight-prover/src/proofs/hash-chain-proof.ts`**
   - `HashChainProver` class with:
     - `generateProof(input: HashChainInput): Promise<HashChainProof>` - Generates ZK proof
     - `verifyProof(proof: HashChainProof): Promise<boolean>` - Verifies proof validity
     - `getGenesisHash(): Promise<string>` - Returns genesis hash for chain initialization
   - Mock proof generation that simulates ZK proof creation
   - Complete input validation and error handling
   - Proof metrics tracking (provingTimeMs, proofSizeBytes)
   - Factory function `createHashChainProver(options)`

2. **`packages/midnight-prover/src/midnight/witness-builder.ts`**
   - `buildHashChainWitness(events, genesisHash)` - Converts trace events to circuit-compatible format
   - Event serialization using canonical JSON
   - Rolling hash computation matching process-trace algorithm
   - Witness validation and size computation utilities
   - Binary serialization for proof server transmission

3. **`packages/midnight-prover/src/midnight/public-inputs.ts`**
   - `buildPublicInputs(type, data)` - Constructs public inputs for all proof types
   - `serializePublicInputs(type, inputs)` - Binary serialization for circuit consumption
   - `hashPublicInputs(type, inputs)` - Hash commitment generation
   - Support for hash-chain, policy, attestation, disclosure, and inference proofs
   - Input validation and normalization (lowercase, no 0x prefix)

4. **`packages/midnight-prover/src/midnight/index.ts`**
   - Export aggregation for midnight utilities

5. **`packages/midnight-prover/src/proofs/index.ts`**
   - Export aggregation for proof generators

6. **`packages/midnight-prover/src/__tests__/hash-chain-proof.test.ts`**
   - 36 unit tests covering:
     - Proof generation and verification
     - Input validation and error handling
     - Witness building and validation
     - Public inputs construction
     - Factory functions and type guards

### Modified Files

1. **`packages/midnight-prover/src/index.ts`**
   - Added exports for new modules (HashChainProver, witness utilities, public inputs)

## Technical Details

### Rolling Hash Algorithm

The rolling hash computation matches the algorithm in `@fluxpointstudios/poi-sdk-process-trace`:
- Events sorted by sequence number
- Event hash: `H("poi-trace:event:v1|" + canonical(event - hash field))`
- Rolling hash: `H("poi-trace:roll:v1|" + prevHash + "|" + eventHash)`
- Genesis hash: `H("poi-trace:roll:v1|genesis")`

### Mock Proof Structure

Mock proofs include:
- Magic header: "MOCK-POI-HC-PROOF-V1"
- Witness hash (32 bytes) for integrity
- Serialized public inputs
- Random proof data (256 bytes placeholder)

### Public Inputs (Hash-Chain)

- `rootHash` - Final rolling hash (matches Cardano anchor)
- `eventCount` - Number of events in chain
- `cardanoAnchorTxHash` - Binding to Cardano L1 transaction

### Error Codes Used

- `INVALID_INPUT (5100)` - Invalid input data
- `WITNESS_TOO_LARGE (5023)` - Exceeds size limits
- `HASH_MISMATCH (5102)` - Computed hash does not match expected
- `INVALID_WITNESS (5022)` - Witness validation failed

## Build & Test

```bash
# Build the package
pnpm --filter @fluxpointstudios/poi-sdk-midnight-prover build

# Run tests
pnpm test -- packages/midnight-prover

# Expected output: 120 tests passing across 3 test files
```

## Recommended Tests for Test Engineer

The test engineer should verify the following:

### Unit Tests (Already Implemented)
- All 120 tests pass in `packages/midnight-prover/src/__tests__/`

### Integration Tests to Add
1. **End-to-end trace-to-proof flow**:
   - Create a trace using process-trace
   - Generate hash-chain proof
   - Verify proof matches trace root hash

2. **Cross-package compatibility**:
   - Verify genesis hash matches process-trace getGenesisHash()
   - Verify rolling hash computation produces same results as process-trace
   - Test with real TraceBundle from process-trace package

3. **Edge cases**:
   - Maximum event count (10,000)
   - Maximum witness size (50 MB)
   - Events out of sequence order
   - Events with various visibility levels
   - Empty events (should fail validation)

4. **Error handling**:
   - Invalid hash formats (too short, invalid characters)
   - Hash mismatch scenarios
   - Resource limit exceeded

### Test Commands

```bash
# Run specific test file
pnpm test -- packages/midnight-prover/src/__tests__/hash-chain-proof.test.ts

# Run with verbose output
pnpm test -- packages/midnight-prover --reporter=verbose

# Run with coverage
pnpm test -- packages/midnight-prover --coverage
```

## Notes

- Current implementation uses mock proof generation
- Real Midnight Compact circuit integration will be added in future tasks
- The proof binds to Cardano anchor via `cardanoAnchorTxHash` public input
- TeeType values updated to match attestor package: "sev-snp", "tdx", "sgx", "nitro", "gpu-cc"

---

**Orchestrator Instructions**: Have the test engineer read this file and run the recommended tests. The test engineer should also verify integration with the process-trace package to ensure hash computation consistency.
