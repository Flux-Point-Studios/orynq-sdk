/**
 * Metrics collection for Hydra Batcher.
 * Provides performance monitoring and telemetry.
 */

export interface BatcherMetrics {
  // Throughput
  itemsPerSecond: number;
  commitsPerSecond: number;
  bytesPerSecond: number;

  // Counts
  totalItems: number;
  totalCommits: number;
  totalSettlements: number;
  failedCommits: number;
  failedSettlements: number;

  // Latency (ms)
  avgCommitLatency: number;
  p95CommitLatency: number;
  p99CommitLatency: number;
  avgSettlementLatency: number;

  // Head status
  headUptime: number;
  headReconnects: number;

  // Accumulator
  accumulatorSize: number;
  pendingItems: number;

  // Timestamps
  startTime: string;
  lastCommitTime: string | undefined;
  lastSettlementTime: string | undefined;
}

export interface LatencyBucket {
  count: number;
  sum: number;
  min: number;
  max: number;
  samples: number[];
}

export class MetricsCollector {
  private startTime: Date;
  private commitLatencies: LatencyBucket;
  private settlementLatencies: LatencyBucket;

  private totalItems = 0;
  private totalCommits = 0;
  private totalSettlements = 0;
  private failedCommits = 0;
  private failedSettlements = 0;
  private headReconnects = 0;
  private totalBytes = 0;

  private lastCommitTime: Date | null = null;
  private lastSettlementTime: Date | null = null;
  private headStartTime: Date | null = null;

  private readonly maxSamples: number;

  constructor(maxSamples = 1000) {
    this.startTime = new Date();
    this.maxSamples = maxSamples;
    this.commitLatencies = this.createBucket();
    this.settlementLatencies = this.createBucket();
  }

  /**
   * Record a successful commit.
   */
  recordCommit(itemCount: number, latencyMs: number, sizeBytes?: number): void {
    this.totalItems += itemCount;
    this.totalCommits++;
    this.lastCommitTime = new Date();
    this.addSample(this.commitLatencies, latencyMs);
    if (sizeBytes) {
      this.totalBytes += sizeBytes;
    }
  }

  /**
   * Record a failed commit.
   */
  recordCommitFailure(): void {
    this.failedCommits++;
  }

  /**
   * Record a successful settlement.
   */
  recordSettlement(latencyMs: number): void {
    this.totalSettlements++;
    this.lastSettlementTime = new Date();
    this.addSample(this.settlementLatencies, latencyMs);
  }

  /**
   * Record a failed settlement.
   */
  recordSettlementFailure(): void {
    this.failedSettlements++;
  }

  /**
   * Record head connection.
   */
  recordHeadConnect(): void {
    this.headStartTime = new Date();
  }

  /**
   * Record head disconnection.
   */
  recordHeadDisconnect(): void {
    this.headStartTime = null;
  }

  /**
   * Record head reconnection.
   */
  recordHeadReconnect(): void {
    this.headReconnects++;
    this.headStartTime = new Date();
  }

  /**
   * Get current metrics snapshot.
   */
  getMetrics(accumulatorSize: number, pendingItems: number): BatcherMetrics {
    const now = new Date();
    const elapsedSeconds = (now.getTime() - this.startTime.getTime()) / 1000;

    return {
      // Throughput
      itemsPerSecond: elapsedSeconds > 0 ? this.totalItems / elapsedSeconds : 0,
      commitsPerSecond: elapsedSeconds > 0 ? this.totalCommits / elapsedSeconds : 0,
      bytesPerSecond: elapsedSeconds > 0 ? this.totalBytes / elapsedSeconds : 0,

      // Counts
      totalItems: this.totalItems,
      totalCommits: this.totalCommits,
      totalSettlements: this.totalSettlements,
      failedCommits: this.failedCommits,
      failedSettlements: this.failedSettlements,

      // Latency
      avgCommitLatency: this.getAverage(this.commitLatencies),
      p95CommitLatency: this.getPercentile(this.commitLatencies, 95),
      p99CommitLatency: this.getPercentile(this.commitLatencies, 99),
      avgSettlementLatency: this.getAverage(this.settlementLatencies),

      // Head status
      headUptime: this.headStartTime
        ? (now.getTime() - this.headStartTime.getTime()) / 1000
        : 0,
      headReconnects: this.headReconnects,

      // Accumulator
      accumulatorSize,
      pendingItems,

      // Timestamps
      startTime: this.startTime.toISOString(),
      lastCommitTime: this.lastCommitTime?.toISOString() ?? undefined,
      lastSettlementTime: this.lastSettlementTime?.toISOString() ?? undefined,
    };
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.startTime = new Date();
    this.commitLatencies = this.createBucket();
    this.settlementLatencies = this.createBucket();
    this.totalItems = 0;
    this.totalCommits = 0;
    this.totalSettlements = 0;
    this.failedCommits = 0;
    this.failedSettlements = 0;
    this.headReconnects = 0;
    this.totalBytes = 0;
    this.lastCommitTime = null;
    this.lastSettlementTime = null;
  }

  /**
   * Export metrics in Prometheus format.
   */
  toPrometheus(prefix = "poi_hydra_batcher"): string {
    const metrics = this.getMetrics(0, 0);
    const lines: string[] = [];

    const addMetric = (name: string, value: number, help?: string) => {
      if (help) {
        lines.push(`# HELP ${prefix}_${name} ${help}`);
        lines.push(`# TYPE ${prefix}_${name} gauge`);
      }
      lines.push(`${prefix}_${name} ${value}`);
    };

    addMetric("items_total", metrics.totalItems, "Total items committed");
    addMetric("commits_total", metrics.totalCommits, "Total commits");
    addMetric("settlements_total", metrics.totalSettlements, "Total settlements");
    addMetric("failed_commits_total", metrics.failedCommits, "Failed commits");
    addMetric("failed_settlements_total", metrics.failedSettlements, "Failed settlements");
    addMetric("items_per_second", metrics.itemsPerSecond, "Items per second");
    addMetric("commits_per_second", metrics.commitsPerSecond, "Commits per second");
    addMetric("commit_latency_avg_ms", metrics.avgCommitLatency, "Average commit latency");
    addMetric("commit_latency_p95_ms", metrics.p95CommitLatency, "95th percentile commit latency");
    addMetric("commit_latency_p99_ms", metrics.p99CommitLatency, "99th percentile commit latency");
    addMetric("settlement_latency_avg_ms", metrics.avgSettlementLatency, "Average settlement latency");
    addMetric("head_uptime_seconds", metrics.headUptime, "Head uptime in seconds");
    addMetric("head_reconnects_total", metrics.headReconnects, "Head reconnects");

    return lines.join("\n");
  }

  // === Private Methods ===

  private createBucket(): LatencyBucket {
    return {
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      samples: [],
    };
  }

  private addSample(bucket: LatencyBucket, value: number): void {
    bucket.count++;
    bucket.sum += value;
    bucket.min = Math.min(bucket.min, value);
    bucket.max = Math.max(bucket.max, value);

    bucket.samples.push(value);
    if (bucket.samples.length > this.maxSamples) {
      bucket.samples.shift();
    }
  }

  private getAverage(bucket: LatencyBucket): number {
    return bucket.count > 0 ? bucket.sum / bucket.count : 0;
  }

  private getPercentile(bucket: LatencyBucket, percentile: number): number {
    if (bucket.samples.length === 0) return 0;

    const sorted = [...bucket.samples].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] ?? 0;
  }
}

/**
 * Health status for the batcher.
 */
export interface HealthStatus {
  healthy: boolean;
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    headConnected: boolean;
    commitsWorking: boolean;
    latencyAcceptable: boolean;
    noRecentErrors: boolean;
  };
  lastError: string | undefined;
}

/**
 * Health checker for the batcher.
 */
export class HealthChecker {
  private lastError: string | null = null;
  private lastErrorTime: Date | null = null;

  constructor(
    private readonly maxLatencyMs = 5000,
    private readonly errorWindowMs = 60000
  ) {}

  /**
   * Record an error.
   */
  recordError(error: string): void {
    this.lastError = error;
    this.lastErrorTime = new Date();
  }

  /**
   * Check health based on metrics.
   */
  check(metrics: BatcherMetrics, headConnected: boolean): HealthStatus {
    const checks = {
      headConnected,
      commitsWorking: metrics.failedCommits === 0 || metrics.totalCommits / Math.max(1, metrics.failedCommits) > 10,
      latencyAcceptable: metrics.p95CommitLatency < this.maxLatencyMs,
      noRecentErrors: !this.lastErrorTime ||
        (Date.now() - this.lastErrorTime.getTime()) > this.errorWindowMs,
    };

    const allPassing = Object.values(checks).every(v => v);
    const somePassing = Object.values(checks).some(v => v);

    return {
      healthy: allPassing,
      status: allPassing ? "healthy" : (somePassing ? "degraded" : "unhealthy"),
      checks,
      lastError: this.lastError ?? undefined,
    };
  }

  /**
   * Clear error state.
   */
  clearError(): void {
    this.lastError = null;
    this.lastErrorTime = null;
  }
}
