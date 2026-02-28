/**
 * Health check handler with PVC storage stats.
 * Cached 60s to keep K8s probe overhead low.
 */

import type { Request, Response } from "express";
import { statfs, readdir } from "fs/promises";
import { join } from "path";
import { config } from "./config.js";

interface HealthData {
  status: string;
  service: string;
  uptime: number;
  storage: {
    totalReceipts: number;
    pvcFreeBytes: number;
    pvcTotalBytes: number;
    usagePercent: number;
  };
}

let cachedHealth: HealthData | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

export async function getHealthData(): Promise<HealthData> {
  const now = Date.now();
  if (cachedHealth && (now - cacheTime) < CACHE_TTL_MS) {
    return { ...cachedHealth, uptime: process.uptime() };
  }

  let totalReceipts = 0;
  let pvcFreeBytes = 0;
  let pvcTotalBytes = 0;

  try {
    const receiptsDir = join(config.storagePath, "receipts");
    const entries = await readdir(receiptsDir);
    totalReceipts = entries.length;
  } catch {
    // receipts dir may not exist yet
  }

  try {
    const stats = await statfs(config.storagePath);
    pvcFreeBytes = Number(stats.bfree) * Number(stats.bsize);
    pvcTotalBytes = Number(stats.blocks) * Number(stats.bsize);
  } catch {
    // statfs not available
  }

  const usagePercent = pvcTotalBytes > 0
    ? Math.round(((pvcTotalBytes - pvcFreeBytes) / pvcTotalBytes) * 1000) / 10
    : 0;

  cachedHealth = {
    status: "ok",
    service: "blob-gateway",
    uptime: process.uptime(),
    storage: { totalReceipts, pvcFreeBytes, pvcTotalBytes, usagePercent },
  };
  cacheTime = now;

  return cachedHealth;
}

export function healthHandler(_req: Request, res: Response): void {
  getHealthData()
    .then((data) => res.json(data))
    .catch(() => res.json({ status: "ok", service: "blob-gateway" }));
}
