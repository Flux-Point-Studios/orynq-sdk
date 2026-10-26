import { expect, it, vi } from "vitest";
import { startStandingFollower } from "../standing-service.js";

it("holds and retries a bounded startup failure rather than terminating the standing service", async () => {
  const start = vi.fn().mockRejectedValueOnce(new Error("cold source deadline")).mockRejectedValueOnce(new Error("temporary read queue failure")).mockResolvedValue({ authenticated: true });
  const hold = vi.fn(), abort = new AbortController();
  await expect(startStandingFollower({ catchup: { start }, signal: abort.signal, hold, retryMs: 0 })).resolves.toEqual({ authenticated: true });
  expect(start).toHaveBeenCalledTimes(3); expect(hold).toHaveBeenCalledTimes(2);
});
it("retains a fatal continuity hold and never retries it in the same process", async () => {
  const start = vi.fn().mockRejectedValue(new Error("policy continuity failed; process restart required")), hold = vi.fn();
  await expect(startStandingFollower({ catchup: { start }, signal: new AbortController().signal, hold, retryMs: 0 })).rejects.toThrow(/restart required/);
  expect(start).toHaveBeenCalledOnce(); expect(hold).toHaveBeenCalledOnce();
});
it("drains a startup hold promptly on service cancellation without authenticating or initializing a controller", async () => {
  const abort = new AbortController(), start = vi.fn().mockRejectedValue(new Error("source unavailable"));
  const hold = vi.fn(() => abort.abort());
  await expect(startStandingFollower({ catchup: { start }, signal: abort.signal, hold })).rejects.toThrow();
  expect(start).toHaveBeenCalledOnce();
});
