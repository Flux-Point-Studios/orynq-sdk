/**
 * Core types for the PoI Flight Recorder.
 */

// === TEE Types ===

export type TeeType = "sev-snp" | "tdx" | "sgx" | "nitro" | "gpu-cc";

// === Visibility ===

export type Visibility = "public" | "private" | "redacted";

// === Encryption Configuration ===

export interface EncryptionConfig {
  algorithm: "aes-256-gcm" | "chacha20-poly1305";
  keyDerivation: "hkdf-sha256";
  keyMode:
    | { type: "ephemeral" }
    | { type: "sealed"; teeType: TeeType }
    | { type: "wrapped"; pubkeys: string[] };
}

// === Recorder Configuration ===

export interface RecorderConfig {
  agentId: string;
  sessionId?: string;
  chunkSizeBytes: number;
  chunkTimeoutMs?: number;
  encryption: EncryptionConfig;
  storage: StorageAdapter;
  attestor?: Attestor;
  captureRuntime?: boolean;
}

// === Storage Adapter Interface ===

export interface StorageAdapter {
  readonly type: "local" | "ipfs" | "s3" | "arweave";
  store(data: Uint8Array): Promise<StorageRef>;
  storeManifest(manifest: ManifestV2): Promise<StorageRef>;
  fetch(ref: StorageRef): Promise<Uint8Array>;
  fetchManifest(ref: StorageRef): Promise<ManifestV2>;
  verify(ref: StorageRef): Promise<boolean>;
  delete?(ref: StorageRef): Promise<void>;
  pin?(ref: StorageRef): Promise<void>;
}

export interface StorageRef {
  type: "local" | "ipfs" | "s3" | "arweave";
  uri: string;
  hash: string;
  size: number;
}

// === Attestor Interface ===

export interface Attestor {
  readonly teeType: TeeType;
  attest(hashToSign: string): Promise<AttestationBundle>;
  getMeasurements(): Promise<Measurements>;
  isAttested(): boolean;
}

export interface AttestationBundle {
  teeType: TeeType;
  teeVersion: string;
  evidence: {
    format: "raw" | "base64" | "cbor";
    data?: string;
    hash?: string;
    storageUri?: string;
  };
  binding: {
    hash: string;
    hashType: "rootHash" | "manifestHash" | "merkleRoot";
    timestamp: string;
  };
  verifierPolicy: VerifierPolicy;
  attestorId: string;
  attestorPubkey?: string;
}

export interface VerifierPolicy {
  expectedMeasurements?: string[];
  allowedSignerKeys?: string[];
  minFirmwareVersion?: string;
  minSvn?: number;
  checkRevocation?: boolean;
  revocationListUri?: string;
}

export interface Measurements {
  firmwareVersion?: string;
  sevSnp?: { launchMeasurement: string; guestPolicy: string };
  tdx?: { mrTd: string; mrConfigId: string; tdAttributes: string };
  sgx?: { mrEnclave: string; mrSigner: string; isvProdId: number; isvSvn: number };
  nitro?: { pcrs: Record<number, string>; moduleId: string };
}

// === Event Types ===

export type RecorderEvent =
  | InferenceStartEvent
  | InferenceEndEvent
  | ToolCallEvent
  | ToolResultEvent
  | StreamChunkEvent
  | DecisionEvent
  | ErrorEvent
  | CustomEvent;

export interface BaseEvent {
  seq: number;
  ts: string;
  spanId?: string;
}

export interface InferenceStartEvent extends BaseEvent {
  kind: "inference:start";
  requestId: string;
  model: string;
  promptHash: string;
  systemPromptHash?: string;
  params: InferenceParams;
}

export interface InferenceEndEvent extends BaseEvent {
  kind: "inference:end";
  requestId: string;
  outputHash: string;
  tokenCounts: {
    prompt: number;
    completion: number;
  };
  durationMs: number;
}

export interface ToolCallEvent extends BaseEvent {
  kind: "tool:call";
  toolName: string;
  argsHash: string;
  visibility: Visibility;
}

export interface ToolResultEvent extends BaseEvent {
  kind: "tool:result";
  toolName: string;
  resultHash: string;
  success: boolean;
  visibility: Visibility;
}

export interface StreamChunkEvent extends BaseEvent {
  kind: "stream:chunk";
  chunkHash: string;
  index: number;
}

export interface DecisionEvent extends BaseEvent {
  kind: "decision";
  decisionType: string;
  choiceHash: string;
  rationale?: string;
}

export interface ErrorEvent extends BaseEvent {
  kind: "error";
  errorType: string;
  message: string;
  recoverable: boolean;
}

export interface CustomEvent extends BaseEvent {
  kind: "custom";
  eventType: string;
  dataHash: string;
  metadata?: Record<string, unknown>;
}

export interface InferenceParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  stopStrings?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
}

// === Chunk Types ===

export interface ChunkRef {
  id: string;
  hash: string;
  size: number;
  storageUri: string;
  encryptionKeyId: string;
  compression: "zstd" | "gzip" | "none";
}

export interface ChunkData {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  meta: {
    index: number;
    eventRange: [number, number];
    spanIds: string[];
    createdAt: string;
  };
}

// === ManifestV2 ===

export interface ManifestV2 {
  formatVersion: "2.0";

  // Identity
  agentId: string;
  sessionId: string;

  // Cryptographic commitments
  rootHash: string;
  merkleRoot: string;
  manifestHash: string;

  // Input commitments
  inputs: {
    promptHash: string;
    systemPromptHash?: string;
    toolContextHash?: string;
    encryptedCiphertextHashes?: string[];
  };

  // Inference parameters
  params: {
    model: string;
    modelWeightDigest?: string;
    tokenizerDigest?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    stopStrings?: string[];
    frequencyPenalty?: number;
    presencePenalty?: number;
    toolPolicy?: Record<string, unknown>;
  };

  // Runtime identity
  runtime: {
    recorderVersion: string;
    containerDigest?: string;
    gitCommit?: string;
    dependencies?: Record<string, string>;
    gpuDriver?: string;
    nodeVersion?: string;
  };

  // Chunk references
  chunks: ChunkRef[];

  // Output summary
  outputs: {
    transcriptRollingHash: string;
    toolCallCount: number;
    totalTokens: number;
    completionTokens: number;
  };

  // Attestation (optional)
  attestation?: {
    teeType: TeeType;
    evidenceHash: string;
    evidenceUri?: string;
    verifierPolicy: VerifierPolicy;
    boundHash: "rootHash" | "manifestHash" | "merkleRoot";
  };

  // Timestamps
  createdAt: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;

  // Statistics
  totalEvents: number;
  totalSpans: number;
}

// === Recording Session ===

export interface RecordingSession {
  sessionId: string;
  agentId: string;
  startedAt: string;
  status: "recording" | "finalizing" | "finalized" | "aborted";
}

export interface RecordingResult {
  rootHash: string;
  merkleRoot: string;
  manifestHash: string;
  manifest: ManifestV2;
  chunkRefs: ChunkRef[];
  attestation?: AttestationBundle;
  anchorEntry: AnchorEntry;
}

export interface AnchorEntry {
  schema: "poi-anchor-v2";
  rootHash: string;
  merkleRoot: string;
  manifestHash: string;
  storageUri: string;
  agentId: string;
  sessionId: string;
  timestamp: string;
}

// === Errors ===

export enum FlightRecorderError {
  RECORDING_NOT_STARTED = 1001,
  RECORDING_ALREADY_FINALIZED = 1002,
  CHUNK_CREATION_FAILED = 1003,
  ENCRYPTION_FAILED = 1004,
  COMPRESSION_FAILED = 1005,
  STORAGE_WRITE_FAILED = 2001,
  STORAGE_READ_FAILED = 2002,
  STORAGE_NOT_FOUND = 2003,
  ATTESTATION_NOT_AVAILABLE = 3001,
  ATTESTATION_FAILED = 3002,
}

export class FlightRecorderException extends Error {
  constructor(
    public readonly code: FlightRecorderError,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "FlightRecorderException";
  }
}
