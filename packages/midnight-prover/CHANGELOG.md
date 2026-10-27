# @fluxpointstudios/poi-sdk-midnight-prover

## 0.3.0

### Minor Changes

- f0422aa: Add an immutable proof-presentation contract with current-state gas estimates, bounded transcript-refusal retries (JSON-RPC 1010/custom 104, including gas exhaustion) and headroom for concurrent insertions, local proving and wallet-supplied submission, and verification of its exact deployment and calls through authenticated execution and GRANDPA finality. Export the shared finalized-transaction verifier and identify the legacy ProofPublisher as a simulator. Preprod deployment and both circuits are rehearsed; the immutable mainnet deployment and both synthetic presentations were recorded on 2026-10-27 with independent fresh-consumer consensus-verified verdicts. Export the shared typed/legacy node-refusal decoder and retain numeric refusal codes in redacted source errors. Bind posted-proof trust roots to an allowlisted network genesis and both transactions’ encoded network ids and reject malformed private digests with value-free errors.
- 880a99d: Distinguish unavailable or misconfigured native verification from completed invalid-proof verdicts with `NativeVerifierConfigurationError`, including CLI exit 2. Remove the unused caller verification clock from newly generated envelopes and native requests; the proved deadline and verifier's own clock remain authoritative. Update the native binary together with this SDK release.

  Enforce reviewed verifier-key and initial-state SHA-256 pins during circuit compilation and release packing, and compile official circuit identities into the native verifier. Update the native rustls dependency and gate native CI with an explicit advisory policy.

- 00d99e4: Export the frozen PROOF_DEPLOYMENTS catalog with the FPS mainnet and preprod proof-contract addresses, deployment transaction hashes and block hints, code hashes and initial-state digests. Record the 2026-10-27 mainnet deployment and both independently consensus-verified synthetic presentations, and show the catalog in the posting and fresh-install verification examples.

### Patch Changes

- a8372ea: Keep posted-proof expectations and trusted finality checkpoints fixed throughout asynchronous verification, so caller mutations cannot relabel a verified transaction or change its deployment and trust configuration.
- 366b819: Capture the proof posting network, contract, wallet, statement and owned witness before asynchronous reads so caller mutation cannot redirect the post or bypass witness validation.
- Updated dependencies [3e5a8ba]
- Updated dependencies [b7caae1]
- Updated dependencies [ffa932e]
- Updated dependencies [a8372ea]
- Updated dependencies [d4880f0]
- Updated dependencies [2556602]
- Updated dependencies [8ab961d]
- Updated dependencies [f0422aa]
- Updated dependencies [54d8bd9]
- Updated dependencies [dc99b03]
- Updated dependencies [95e1f75]
- Updated dependencies [4448fd9]
  - @fluxpointstudios/orynq-sdk-anchors-midnight@0.4.0
  - @fluxpointstudios/orynq-sdk-anchors-cardano@0.5.0
  - @fluxpointstudios/orynq-sdk-core@0.3.2
  - @fluxpointstudios/orynq-sdk-attestor@0.1.1
  - @fluxpointstudios/orynq-sdk-process-trace@0.3.1

## 0.2.0

### Minor Changes

- 4933586: Add genuine Compact capability and rolling-digest proofs with a pinned native ledger verifier. Each proof carries a proved deadline at most one hour ahead, which a rewritten transaction TTL cannot extend. Verification binds public outputs to the expected statement and refuses untrusted keys, altered ledger parameters, malformed transactions and simulations. Existing mock APIs require explicit simulation mode and cannot provide production proof or publication claims.

  Require an MCP SDK version containing the OAuth credential handling fix.

## 0.1.2

### Patch Changes

- Updated dependencies [a918a40]
  - @fluxpointstudios/orynq-sdk-anchors-cardano@0.4.0

## 0.1.1

### Patch Changes

- Updated dependencies [48f2049]
- Updated dependencies [48f2049]
- Updated dependencies [48f2049]
- Updated dependencies [2efef73]
- Updated dependencies [48f2049]
  - @fluxpointstudios/orynq-sdk-anchors-cardano@0.3.0
  - @fluxpointstudios/orynq-sdk-process-trace@0.3.0

## 0.1.0

### Minor Changes

- 79dea4d: feat: Add Midnight proof publication and cross-chain linking

  Complete implementation of the midnight-prover package for ZK proof generation:

  - **ProofPublisher**: Submit proofs to Midnight network

    - Resilient publication with retry logic and exponential backoff
    - Status monitoring for submitted proofs
    - Confirmation waiting with configurable timeout
    - Mock implementation for testing (real Midnight integration TBD)

  - **CardanoAnchorLinker**: Cross-chain linking between Midnight and Cardano

    - Create bidirectional links between ZK proofs and Cardano anchors
    - Cryptographic commitment generation for link verification
    - Link verification against both chains
    - Link caching and lookup by proof ID or Cardano anchor

  - **ProofServerClient**: Midnight proof server communication

    - Connection management with authentication support
    - Proof submission with witness and public inputs
    - Circuit information queries
    - Mock implementation for testing

  - **DefaultMidnightProver**: Complete MidnightProver interface implementation

    - Coordinates all proof types (hash-chain, policy, disclosure)
    - Manages connection lifecycle
    - Handles proof publication and verification
    - Registered as default in proverRegistry

  - **Full Test Coverage**:
    - ProofPublisher tests for publication lifecycle
    - CardanoAnchorLinker tests for cross-chain linking
    - ProofServerClient tests for server communication
    - Integration tests for full proof flow
