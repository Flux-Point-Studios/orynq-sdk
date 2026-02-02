# PoI v2 Architectural Plan

**Version:** 2.0.0-draft
**Date:** 2026-02-01
**Status:** Architectural Specification

---

## Executive Summary

PoI v2 represents a fundamental philosophy shift from "deterministic replay" to "tamper-evident audit." The architecture prioritizes forensic integrity and authenticity over reproducibility, with optional zkML correctness proofs for high-stakes scenarios.

### Core Guarantees

| Tier | Guarantee | Mechanism |
|------|-----------|-----------|
| **Integrity** | Trace hasn't been altered since time X | Merkle trees + L1/L2 anchoring |
| **Authenticity** | Trace produced by attested recorder | TEE attestation bundles |
| **Correctness** | Output is valid for model M, input I, params P | zkML proofs (optional) |

### Package Overview

```
poi-sdk/packages/
  core/                    # Existing - types, utils, chains
  process-trace/           # Existing - trace building, merkle, bundles
  anchors-cardano/         # Existing - L1 anchoring (label 2222)

  # NEW PACKAGES (v2)
  flight-recorder/         # Streaming recorder with chunking/encryption
  hydra-batcher/           # High-frequency L2 commitment lane
  attestor/                # TEE attestation backends
  midnight-prover/         # ZK proof generation
  storage-adapters/        # IPFS, S3, local storage backends
```

---

## System Context

```
                                    +------------------+
                                    |  External User   |
                                    |  (Auditor/Verifier)
                                    +--------+---------+
                                             |
                              Verification Request
                                             |
                                             v
+------------------+              +----------+---------+
|  LLM Provider    |              |                    |
|  (Anthropic,     |   Events    |   poi-flight-      |
|   OpenAI, etc.)  +------------>+   recorder         |
+------------------+              |                    |
                                  +----+----+----+----+
                                       |    |    |
                      +----------------+    |    +----------------+
                      |                     |                     |
                      v                     v                     v
             +--------+--------+   +--------+--------+   +--------+--------+
             | poi-attestor    |   | poi-hydra-      |   | poi-storage-    |
             | (TEE evidence)  |   | batcher (L2)    |   | adapters        |
             +-----------------+   +--------+--------+   +--------+--------+
                                           |                     |
                                           v                     |
                                  +--------+--------+            |
                                  | anchors-cardano |            |
                                  | (L1 anchor)     |            |
                                  +--------+--------+            |
                                           |                     |
                                           v                     v
                                  +--------+---------+   +-------+---------+
                                  |  Cardano L1      |   |  Off-chain      |
                                  |  (mainnet)       |   |  Storage        |
                                  +------------------+   |  (IPFS/S3)      |
                                           ^             +-----------------+
                                           |                     |
                                  +--------+---------+           |
                                  | poi-midnight-    |           |
                                  | prover (ZK)      +-----------+
                                  +------------------+
```

---

## Component Architecture

### 1. poi-flight-recorder

The core streaming recorder responsible for capturing inference events, building cryptographic commitments, and managing encrypted storage.

#### Package Structure

```
packages/flight-recorder/
  src/
    index.ts                    # Public API exports
    types.ts                    # Type definitions

    # Core Recording Pipeline
    recorder/
      stream-recorder.ts        # Main streaming recorder class
      event-buffer.ts           # In-memory event buffering
      chunk-manager.ts          # Chunk creation and lifecycle

    # Cryptographic Operations
    crypto/
      encryption.ts             # AES-GCM / ChaCha20-Poly1305
      key-management.ts         # Key generation, sealing, wrapping
      compression.ts            # zstd compression

    # Manifest Building
    manifest/
      manifest-builder.ts       # ManifestV2 construction
      input-hasher.ts           # Hash inputs (prompt, system, tools)
      runtime-capture.ts        # Capture runtime identity

    # Storage Abstraction
    storage/
      storage-interface.ts      # Abstract storage interface
      content-addressed.ts      # CAS helpers

    # Integration
    integration/
      openclaw-adapter.ts       # Migrate from poi-openclaw

  __tests__/
    recorder.test.ts
    encryption.test.ts
    manifest.test.ts
```

#### Key Interfaces

```typescript
// === Recording Session ===

interface RecorderConfig {
  // Identity
  agentId: string;
  sessionId?: string;  // Auto-generated if not provided

  // Chunking
  chunkSizeBytes: number;       // 4-16MB recommended
  chunkTimeoutMs?: number;      // Force chunk after timeout

  // Encryption
  encryption: EncryptionConfig;

  // Storage
  storage: StorageAdapter;

  // Optional attestation binding
  attestor?: Attestor;
}

interface EncryptionConfig {
  algorithm: "aes-256-gcm" | "chacha20-poly1305";
  keyDerivation: "hkdf-sha256";

  // Key handling
  keyMode:
    | { type: "ephemeral" }                    // New key per session
    | { type: "sealed"; teeType: TeeType }     // Seal inside TEE
    | { type: "wrapped"; pubkeys: string[] };  // Wrap to auditor keys
}

interface FlightRecorder {
  // Lifecycle
  start(): Promise<RecordingSession>;

  // Recording
  record(event: RecorderEvent): void;
  recordSpan(name: string, fn: () => Promise<void>): Promise<void>;

  // Finalization
  finalize(): Promise<RecordingResult>;
  abort(reason?: string): Promise<void>;
}

interface RecordingResult {
  // Cryptographic commitments
  rootHash: string;
  merkleRoot: string;
  manifestHash: string;

  // Storage references
  manifest: ManifestV2;
  chunkRefs: ChunkRef[];

  // Attestation (if configured)
  attestation?: AttestationBundle;

  // Anchoring metadata (ready for poi-anchors-cardano)
  anchorEntry: AnchorEntry;
}

// === Event Types ===

type RecorderEvent =
  | InferenceStartEvent
  | InferenceEndEvent
  | ToolCallEvent
  | ToolResultEvent
  | StreamChunkEvent
  | DecisionEvent
  | ErrorEvent
  | CustomEvent;

interface InferenceStartEvent {
  kind: "inference:start";
  requestId: string;
  model: string;
  promptHash: string;
  systemPromptHash?: string;
  params: InferenceParams;
}

interface InferenceEndEvent {
  kind: "inference:end";
  requestId: string;
  outputHash: string;
  tokenCounts: {
    prompt: number;
    completion: number;
  };
  durationMs: number;
}

interface ToolCallEvent {
  kind: "tool:call";
  toolName: string;
  argsHash: string;
  visibility: Visibility;
}

interface ToolResultEvent {
  kind: "tool:result";
  toolName: string;
  resultHash: string;
  success: boolean;
  visibility: Visibility;
}

// === Chunk Management ===

interface ChunkRef {
  id: string;            // Content-addressed ID
  hash: string;          // SHA-256 of encrypted content
  size: number;          // Encrypted size in bytes
  storageUri: string;    // Where stored (ipfs://, s3://, file://)
  encryptionKeyId: string;
}

interface ChunkData {
  // Encrypted payload
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;

  // Metadata (unencrypted)
  meta: {
    index: number;
    eventRange: [number, number];  // seq range
    spanIds: string[];
    createdAt: string;
  };
}
```

#### ManifestV2 Schema

```typescript
interface ManifestV2 {
  formatVersion: "2.0";

  // === Identity ===
  agentId: string;
  sessionId: string;

  // === Cryptographic Commitments ===
  // These are anchored on-chain under label 2222
  rootHash: string;      // Rolling hash of event stream
  merkleRoot: string;    // Merkle root of chunk hashes
  manifestHash: string;  // H(canonical(this manifest without hash))

  // === Input Commitments ===
  inputs: {
    promptHash: string;
    systemPromptHash?: string;
    toolContextHash?: string;
    // For encrypted inputs, store ciphertext hashes
    encryptedCiphertextHashes?: string[];
  };

  // === Inference Parameters ===
  params: {
    model: string;
    modelWeightDigest?: string;    // Optional: hash of model weights
    tokenizerDigest?: string;      // Optional: hash of tokenizer
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    stopStrings?: string[];
    frequencyPenalty?: number;
    presencePenalty?: number;
    toolPolicy?: Record<string, unknown>;
  };

  // === Runtime Identity ===
  runtime: {
    recorderVersion: string;       // poi-flight-recorder version
    containerDigest?: string;      // Docker image digest
    gitCommit?: string;            // Source code commit
    dependencies?: Record<string, string>;  // Key deps with versions
    gpuDriver?: string;            // For GPU inference
    nodeVersion?: string;
  };

  // === Chunk References ===
  chunks: Array<{
    id: string;
    hash: string;
    size: number;
    storageUri: string;
    encryptionKeyId?: string;
    compression: "zstd" | "none";
  }>;

  // === Output Summary ===
  outputs: {
    transcriptRollingHash: string;   // Rolling hash of outputs
    toolCallCount: number;
    totalTokens: number;
    completionTokens: number;
  };

  // === Attestation (Optional) ===
  attestation?: {
    teeType: TeeType;
    evidenceHash: string;
    evidenceUri?: string;
    verifierPolicy: VerifierPolicy;
    boundHash: "rootHash" | "manifestHash" | "merkleRoot";
  };

  // === Timestamps ===
  createdAt: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;

  // === Statistics ===
  totalEvents: number;
  totalSpans: number;
}

type TeeType = "sev-snp" | "tdx" | "sgx" | "nitro" | "gpu-cc";

interface VerifierPolicy {
  expectedMeasurements?: string[];
  allowedSignerKeys?: string[];
  minFirmwareVersion?: string;
}
```

#### Data Flow

```
Events Stream In
       |
       v
+------+-------+
| Event Buffer |  (in-memory, ordered by seq)
+------+-------+
       |
       | (chunk threshold reached)
       v
+------+-------+
| Compress     |  zstd compression
+------+-------+
       |
       v
+------+-------+
| Encrypt      |  AES-GCM with per-chunk nonce
+------+-------+
       |
       v
+------+-------+
| Store        |  Content-addressed storage
+------+-------+
       |
       | (all chunks stored)
       v
+------+-------+
| Build        |  Compute merkle root, manifest hash
| Manifest     |
+------+-------+
       |
       v
+------+-------+
| Attestation  |  Bind rootHash to TEE evidence
| (optional)   |
+------+-------+
       |
       v
   RecordingResult
```

---

### 2. poi-hydra-batcher

High-frequency L2 commitment lane using Cardano Hydra for sub-second finality.

#### Package Structure

```
packages/hydra-batcher/
  src/
    index.ts
    types.ts

    # Hydra Head Management
    head/
      head-manager.ts           # Open, close, fanout
      head-config.ts            # Head configuration
      peer-discovery.ts         # Find auditor nodes

    # Commitment Pattern
    commitment/
      commitment-utxo.ts        # UTxO pattern for accumulator
      batch-accumulator.ts      # Merkle accumulator for batches
      settlement-trigger.ts     # When to settle to L1

    # Transaction Building
    tx/
      l2-tx-builder.ts          # Hydra L2 transactions
      l1-settlement.ts          # L1 fanout/anchor

    # Monitoring
    monitor/
      head-health.ts            # Head status monitoring
      metrics.ts                # Performance metrics

  __tests__/
```

#### Key Interfaces

```typescript
// === Hydra Head Configuration ===

interface HydraBatcherConfig {
  // Participants
  recorderNode: HydraNode;
  auditorNodes: HydraNode[];

  // Commitment pattern
  commitmentIntervalMs: number;     // How often to commit
  commitmentBatchSize: number;      // Max jobs per commit

  // Settlement triggers
  settlementPolicy: SettlementPolicy;

  // Network
  network: "mainnet" | "preprod" | "preview";
}

interface HydraNode {
  nodeId: string;
  host: string;
  port: number;
  verificationKey: string;
}

interface SettlementPolicy {
  // Settle after N commits
  maxCommitsBeforeSettlement: number;

  // Settle after time
  maxTimeBeforeSettlementMs: number;

  // Settle on accumulated value threshold
  valueThresholdLovelace?: bigint;

  // Force settlement on specific events
  settleOnEvents?: ("error" | "shutdown" | "key-rotation")[];
}

// === Commitment UTxO Pattern ===

interface CommitmentDatum {
  // Current accumulator state
  accumulatorRoot: string;    // Merkle root of all committed roots
  commitCount: number;

  // Latest batch
  latestBatchRoot: string;
  latestBatchTimestamp: number;

  // History (for verification)
  batchHistory: Array<{
    batchRoot: string;
    timestamp: number;
    itemCount: number;
  }>;
}

interface BatchItem {
  sessionId: string;
  rootHash: string;
  merkleRoot: string;
  manifestHash: string;
  timestamp: string;
}

// === Batcher API ===

interface HydraBatcher {
  // Lifecycle
  openHead(): Promise<HeadHandle>;
  closeHead(handle: HeadHandle): Promise<SettlementResult>;

  // Commitment
  commit(items: BatchItem[]): Promise<CommitResult>;

  // Settlement
  settle(): Promise<SettlementResult>;

  // Status
  getStatus(): Promise<BatcherStatus>;
  getCommitHistory(): Promise<CommitRecord[]>;
}

interface CommitResult {
  l2TxHash: string;
  newAccumulatorRoot: string;
  commitIndex: number;
  timestamp: string;
}

interface SettlementResult {
  l1TxHash: string;
  finalAccumulatorRoot: string;
  totalCommits: number;
  anchorEntry: AnchorEntry;  // Ready for label 2222
}

interface HeadHandle {
  headId: string;
  participants: string[];
  openedAt: string;
  status: "initializing" | "open" | "closing" | "closed" | "fanout";
}
```

#### Commitment Flow

```
                     Hydra Head
        +--------------------------------+
        |                                |
        |   Recorder       Auditor(s)    |
        |      |              |          |
        |      +------+-------+          |
        |             |                  |
        |             v                  |
        |   +---------+---------+        |
        |   | Commitment UTxO   |        |
        |   | (accumulator)     |        |
        |   +---------+---------+        |
        |             |                  |
        +-------------|------------------+
                      |
        (periodic settlement)
                      |
                      v
        +-------------+--------------+
        |    Cardano L1 (Mainnet)    |
        |    PoI Anchor (2222)       |
        +----------------------------+
```

#### Design Principles

1. **Keep Head "Boring"**: ADA-only, minimal script complexity
2. **Graceful Degradation**: If Head fails, buffer and retry or fallback to L1
3. **Deterministic Settlement**: Clear rules for when to close and fanout
4. **Audit Trail**: Full history of all commits for verification

---

### 3. poi-attestor

TEE attestation backends providing hardware-rooted trust.

#### Package Structure

```
packages/attestor/
  src/
    index.ts
    types.ts

    # Core Interface
    attestor-interface.ts       # Abstract attestor interface
    attestation-bundle.ts       # Normalized bundle format

    # Backend Implementations
    backends/
      sev-snp/
        sev-snp-attestor.ts
        launch-measurement.ts
        report-parser.ts

      tdx/
        tdx-attestor.ts
        dcap-quote.ts

      sgx/
        sgx-attestor.ts
        remote-attestation.ts
        enclave-key.ts

      nitro/
        nitro-attestor.ts
        attestation-document.ts
        kms-integration.ts

      gpu-cc/
        gpu-attestor.ts
        nvidia-sdk.ts
        composite-attestation.ts

    # Verification
    verification/
      verifier-interface.ts
      policy-engine.ts
      measurement-database.ts

  __tests__/
```

#### Key Interfaces

```typescript
// === Attestor Interface ===

interface Attestor {
  readonly teeType: TeeType;

  // Generate attestation binding a hash
  attest(hashToSign: string): Promise<AttestationBundle>;

  // Get current measurements
  getMeasurements(): Promise<Measurements>;

  // Check if running in attested environment
  isAttested(): boolean;
}

// === Attestation Bundle ===

interface AttestationBundle {
  // TEE identification
  teeType: TeeType;
  teeVersion: string;

  // Raw evidence (or reference)
  evidence: {
    format: "raw" | "base64" | "cbor";
    data?: string;           // Inline if small enough
    hash?: string;           // Hash if stored externally
    storageUri?: string;     // Where to fetch full evidence
  };

  // What was attested
  binding: {
    hash: string;            // The hash that was bound
    hashType: "rootHash" | "manifestHash" | "merkleRoot";
    timestamp: string;
  };

  // Verifier configuration
  verifierPolicy: VerifierPolicy;

  // Attestor identity
  attestorId: string;
  attestorPubkey?: string;
}

// === Backend-Specific Types ===

// AMD SEV-SNP
interface SevSnpAttestation extends AttestationBundle {
  teeType: "sev-snp";

  sevSnp: {
    launchMeasurement: string;
    reportData: string;        // Contains bound hash
    vcek: string;              // Versioned chip endorsement key
    certChain: string[];       // AMD root -> VCEK
  };
}

// Intel TDX
interface TdxAttestation extends AttestationBundle {
  teeType: "tdx";

  tdx: {
    dcapQuote: string;
    mrTd: string;              // TD measurement register
    mrConfigId: string;
    reportData: string;        // REPORTDATA field with bound hash
    pckCert: string;
  };
}

// Intel SGX
interface SgxAttestation extends AttestationBundle {
  teeType: "sgx";

  sgx: {
    quote: string;
    mrEnclave: string;
    mrSigner: string;
    isvProdId: number;
    isvSvn: number;
    reportData: string;
    enclaveHeldPubkey: string;
  };
}

// AWS Nitro
interface NitroAttestation extends AttestationBundle {
  teeType: "nitro";

  nitro: {
    attestationDocument: string;    // COSE-signed
    pcrs: Record<number, string>;   // PCR values
    userData: string;               // Contains bound hash
    nonce: string;
    publicKey?: string;
    certificate: string;
  };
}

// NVIDIA GPU CC
interface GpuCcAttestation extends AttestationBundle {
  teeType: "gpu-cc";

  gpuCc: {
    // CPU TEE attestation
    cpuAttestation: SevSnpAttestation | TdxAttestation;

    // GPU attestation
    gpuAttestation: {
      driverVersion: string;
      gpuModel: string;
      ccMode: "on" | "devtools";
      measurements: {
        firmwareHash: string;
        vbiosHash: string;
      };
      certificate: string;
    };
  };
}

// === Verification ===

interface AttestationVerifier {
  verify(bundle: AttestationBundle): Promise<VerificationResult>;
}

interface VerificationResult {
  valid: boolean;
  teeType: TeeType;

  checks: {
    signatureValid: boolean;
    measurementsMatch: boolean;
    certChainValid: boolean;
    notRevoked: boolean;
    hashBindingValid: boolean;
  };

  warnings: string[];
  errors: string[];

  // Extracted measurements for policy checking
  measurements: Measurements;
}

interface Measurements {
  // Common fields
  firmwareVersion?: string;

  // Platform-specific
  sevSnp?: {
    launchMeasurement: string;
    guestPolicy: string;
  };

  tdx?: {
    mrTd: string;
    mrConfigId: string;
    tdAttributes: string;
  };

  sgx?: {
    mrEnclave: string;
    mrSigner: string;
    isvProdId: number;
    isvSvn: number;
  };

  nitro?: {
    pcrs: Record<number, string>;
    moduleId: string;
  };
}

interface VerifierPolicy {
  // Expected measurements (at least one must match)
  expectedMeasurements?: string[];

  // Allowed signing keys
  allowedSignerKeys?: string[];

  // Minimum versions
  minFirmwareVersion?: string;
  minSvn?: number;

  // Revocation
  checkRevocation?: boolean;
  revocationListUri?: string;
}
```

---

### 4. poi-midnight-prover

ZK proof layer for privacy-preserving verification using Midnight network.

#### Package Structure

```
packages/midnight-prover/
  src/
    index.ts
    types.ts

    # Proof Generation
    proofs/
      hash-chain-proof.ts       # Prove hash chain validity
      policy-compliance-proof.ts # Prove content passed policy
      attestation-proof.ts      # Prove valid TEE attestation
      selective-disclosure.ts   # Prove spans without revealing

    # Midnight Integration
    midnight/
      proof-server-client.ts    # Midnight proof-server API
      witness-builder.ts        # Build circuit witnesses
      public-inputs.ts          # Manage public inputs

    # Cross-Chain Linking
    linking/
      cardano-anchor-link.ts    # Link to PoI anchor hash
      proof-publication.ts      # Publish proofs to Midnight

    # Optional zkML
    zkml/
      model-circuit.ts          # Small model circuits
      inference-proof.ts        # Prove inference correctness

  circuits/                     # Compact circuit definitions
    hash-chain.compact
    policy-check.compact
    attestation-verify.compact

  __tests__/
```

#### Key Interfaces

```typescript
// === Proof Types ===

type ProofType =
  | "hash-chain"              // Trace hash chain is valid
  | "policy-compliance"       // Content passed policy Y
  | "attestation-valid"       // TEE attestation is valid
  | "selective-disclosure"    // Span exists without reveal
  | "zkml-inference";         // Output correct for input (expensive)

// === Proof Generation ===

interface MidnightProver {
  // Connect to proof server
  connect(config: ProofServerConfig): Promise<void>;

  // Generate proofs
  proveHashChain(input: HashChainInput): Promise<HashChainProof>;
  provePolicyCompliance(input: PolicyInput): Promise<PolicyProof>;
  proveAttestation(input: AttestationInput): Promise<AttestationProof>;
  proveSelectiveDisclosure(input: DisclosureInput): Promise<DisclosureProof>;

  // Optional zkML (expensive)
  proveInference?(input: InferenceInput): Promise<InferenceProof>;

  // Publish to Midnight
  publish(proof: Proof): Promise<PublicationResult>;
}

// === Hash Chain Proof ===

interface HashChainInput {
  // The trace events (private witness)
  events: TraceEvent[];

  // Rolling hash state
  genesisHash: string;

  // Public commitment (from Cardano anchor)
  expectedRootHash: string;
  cardanoAnchorTxHash: string;
}

interface HashChainProof extends Proof {
  proofType: "hash-chain";

  publicInputs: {
    rootHash: string;
    eventCount: number;
    cardanoAnchorTxHash: string;
  };

  // Compact proof bytes
  proof: Uint8Array;
}

// === Policy Compliance Proof ===

interface PolicyInput {
  // Content hashes (private)
  promptHash: string;
  outputHash: string;

  // Policy definition
  policy: ContentPolicy;

  // Cardano anchor for binding
  cardanoAnchorTxHash: string;
}

interface ContentPolicy {
  id: string;
  version: string;

  // Policy rules
  rules: PolicyRule[];
}

interface PolicyRule {
  type: "blocklist" | "allowlist" | "regex" | "classifier";
  target: "prompt" | "output" | "both";
  params: Record<string, unknown>;
}

interface PolicyProof extends Proof {
  proofType: "policy-compliance";

  publicInputs: {
    promptHash: string;          // Reveals hash, not content
    policyId: string;
    policyVersion: string;
    compliant: boolean;
    cardanoAnchorTxHash: string;
  };

  proof: Uint8Array;
}

// === Attestation Validity Proof ===

interface AttestationInput {
  // Attestation bundle (private witness)
  attestation: AttestationBundle;

  // Expected measurements (public)
  policy: VerifierPolicy;

  // Binding
  cardanoAnchorTxHash: string;
}

interface AttestationProof extends Proof {
  proofType: "attestation-valid";

  publicInputs: {
    teeType: TeeType;
    measurementMatch: boolean;
    boundHash: string;
    cardanoAnchorTxHash: string;
  };

  proof: Uint8Array;
}

// === Selective Disclosure Proof ===

interface DisclosureInput {
  // Full bundle (private)
  bundle: TraceBundle;

  // Span to disclose
  spanId: string;

  // Merkle root (public, from anchor)
  merkleRoot: string;
  cardanoAnchorTxHash: string;
}

interface DisclosureProof extends Proof {
  proofType: "selective-disclosure";

  publicInputs: {
    spanHash: string;
    merkleRoot: string;
    cardanoAnchorTxHash: string;
  };

  // Optionally reveal span data
  disclosedSpan?: TraceSpan;
  disclosedEvents?: TraceEvent[];

  proof: Uint8Array;
}

// === zkML Inference Proof (Optional, High-Stakes) ===

interface InferenceInput {
  // Model (by reference)
  modelId: string;
  modelWeightDigest: string;

  // Input/output
  inputTokens: number[];
  outputTokens: number[];

  // Parameters
  params: InferenceParams;

  // Binding
  cardanoAnchorTxHash: string;
}

interface InferenceProof extends Proof {
  proofType: "zkml-inference";

  publicInputs: {
    modelWeightDigest: string;
    inputHash: string;
    outputHash: string;
    paramsHash: string;
    cardanoAnchorTxHash: string;
  };

  proof: Uint8Array;

  // zkML proofs are expensive - include cost metrics
  metrics: {
    provingTimeMs: number;
    proofSizeBytes: number;
    circuitSize: number;
  };
}

// === Publication ===

interface PublicationResult {
  midnightTxHash: string;
  proofId: string;
  timestamp: string;

  // Cross-chain reference
  cardanoAnchorTxHash: string;
}
```

---

### 5. poi-storage-adapters

Content-addressed storage backends for chunks and manifests.

#### Package Structure

```
packages/storage-adapters/
  src/
    index.ts
    types.ts

    # Abstract Interface
    storage-interface.ts

    # Implementations
    adapters/
      local/
        local-adapter.ts
        file-system.ts

      ipfs/
        ipfs-adapter.ts
        pinning-service.ts      # Pinata, Infura, etc.

      s3/
        s3-adapter.ts
        presigned-urls.ts

      arweave/
        arweave-adapter.ts
        bundlr-integration.ts

    # Utilities
    utils/
      content-addressing.ts
      replication.ts

  __tests__/
```

#### Key Interfaces

```typescript
interface StorageAdapter {
  readonly type: "local" | "ipfs" | "s3" | "arweave";

  // Write operations
  store(data: Uint8Array): Promise<StorageRef>;
  storeManifest(manifest: ManifestV2): Promise<StorageRef>;

  // Read operations
  fetch(ref: StorageRef): Promise<Uint8Array>;
  fetchManifest(ref: StorageRef): Promise<ManifestV2>;

  // Verification
  verify(ref: StorageRef): Promise<boolean>;

  // Lifecycle
  delete?(ref: StorageRef): Promise<void>;
  pin?(ref: StorageRef): Promise<void>;
}

interface StorageRef {
  type: "local" | "ipfs" | "s3" | "arweave";
  uri: string;              // Full URI (file://, ipfs://, s3://, ar://)
  hash: string;             // Content hash for verification
  size: number;
}

// IPFS-specific
interface IpfsAdapterConfig {
  // Connection
  gateway: string;          // Read gateway
  apiEndpoint?: string;     // Write API (if local node)

  // Pinning
  pinningService?: {
    name: "pinata" | "infura" | "web3.storage";
    apiKey: string;
    apiSecret?: string;
  };
}

// S3-specific
interface S3AdapterConfig {
  bucket: string;
  region: string;
  prefix?: string;

  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };

  // Options
  serverSideEncryption?: boolean;
  presignedUrlExpiry?: number;
}
```

---

## Integration Architecture

### Verification Flow

```
1. Auditor receives claim: "Session X has valid trace"
                |
                v
2. Fetch anchor tx from Cardano L1
   +------------------------------------------+
   | Label 2222: {                            |
   |   schema: "poi-anchor-v1",               |
   |   anchors: [{                            |
   |     rootHash: "abc...",                  |
   |     manifestHash: "def...",              |
   |     merkleRoot: "789...",                |
   |     storageUri: "ipfs://Qm..."           |
   |   }]                                     |
   | }                                        |
   +------------------------------------------+
                |
                v
3. Fetch manifest from storageUri
   - Verify manifestHash matches anchor
                |
                v
4. Fetch chunks from manifest.chunks[].storageUri
   - Verify each chunk.hash matches
   - Decrypt if encrypted (need key disclosure)
                |
                v
5. Reconstruct events and verify:
   - Recompute rolling hash -> must match rootHash
   - Recompute Merkle tree -> must match merkleRoot
                |
                v
6. Verify attestation (if present):
   - Parse attestation bundle
   - Verify TEE signature
   - Check measurements against policy
   - Verify bound hash matches rootHash
                |
                v
7. Verify ZK proofs (if present):
   - Fetch proofs from Midnight
   - Verify proof links to same Cardano anchor
   - Validate proof against public inputs
                |
                v
8. Verification Result:
   - Integrity: PASS/FAIL
   - Authenticity: PASS/FAIL/N/A
   - Correctness: PASS/FAIL/N/A
```

### Key Management

```typescript
interface KeyManagementConfig {
  // Key generation
  keySource:
    | { type: "random" }
    | { type: "derived"; masterKey: string; info: string };

  // Key sealing (for TEE environments)
  sealing?: {
    teeType: TeeType;
    sealingPolicy: "instance" | "signer" | "product";
  };

  // Key wrapping (for auditor disclosure)
  wrapping?: {
    recipientPubkeys: string[];
    threshold?: number;        // For threshold wrapping
  };

  // Key rotation
  rotation?: {
    intervalMs: number;
    retainOldKeys: boolean;
  };
}

interface WrappedKey {
  keyId: string;
  algorithm: "rsa-oaep" | "x25519";
  wrappedKeys: Array<{
    recipientId: string;
    ciphertext: string;
  }>;
  // For threshold schemes
  threshold?: {
    k: number;              // k-of-n threshold
    n: number;
  };
}
```

---

## Integration with Existing poi-sdk

### Migration from poi-openclaw

The `poi-flight-recorder` package includes an adapter layer for migrating from the existing `poi-openclaw` integration:

```typescript
// packages/flight-recorder/src/integration/openclaw-adapter.ts

import { FlightRecorder, RecorderConfig } from "../recorder/stream-recorder";
import { TraceRun, TraceEvent } from "@fluxpointstudios/poi-sdk-process-trace";

/**
 * Adapter to bridge poi-openclaw traces to flight-recorder format.
 */
export class OpenClawAdapter {
  private recorder: FlightRecorder;

  constructor(config: RecorderConfig) {
    this.recorder = new FlightRecorder(config);
  }

  /**
   * Convert a legacy TraceRun to flight-recorder events.
   */
  async importLegacyTrace(run: TraceRun): Promise<RecordingResult> {
    await this.recorder.start();

    for (const event of run.events) {
      this.recorder.record(this.convertEvent(event));
    }

    return this.recorder.finalize();
  }

  /**
   * Wrap existing trace builder with flight-recorder.
   */
  wrapTraceBuilder(/* ... */): FlightRecorder {
    // ...
  }
}
```

### Dependency Graph

```
                       poi-core
                          |
            +-------------+-------------+
            |                           |
      process-trace              storage-adapters
            |                           |
            +-------------+-------------+
                          |
                   flight-recorder
                          |
            +-------------+-------------+
            |             |             |
        attestor    hydra-batcher  midnight-prover
            |             |             |
            +-------------+-------------+
                          |
                   anchors-cardano
```

### Package Dependencies

```json
// packages/flight-recorder/package.json
{
  "name": "@fluxpointstudios/poi-sdk-flight-recorder",
  "dependencies": {
    "@fluxpointstudios/poi-sdk-core": "workspace:*",
    "@fluxpointstudios/poi-sdk-process-trace": "workspace:*",
    "@fluxpointstudios/poi-sdk-storage-adapters": "workspace:*"
  },
  "optionalDependencies": {
    "@fluxpointstudios/poi-sdk-attestor": "workspace:*"
  }
}

// packages/hydra-batcher/package.json
{
  "name": "@fluxpointstudios/poi-sdk-hydra-batcher",
  "dependencies": {
    "@fluxpointstudios/poi-sdk-core": "workspace:*",
    "@fluxpointstudios/poi-sdk-anchors-cardano": "workspace:*"
  },
  "peerDependencies": {
    "@cardano-ogmios/client": "^6.0.0"
  }
}

// packages/attestor/package.json
{
  "name": "@fluxpointstudios/poi-sdk-attestor",
  "dependencies": {
    "@fluxpointstudios/poi-sdk-core": "workspace:*"
  },
  "optionalDependencies": {
    // TEE SDKs as optional
    "@aws-sdk/client-kms": "^3.0.0",
    "sev-snp-utils": "^0.1.0"
  }
}

// packages/midnight-prover/package.json
{
  "name": "@fluxpointstudios/poi-sdk-midnight-prover",
  "dependencies": {
    "@fluxpointstudios/poi-sdk-core": "workspace:*",
    "@fluxpointstudios/poi-sdk-process-trace": "workspace:*",
    "@fluxpointstudios/poi-sdk-anchors-cardano": "workspace:*"
  },
  "peerDependencies": {
    "@midnight-ntwrk/compact-runtime": "^0.1.0"
  }
}
```

---

## Implementation Phases

### Phase 1: Flight Recorder Core (4-6 weeks)

**Deliverables:**
- [ ] Stream recorder with event buffering
- [ ] Chunking pipeline (zstd compression, AES-GCM encryption)
- [ ] ManifestV2 schema and builder
- [ ] Local storage adapter
- [ ] Integration with existing `process-trace` package
- [ ] Migration adapter for `poi-openclaw`

**Success Criteria:**
- Can record a Claude session and produce anchored manifest
- Chunk hashes form valid Merkle tree
- ManifestV2 can be verified independently
- Existing `anchors-cardano` can anchor ManifestV2

**Testing Strategy:**
- Unit tests for all crypto operations (hash, encrypt, compress)
- Integration tests with mock LLM provider
- Property-based tests for chunk boundaries
- Golden file tests for ManifestV2 compatibility

### Phase 2: Cloud Storage + Merkle (2-3 weeks)

**Deliverables:**
- [ ] IPFS storage adapter with Pinata/Infura support
- [ ] S3 storage adapter with presigned URLs
- [ ] Proper binary Merkle tree (not shortcut)
- [ ] Partial verification support (verify single chunk)
- [ ] Storage replication utilities

**Success Criteria:**
- Store/retrieve chunks from IPFS and S3
- Merkle proofs verify correctly
- Can verify single span without full download

**Testing Strategy:**
- Integration tests with local IPFS node
- Mocked S3 tests with localstack
- Merkle proof verification tests

### Phase 3: Attestation Layer (4-6 weeks)

**Deliverables:**
- [ ] Abstract attestor interface
- [ ] AWS Nitro backend (fastest to ship)
- [ ] AMD SEV-SNP backend
- [ ] Normalized attestation bundle format
- [ ] Verification utilities

**Success Criteria:**
- Generate valid attestation in Nitro enclave
- Attestation bundle verifies externally
- Hash binding is cryptographically sound

**Testing Strategy:**
- Real Nitro enclave integration tests (CI/CD with EC2)
- Mock attestor for unit tests
- Cross-platform verification tests

### Phase 4: Hydra Integration (4-6 weeks)

**Deliverables:**
- [ ] Hydra Head management (open/close/fanout)
- [ ] Commitment UTxO pattern
- [ ] Batch accumulator with Merkle tree
- [ ] Settlement to L1 via `anchors-cardano`
- [ ] Head health monitoring

**Success Criteria:**
- Open Head between recorder and auditor
- Sub-second L2 commits
- Periodic settlement to L1 with valid anchor

**Testing Strategy:**
- Local Hydra devnet integration tests
- Settlement flow tests on preprod
- Failure mode tests (Head crash, network partition)

### Phase 5: Midnight Integration (6-8 weeks)

**Deliverables:**
- [ ] Hash chain validity proof (Compact circuit)
- [ ] Policy compliance proof
- [ ] Selective disclosure proof
- [ ] Proof publication to Midnight
- [ ] Cross-chain anchor linking

**Success Criteria:**
- Generate and verify hash chain proof
- Proof links to Cardano anchor
- Selective disclosure reveals only requested spans

**Testing Strategy:**
- Circuit unit tests
- Proof generation benchmarks
- End-to-end verification tests

---

## Security Model

### Threat Model

| Threat | Mitigation | Tier Required |
|--------|------------|---------------|
| Operator forges trace after recording | L1/L2 anchoring with timestamps | Integrity |
| Operator forges trace during recording | TEE attestation | Authenticity |
| Operator claims false model/params | ManifestV2 with runtime capture | Integrity |
| Auditor sees sensitive content | Encryption + key management | Privacy |
| Proof forgery | ZK soundness + chain binding | Correctness |
| Key compromise | Key rotation + threshold wrapping | All |

### Security Tiers

**Tier 1: Integrity Only**
- No TEEs, no ZK
- Trust: Operator could forge original trace
- Guarantee: No tampering after anchoring

**Tier 2: Integrity + Authenticity**
- TEE attestation required
- Trust: Forging requires TEE compromise
- Guarantee: Trace from attested recorder

**Tier 3: Full (Integrity + Authenticity + Correctness)**
- TEE + zkML proofs
- Trust: Cryptographic
- Guarantee: Output provably correct for inputs

### Key Security Invariants

1. **Anchor Immutability**: Once on L1, anchor cannot change
2. **Hash Binding**: Attestation binds to specific trace hash
3. **Measurement Freshness**: Attestation includes timestamp
4. **Key Isolation**: Encryption keys never leave TEE (if configured)
5. **Proof Soundness**: ZK proofs computationally sound

---

## Deployment Considerations

### Infrastructure Requirements

| Component | CPU | Memory | Storage | Network |
|-----------|-----|--------|---------|---------|
| Flight Recorder | 2+ cores | 4GB+ | 100GB+ SSD | Low latency to storage |
| Hydra Node | 2+ cores | 8GB+ | 50GB SSD | <50ms to peers |
| Attestor (Nitro) | Enclave-capable | 4GB+ | 10GB | AWS VPC |
| Midnight Prover | 8+ cores | 32GB+ | 50GB | Midnight network |

### AWS Nitro Deployment

```yaml
# Example: ECS task definition for attested recorder
Resources:
  RecorderTask:
    Type: AWS::ECS::TaskDefinition
    Properties:
      Family: poi-recorder
      Cpu: 2048
      Memory: 4096
      RuntimePlatform:
        CpuArchitecture: X86_64
        OperatingSystemFamily: LINUX
      ContainerDefinitions:
        - Name: recorder
          Image: !Sub ${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/poi-recorder:latest
          # Nitro enclave configuration
          LinuxParameters:
            Devices:
              - ContainerPath: /dev/vsock
                HostPath: /dev/vsock
                Permissions:
                  - read
                  - write
```

### Cardano Node Requirements

- Full node for L1 anchoring (or use Blockfrost/Koios)
- Hydra node for L2 batching
- Preprod for testing, mainnet for production

### Monitoring

```typescript
interface RecorderMetrics {
  // Throughput
  eventsPerSecond: number;
  chunksCreated: number;
  bytesStored: number;

  // Latency
  chunkCreationLatencyMs: number;
  storageLatencyMs: number;
  anchoringLatencyMs: number;

  // Reliability
  failedChunks: number;
  retries: number;

  // Costs
  storageBytes: number;
  l1Transactions: number;
  l2Transactions: number;
}
```

---

## Risk Assessment

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Hydra Head instability | Medium | High | Fallback to L1-only, buffer commits |
| TEE SDK complexity | High | Medium | Start with Nitro (best docs), abstract interface |
| zkML circuit size limits | High | High | Limit to small models, offer as optional tier |
| Storage cost at scale | Medium | Medium | Tiered storage, pruning policies |
| Midnight network delays | Medium | Low | Async proof generation, queue |

### Mitigation Strategies

1. **Hydra Instability**: Implement circuit breaker pattern
   - If Head fails, buffer commits locally
   - Retry Head open with exponential backoff
   - Always maintain L1 fallback path

2. **TEE Complexity**: Abstraction + Feature Flags
   - Start with most documented TEE (Nitro)
   - Feature flag for each backend
   - Graceful degradation to attestation-optional

3. **zkML Limits**: Scope Management
   - Document model size limits clearly
   - Offer "hash-chain only" as default
   - zkML as premium tier for high-stakes

---

## Appendix A: Hash Domain Prefixes

Extending existing `HASH_DOMAIN_PREFIXES` from process-trace:

```typescript
export const HASH_DOMAIN_PREFIXES_V2 = {
  // Existing (v1)
  event: "poi-trace:event:v1|",
  roll: "poi-trace:roll:v1|",
  span: "poi-trace:span:v1|",
  leaf: "poi-trace:leaf:v1|",
  node: "poi-trace:node:v1|",
  manifest: "poi-trace:manifest:v1|",
  root: "poi-trace:root:v1|",

  // New (v2)
  chunk: "poi-trace:chunk:v2|",
  attestation: "poi-trace:attestation:v2|",
  commitment: "poi-trace:commitment:v2|",
  proof: "poi-trace:proof:v2|",

  // Encryption
  encryptedChunk: "poi-trace:encrypted-chunk:v2|",
  wrappedKey: "poi-trace:wrapped-key:v2|",
} as const;
```

## Appendix B: Error Codes

```typescript
export enum PoiV2Error {
  // Recording errors (1xxx)
  RECORDING_NOT_STARTED = 1001,
  RECORDING_ALREADY_FINALIZED = 1002,
  CHUNK_CREATION_FAILED = 1003,

  // Storage errors (2xxx)
  STORAGE_WRITE_FAILED = 2001,
  STORAGE_READ_FAILED = 2002,
  STORAGE_NOT_FOUND = 2003,

  // Attestation errors (3xxx)
  ATTESTATION_NOT_AVAILABLE = 3001,
  ATTESTATION_VERIFICATION_FAILED = 3002,
  TEE_NOT_SUPPORTED = 3003,

  // Hydra errors (4xxx)
  HEAD_OPEN_FAILED = 4001,
  HEAD_CLOSED_UNEXPECTEDLY = 4002,
  COMMIT_FAILED = 4003,
  SETTLEMENT_FAILED = 4004,

  // Proof errors (5xxx)
  PROOF_GENERATION_FAILED = 5001,
  PROOF_VERIFICATION_FAILED = 5002,
  PROOF_PUBLICATION_FAILED = 5003,

  // Verification errors (6xxx)
  MANIFEST_HASH_MISMATCH = 6001,
  CHUNK_HASH_MISMATCH = 6002,
  ROOT_HASH_MISMATCH = 6003,
  MERKLE_ROOT_MISMATCH = 6004,
  ATTESTATION_INVALID = 6005,
}
```

## Appendix C: Configuration Examples

### Minimal Configuration (Integrity Only)

```typescript
import { FlightRecorder } from "@fluxpointstudios/poi-sdk-flight-recorder";
import { LocalStorageAdapter } from "@fluxpointstudios/poi-sdk-storage-adapters";

const recorder = new FlightRecorder({
  agentId: "my-agent",
  chunkSizeBytes: 4 * 1024 * 1024, // 4MB
  encryption: {
    algorithm: "aes-256-gcm",
    keyDerivation: "hkdf-sha256",
    keyMode: { type: "ephemeral" },
  },
  storage: new LocalStorageAdapter({ baseDir: "./traces" }),
});
```

### Full Configuration (All Tiers)

```typescript
import { FlightRecorder } from "@fluxpointstudios/poi-sdk-flight-recorder";
import { NitroAttestor } from "@fluxpointstudios/poi-sdk-attestor";
import { IpfsStorageAdapter } from "@fluxpointstudios/poi-sdk-storage-adapters";
import { HydraBatcher } from "@fluxpointstudios/poi-sdk-hydra-batcher";
import { MidnightProver } from "@fluxpointstudios/poi-sdk-midnight-prover";

const attestor = new NitroAttestor({
  kmsKeyId: "arn:aws:kms:...",
  sealingPolicy: "signer",
});

const storage = new IpfsStorageAdapter({
  gateway: "https://ipfs.io",
  pinningService: {
    name: "pinata",
    apiKey: process.env.PINATA_API_KEY!,
  },
});

const batcher = new HydraBatcher({
  recorderNode: { nodeId: "recorder", host: "localhost", port: 4001, verificationKey: "..." },
  auditorNodes: [{ nodeId: "auditor", host: "auditor.example.com", port: 4001, verificationKey: "..." }],
  commitmentIntervalMs: 1000,
  commitmentBatchSize: 100,
  settlementPolicy: {
    maxCommitsBeforeSettlement: 1000,
    maxTimeBeforeSettlementMs: 3600000, // 1 hour
  },
  network: "mainnet",
});

const prover = new MidnightProver({
  proofServerUrl: "https://proof.midnight.network",
});

const recorder = new FlightRecorder({
  agentId: "production-agent",
  chunkSizeBytes: 8 * 1024 * 1024, // 8MB
  chunkTimeoutMs: 30000, // Force chunk after 30s
  encryption: {
    algorithm: "chacha20-poly1305",
    keyDerivation: "hkdf-sha256",
    keyMode: {
      type: "wrapped",
      pubkeys: [auditorPubkey1, auditorPubkey2],
    },
  },
  storage,
  attestor,
  batcher,
  prover,
});
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 2.0.0-draft | 2026-02-01 | PACT Architect | Initial architectural specification |

---

## References

1. [PoI SDK GitHub Repository](https://github.com/Flux-Point-Studios/poi-sdk)
2. [Cardano Metadata Labels (CIP-10)](https://cips.cardano.org/cips/cip10/)
3. [Hydra Protocol Specification](https://hydra.family/head-protocol/)
4. [Midnight Network Documentation](https://docs.midnight.network/)
5. [AMD SEV-SNP Documentation](https://www.amd.com/en/developer/sev.html)
6. [AWS Nitro Enclaves](https://docs.aws.amazon.com/enclaves/)
7. [Intel TDX Specification](https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/overview.html)
