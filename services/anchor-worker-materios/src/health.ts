/**
 * Health check handlers.
 */

import type { Request, Response } from "express";

let connected = false;

export function setConnected(value: boolean): void {
  connected = value;
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
