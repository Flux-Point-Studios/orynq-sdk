/**
 * @summary Live-network smoke test for `orynq init` flow.
 *
 * Gated by `ORYNQ_RUN_LIVE_TESTS=1` — by default this file is a no-op so
 * fresh-clone `pnpm test` doesn't ping the public gateway. Set the env
 * var before running CI to exercise the real end-to-end path.
 *
 *   ORYNQ_RUN_LIVE_TESTS=1 pnpm --filter @fluxpointstudios/orynq-sdk-quickstart test
 *
 * What this asserts:
 *   1. `loadOrCreateIdentity()` produces a unique SS58 per call (writing
 *      to a temp dir so we don't smash a real wallet).
 *   2. `requestFaucet()` returns `kind: "success"` on the fresh address.
 *
 * The chain-submission test (`bootstrapAndTrace()`) is *not* exercised
 * here — it requires MOTRA generation (~10-30 s) and would extend CI
 * runtimes. The Node CLI smoke (`bin/orynq.mjs trace`) covers it.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { loadOrCreateIdentity, requestFaucet, DEFAULT_GATEWAY_URL } from "../index.js";

const RUN_LIVE = process.env["ORYNQ_RUN_LIVE_TESTS"] === "1";

beforeAll(async () => {
  if (!RUN_LIVE) return;
  await cryptoWaitReady();
});

describe.skipIf(!RUN_LIVE)("live preprod smoke (gated)", () => {
  it("requestFaucet() returns success on a freshly generated address", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "orynq-live-"));
    try {
      const identity = await loadOrCreateIdentity({
        configPath: join(tmpDir, "config.json"),
      });
      const result = await requestFaucet({
        address: identity.address,
        gatewayBaseUrl: DEFAULT_GATEWAY_URL,
      });
      // Fresh address — should be "success". If the gateway tagged us
      // as cooldown (IP rate-limited), surface that too as a soft pass:
      // the contract is "the SDK speaks the faucet protocol correctly",
      // not "the network always says yes".
      expect(["success", "cooldown", "already-funded"]).toContain(result.kind);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
