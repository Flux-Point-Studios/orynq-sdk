/**
 * Health and status handlers for anchor worker.
 */

import type { Request, Response } from "express";

let connected = false;
let anchorCount = 0;

export function setConnected(value: boolean): void {
  connected = value;
}

export function incrementAnchorCount(): void {
  anchorCount++;
}

export function healthHandler(_req: Request, res: Response): void {
  res.json({
    status: connected ? "ok" : "degraded",
    service: "anchor-worker-materios",
    connected,
  });
}

export function readyHandler(_req: Request, res: Response): void {
  if (connected) {
    res.json({ status: "ready" });
  } else {
    res.status(503).json({ status: "not ready", reason: "not connected to Materios node" });
  }
}

export function statusHandler(_req: Request, res: Response): void {
  res.json({
    status: connected ? "ok" : "degraded",
    connected,
    anchorsSubmitted: anchorCount,
    uptime: process.uptime(),
  });
}
