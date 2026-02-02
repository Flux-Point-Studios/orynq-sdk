/**
 * @fluxpointstudios/poi-sdk-hydra-batcher
 *
 * High-frequency L2 commitment lane using Cardano Hydra for sub-second finality.
 * Batches PoI commitments in a Hydra head for cost-efficient, high-throughput anchoring.
 *
 * @example
 * ```typescript
 * import { HydraBatcher } from '@fluxpointstudios/poi-sdk-hydra-batcher';
 *
 * const batcher = new HydraBatcher({
 *   recorderNode: {
 *     nodeId: 'recorder',
 *     host: 'localhost',
 *     port: 4001,
 *     verificationKey: '...',
 *   },
 *   auditorNodes: [{
 *     nodeId: 'auditor',
 *     host: 'auditor.example.com',
 *     port: 4001,
 *     verificationKey: '...',
 *   }],
 *   commitmentIntervalMs: 1000,
 *   commitmentBatchSize: 100,
 *   settlementPolicy: {
 *     maxCommitsBeforeSettlement: 1000,
 *     maxTimeBeforeSettlementMs: 3600000,
 *   },
 *   network: 'preprod',
 * });
 *
 * // Open a Hydra head
 * const handle = await batcher.openHead();
 *
 * // Queue items for commitment
 * await batcher.queueItems([{
 *   sessionId: 'session-1',
 *   rootHash: 'abc123...',
 *   merkleRoot: 'def456...',
 *   manifestHash: '789abc...',
 *   timestamp: new Date().toISOString(),
 * }]);
 *
 * // Or commit immediately
 * const result = await batcher.commit([...items]);
 *
 * // Close head and settle to L1
 * const settlement = await batcher.closeHead();
 * console.log('Settlement:', settlement.l1TxHash);
 * ```
 */

// Types
export * from "./types.js";

// Main batcher
export { HydraBatcher } from "./batcher.js";

// Head management
export { HeadManager } from "./head/index.js";

// Commitment utilities
export {
  BatchAccumulator,
  SettlementTrigger,
  createDefaultPolicy,
  createHighFrequencyPolicy,
  createLowFrequencyPolicy,
  type SettlementCheck,
  type SettlementReason,
} from "./commitment/index.js";

// Monitoring
export {
  MetricsCollector,
  HealthChecker,
  type BatcherMetrics,
  type LatencyBucket,
  type HealthStatus,
} from "./monitor/index.js";
