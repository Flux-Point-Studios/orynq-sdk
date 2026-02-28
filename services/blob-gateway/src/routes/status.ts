/**
 * Aggregated status page — cached 15s to prevent DoS amplification.
 * Public endpoint (no auth required).
 */

import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { getHealthData } from "../health.js";

export const statusRouter = Router();

interface ComponentStatus {
  status: string;
  [key: string]: unknown;
}

interface AggregatedStatus {
  overall: "healthy" | "degraded" | "unhealthy";
  components: Record<string, ComponentStatus>;
  timestamp: string;
}

let cachedStatus: AggregatedStatus | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 15_000;

async function fetchServiceStatus(url: string, timeoutMs = 5000): Promise<ComponentStatus> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${url}/status`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      return await res.json() as ComponentStatus;
    }
    return { status: "error", httpStatus: res.status };
  } catch (err) {
    console.error(`[blob-gateway] Status fetch failed for ${url}:`, err instanceof Error ? err.message : err);
    return { status: "unknown" };
  }
}

async function buildStatus(): Promise<AggregatedStatus> {
  const [gateway, certDaemonAlice, certDaemonBob, anchorWorker] = await Promise.all([
    getHealthData(),
    fetchServiceStatus(config.certDaemonAliceUrl),
    fetchServiceStatus(config.certDaemonBobUrl),
    fetchServiceStatus(config.anchorWorkerUrl),
  ]);

  const components: Record<string, ComponentStatus> = {
    gateway: gateway as unknown as ComponentStatus,
    certDaemonAlice,
    certDaemonBob,
    anchorWorker,
  };

  // Determine overall status
  const statuses = Object.values(components).map((c) => c.status);
  let overall: "healthy" | "degraded" | "unhealthy";
  if (statuses.every((s) => s === "ok")) {
    overall = "healthy";
  } else if (statuses.some((s) => s === "ok")) {
    overall = "degraded";
  } else {
    overall = "unhealthy";
  }

  return {
    overall,
    components,
    timestamp: new Date().toISOString(),
  };
}

statusRouter.get("/status", async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (cachedStatus && (now - cacheTime) < CACHE_TTL_MS) {
      res.json(cachedStatus);
      return;
    }

    cachedStatus = await buildStatus();
    cacheTime = now;
    res.json(cachedStatus);
  } catch (error) {
    console.error("[blob-gateway] Status error:", error);
    res.status(500).json({ overall: "unhealthy", error: "Failed to collect status" });
  }
});
