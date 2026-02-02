/**
 * Core types for the PoI Hydra Batcher.
 * Provides high-frequency L2 commitment lane using Cardano Hydra.
 */

// === Network Types ===

export type CardanoNetwork = "mainnet" | "preprod" | "preview";

// === Hydra Node Configuration ===

export interface HydraNode {
  nodeId: string;
  host: string;
  port: number;
  verificationKey: string;
  signingKey?: string; // Only for our own node
}

export interface HydraEndpoints {
  websocket: string;  // ws://host:port
  api?: string;       // http://host:port/api (if available)
}

// === Batcher Configuration ===

export interface HydraBatcherConfig {
  // Participants
  recorderNode: HydraNode;
  auditorNodes: HydraNode[];

  // Commitment pattern
  commitmentIntervalMs: number;     // How often to commit (default: 1000)
  commitmentBatchSize: number;      // Max items per commit (default: 100)

  // Settlement triggers
  settlementPolicy: SettlementPolicy;

  // Network
  network: CardanoNetwork;

  // Hydra connection
  hydraEndpoints?: HydraEndpoints;

  // Retry configuration
  retryConfig?: RetryConfig;

  // Logging
  debug?: boolean;
}

export interface SettlementPolicy {
  // Settle after N commits
  maxCommitsBeforeSettlement: number;

  // Settle after time (ms)
  maxTimeBeforeSettlementMs: number;

  // Settle on accumulated value threshold (lovelace)
  valueThresholdLovelace?: bigint;

  // Force settlement on specific events
  settleOnEvents?: SettlementEvent[];
}

export type SettlementEvent = "error" | "shutdown" | "key-rotation" | "head-closing";

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

// === Commitment Types ===

export interface CommitmentDatum {
  // Current accumulator state
  accumulatorRoot: string;    // Merkle root of all committed roots
  commitCount: number;

  // Latest batch
  latestBatchRoot: string;
  latestBatchTimestamp: number;

  // History (for verification)
  batchHistory: BatchHistoryEntry[];
}

export interface BatchHistoryEntry {
  batchRoot: string;
  timestamp: number;
  itemCount: number;
}

export interface BatchItem {
  sessionId: string;
  rootHash: string;
  merkleRoot: string;
  manifestHash: string;
  timestamp: string;
}

// === Head Management ===

export type HeadStatus =
  | "initializing"
  | "open"
  | "closing"
  | "closed"
  | "fanout"
  | "error";

export interface HeadHandle {
  headId: string;
  participants: string[];
  openedAt: string;
  status: HeadStatus;
  utxoHash?: string;  // Current UTxO holding the commitment
}

export interface HeadState {
  headId: string;
  status: HeadStatus;
  contestationDeadline?: string;
  snapshotNumber: number;
  utxos: HydraUtxo[];
}

export interface HydraUtxo {
  txIn: string;       // txHash#index
  address: string;
  value: UtxoValue;
  datum: string | undefined;     // Inline datum hash or value
  datumHash: string | undefined;
}

export interface UtxoValue {
  lovelace: bigint;
  assets?: Record<string, bigint>;  // policyId.assetName -> amount
}

// === Transaction Types ===

export interface L2Transaction {
  txId: string;
  inputs: string[];
  outputs: L2Output[];
  validityRange?: {
    invalidBefore?: number;
    invalidAfter?: number;
  };
}

export interface L2Output {
  address: string;
  value: UtxoValue;
  datum?: unknown;
  datumHash?: string;
}

// === Results ===

export interface CommitResult {
  l2TxHash: string;
  newAccumulatorRoot: string;
  commitIndex: number;
  timestamp: string;
  itemCount: number;
  snapshotNumber: number;
}

export interface SettlementResult {
  l1TxHash: string;
  finalAccumulatorRoot: string;
  totalCommits: number;
  totalItems: number;
  anchorEntry: AnchorEntry;
  fanoutUtxos: string[];
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
  l2Metadata?: {
    headId: string;
    totalCommits: number;
    settlementTxHash: string;
  };
}

// === Batcher Status ===

export interface BatcherStatus {
  headStatus: HeadStatus;
  headId: string | undefined;
  pendingItems: number;
  totalCommits: number;
  totalItems: number;
  lastCommitTime: string | undefined;
  lastSettlementTime: string | undefined;
  accumulatorRoot: string | undefined;
  snapshotNumber: number;
}

export interface CommitRecord {
  commitIndex: number;
  l2TxHash: string;
  batchRoot: string;
  itemCount: number;
  timestamp: string;
  snapshotNumber: number;
}

// === Events ===

export type BatcherEventType =
  | "head:opening"
  | "head:opened"
  | "head:closing"
  | "head:closed"
  | "head:error"
  | "commit:pending"
  | "commit:confirmed"
  | "commit:failed"
  | "settlement:pending"
  | "settlement:confirmed"
  | "settlement:failed"
  | "snapshot:confirmed";

export interface BatcherEvent {
  type: BatcherEventType;
  timestamp: string;
  data: unknown;
}

export type BatcherEventHandler = (event: BatcherEvent) => void;

// === Errors ===

export enum HydraBatcherError {
  // Connection errors (4000)
  CONNECTION_FAILED = 4000,
  CONNECTION_LOST = 4001,
  HANDSHAKE_FAILED = 4002,

  // Head errors (4100)
  HEAD_OPEN_FAILED = 4100,
  HEAD_ALREADY_OPEN = 4101,
  HEAD_NOT_OPEN = 4102,
  HEAD_CLOSED_UNEXPECTEDLY = 4103,
  HEAD_FANOUT_FAILED = 4104,

  // Commit errors (4200)
  COMMIT_FAILED = 4200,
  COMMIT_REJECTED = 4201,
  BATCH_TOO_LARGE = 4202,
  INVALID_BATCH_ITEM = 4203,

  // Settlement errors (4300)
  SETTLEMENT_FAILED = 4300,
  SETTLEMENT_TIMEOUT = 4301,
  L1_SUBMISSION_FAILED = 4302,

  // State errors (4400)
  INVALID_STATE = 4400,
  SNAPSHOT_MISMATCH = 4401,
  ACCUMULATOR_MISMATCH = 4402,
}

export class HydraBatcherException extends Error {
  constructor(
    public readonly code: HydraBatcherError,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "HydraBatcherException";
  }
}

// === Hydra WebSocket Messages ===

export type HydraMessage =
  | HydraGreetings
  | HydraHeadIsInitializing
  | HydraHeadIsOpen
  | HydraHeadIsClosed
  | HydraHeadIsAborted
  | HydraReadyToFanout
  | HydraTxValid
  | HydraTxInvalid
  | HydraSnapshotConfirmed
  | HydraCommandFailed
  | HydraPostTxOnChainFailed;

export interface HydraGreetings {
  tag: "Greetings";
  headStatus: HydraHeadStatusMessage;
  hydraNodeVersion: string;
  me: { vkey: string };
  snapshotUtxo: Record<string, unknown>;
  timestamp: string;
}

export interface HydraHeadStatusMessage {
  tag: "Idle" | "Initializing" | "Open" | "Closed" | "FanoutPossible";
  contestationDeadline?: string;
}

export interface HydraHeadIsInitializing {
  tag: "HeadIsInitializing";
  headId: string;
  parties: Array<{ vkey: string }>;
  timestamp: string;
}

export interface HydraHeadIsOpen {
  tag: "HeadIsOpen";
  headId: string;
  utxo: Record<string, HydraUtxoMessage>;
  timestamp: string;
}

export interface HydraHeadIsClosed {
  tag: "HeadIsClosed";
  headId: string;
  snapshotNumber: number;
  contestationDeadline: string;
  timestamp: string;
}

export interface HydraHeadIsAborted {
  tag: "HeadIsAborted";
  headId: string;
  utxo: Record<string, HydraUtxoMessage>;
  timestamp: string;
}

export interface HydraReadyToFanout {
  tag: "ReadyToFanout";
  headId: string;
  timestamp: string;
}

export interface HydraTxValid {
  tag: "TxValid";
  headId: string;
  transaction: { cborHex: string };
  timestamp: string;
}

export interface HydraTxInvalid {
  tag: "TxInvalid";
  headId: string;
  utxo: Record<string, HydraUtxoMessage>;
  transaction: { cborHex: string };
  validationError: { reason: string };
  timestamp: string;
}

export interface HydraSnapshotConfirmed {
  tag: "SnapshotConfirmed";
  headId: string;
  snapshot: {
    headId: string;
    number: number;
    utxo: Record<string, HydraUtxoMessage>;
    confirmedTransactions: string[];
  };
  timestamp: string;
}

export interface HydraCommandFailed {
  tag: "CommandFailed";
  clientInput: unknown;
  timestamp: string;
}

export interface HydraPostTxOnChainFailed {
  tag: "PostTxOnChainFailed";
  postChainTx: unknown;
  postTxError: unknown;
  timestamp: string;
}

export interface HydraUtxoMessage {
  address: string;
  value: {
    lovelace: number;
    [policyId: string]: number | Record<string, number>;
  };
  datum?: string;
  datumhash?: string;
  inlineDatum?: unknown;
  referenceScript?: unknown;
}

// === Hydra Commands ===

export interface HydraInit {
  tag: "Init";
}

export interface HydraAbort {
  tag: "Abort";
}

export interface HydraClose {
  tag: "Close";
}

export interface HydraContest {
  tag: "Contest";
}

export interface HydraFanout {
  tag: "Fanout";
}

export interface HydraNewTx {
  tag: "NewTx";
  transaction: { cborHex: string };
}

export type HydraCommand =
  | HydraInit
  | HydraAbort
  | HydraClose
  | HydraContest
  | HydraFanout
  | HydraNewTx;
