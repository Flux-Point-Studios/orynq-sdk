import { afterEach, describe, expect, it, vi } from "vitest";
import { midnightExtrinsic } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { mainnetBroadcast } from "../src/broadcast.js";

vi.mock("@fluxpointstudios/orynq-sdk-anchors-midnight", async (original) => ({
  ...await original<typeof import("@fluxpointstudios/orynq-sdk-anchors-midnight")>(),
  readPrivateFile: () => "test-session-only",
}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("mainnet broadcast transports", () => {
  it("bounds a silent WebSocket and still tries HTTP", async () => {
    vi.useFakeTimers();
    let closed = false;
    class Socket extends EventTarget { close() { closed = true; } }
    vi.stubGlobal("WebSocket", Socket);
    const http = vi.fn(async () => new Response(JSON.stringify({ id: 1, result: `0x${"ab".repeat(32)}` })));
    vi.stubGlobal("fetch", http);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const result = mainnetBroadcast(new Uint8Array([1]), async () => undefined, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(closed).toBe(true);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it.each(["accepted", "duplicate", "failure"])("uses the same extrinsic on WS and HTTP with %s extra paths", async (mode) => {
    const requests: string[] = [];
    const urls: string[] = [];
    const hash = `0x${"ab".repeat(32)}`;
    const answer = mode === "accepted" ? { result: hash } : { error: { code: mode === "duplicate" ? 1012 : 1010 } };
    class Socket extends EventTarget {
      constructor(url: string) { super(); urls.push(url); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(body: string) { requests.push(body); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: 1, ...answer }) }))); }
      close() {}
    }
    vi.stubGlobal("WebSocket", Socket);
    const http = vi.fn(async (_url: string, options: RequestInit) => {
      requests.push(options.body as string);
      expect(options.headers).toEqual({ "Content-Type": "application/json", "X-Session-Token": "test-session-only" });
      expect(options.redirect).toBe("error");
      return new Response(JSON.stringify({ id: 1, ...answer }));
    });
    vi.stubGlobal("fetch", http);
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const bytes = new Uint8Array([1, 2, 3]);
    const primary = vi.fn(async () => undefined);
    await mainnetBroadcast(bytes, primary, Date.now() + 60_000);
    expect(primary).toHaveBeenCalledWith(bytes);
    expect(urls).toEqual(["wss://rpc.mainnet.midnight.network"]);
    expect(http.mock.calls[0]![0]).toBe("https://api.1am.xyz/rpc/midnight");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(JSON.parse(requests[0]!).params).toEqual([`0x${Buffer.from(midnightExtrinsic(bytes)).toString("hex")}`]);
    expect(output.mock.calls.flat().join("")).not.toContain("test-session-only");
  });
});
