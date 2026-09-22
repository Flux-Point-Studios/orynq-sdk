/**
 * Network-edge probes for anchor.ts, importing SOURCE and stubbing fetch.
 *
 * These cover the paths that rot silently: a timeout that never fires and a
 * poll that misclassifies a proxy error both look like healthy systems.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { anchorManifest, checkAnchorStatus } from "../src/anchor";

const BASE = { baseUrl: "https://x.test", endpointPath: "/anchor", manifest: {} };
const STATUS = { baseUrl: "https://x.test", requestId: "r" };
const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());
const stubFetch = (fn: unknown) => vi.stubGlobal("fetch", fn);

describe("anchorManifest — the fetch is bounded", () => {
  it("passes an abort signal and parses the body", async () => {
    let sawSignal = false;
    stubFetch(async (_u: string, o: RequestInit) => {
      sawSignal = !!o.signal;
      return json({ status: "CONFIRMED", txHash: "ab" });
    });
    const res = await anchorManifest({ ...BASE });
    expect(sawSignal).toBe(true);
    expect(res.ok).toBe(true);
    expect((res.json as { txHash: string }).txHash).toBe("ab");
  });

  it("a hanging request aborts at the deadline instead of stalling the daemon", async () => {
    // The daemon has no other thread: one stalled socket stops ALL anchoring,
    // with no error and no log line.
    stubFetch((_u: string, o: RequestInit) => new Promise((_res, rej) => {
      o.signal?.addEventListener("abort", () =>
        rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const started = Date.now();
    await expect(anchorManifest({ ...BASE, timeoutMs: 150 })).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("clears its timer on the success path, so the event loop can drain", async () => {
    stubFetch(async () => json({}));
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await anchorManifest({ ...BASE, timeoutMs: 600_000 });
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBe(before);
  });

  it("a non-JSON error body does not throw", async () => {
    stubFetch(async () => json("<html>502 Bad Gateway</html>", 502));
    const res = await anchorManifest({ ...BASE });
    expect(res.ok).toBe(false);
  });
});

describe("checkAnchorStatus — 'unknown' is the only state that re-posts", () => {
  it("the server's own not-found is unknown", async () => {
    stubFetch(async () => json({ detail: "anchor_request_not_found" }, 404));
    expect((await checkAnchorStatus(STATUS)).state).toBe("unknown");
  });

  it.each([
    ["a proxy HTML 404", "<html>404</html>"],
    ["a 404 with a different detail", JSON.stringify({ detail: "route_not_found" })],
    ["an empty 404 body", ""]
  ])("%s is an error, never a re-post", async (_l, body) => {
    stubFetch(async () => json(body, 404));
    expect((await checkAnchorStatus(STATUS)).state).toBe("error");
  });

  it("a non-404 HTTP error is an error", async () => {
    stubFetch(async () => json({ detail: "nope" }, 500));
    expect((await checkAnchorStatus(STATUS)).state).toBe("error");
  });

  it.each(["CONFIRMED"])("%s is confirmed", async (status) => {
    stubFetch(async () => json({ status, txHash: "ab" }));
    expect((await checkAnchorStatus(STATUS)).state).toBe("confirmed");
  });

  it("confirmations >= 1 is confirmed", async () => {
    stubFetch(async () => json({ status: "PENDING", confirmations: 2 }));
    expect((await checkAnchorStatus(STATUS)).state).toBe("confirmed");
  });

  it.each(["ERROR", "FAILED"])("a 200 carrying an inner %s is an error, not confirmed", async (status) => {
    stubFetch(async () => json({ status, detail: "insufficient funds" }));
    expect((await checkAnchorStatus(STATUS)).state).toBe("error");
  });

  it("an explicit failure outranks a confirmation count, as in classifyAnchorResponse", async () => {
    // The two classifiers must agree. This body used to poll as "confirmed"
    // here while classifying as "failed" on the POST path.
    stubFetch(async () => json({ status: "FAILED", confirmations: 1 }));
    expect((await checkAnchorStatus(STATUS)).state).toBe("error");
  });

  it("PENDING is pending", async () => {
    stubFetch(async () => json({ status: "PENDING" }));
    expect((await checkAnchorStatus(STATUS)).state).toBe("pending");
  });

  it("a network throw is caught and reported as error, not unknown", async () => {
    // "unknown" would re-post. A transient ECONNRESET must never do that.
    stubFetch(async () => { throw new Error("ECONNRESET"); });
    const res = await checkAnchorStatus(STATUS);
    expect(res.state).toBe("error");
  });
});
