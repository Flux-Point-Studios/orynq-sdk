# @fluxpointstudios/poi-sdk-midnight-prover

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
