/**
 * Health check handler.
 */

import type { Request, Response } from "express";

export function healthHandler(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    service: "blob-gateway",
  });
}
