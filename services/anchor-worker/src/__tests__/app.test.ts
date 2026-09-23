import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubmitQueueFullError } from "@fluxpointstudios/orynq-sdk-anchors-cardano";

import type { AnchorProcessTrace } from "../anchor.js";
import { createApp, RETRY_AFTER_SECONDS } from "../app.js";
import {
  emulatorHarness,
  expectEachSpendsThePreviousChange,
  manifest,
} from "./emulator-harness.js";

const TOKEN = "internal-token";
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

async function serve(anchor: AnchorProcessTrace): Promise<string> {
  const server = createApp({ token: TOKEN, network: "preprod", anchor }).listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(base: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return fetch(`${base}/anchor/process-trace`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { "X-Internal-Token": token }),
    },
    body: JSON.stringify(body),
  });
}

const stubResult = {
  txHash: "ab".repeat(32),
  network: "preprod",
  label: 2222,
  rootHash: manifest(1).rootHash,
  manifestHash: manifest(1).manifestHash,
};

describe("POST /anchor/process-trace", () => {
  it("rejects a missing or wrong token", async () => {
    const base = await serve(async () => stubResult);

    expect((await post(base, { requestId: "r", manifest: manifest(1) }, null)).status).toBe(403);
    expect((await post(base, { requestId: "r", manifest: manifest(1) }, "nope")).status).toBe(403);
  });

  it("rejects a manifest without a manifestHash", async () => {
    const base = await serve(async () => stubResult);

    const res = await post(base, { requestId: "r", manifest: { rootHash: "sha256:aa" } });

    expect(res.status).toBe(400);
  });

  it.each([
    ["manifest.manifestHash", { manifestHash: `SHA256:${"B".repeat(64)}` }],
    ["manifest.manifestHash", { manifestHash: "b".repeat(63) }],
    ["manifest.rootHash", { rootHash: "aaaa:bbbb" }],
    ["manifest.rootHash", { rootHash: 42 }],
    ["manifest.merkleRoot", { merkleRoot: "not-a-hash" }],
  ])("rejects a malformed %s with 400 before anchoring", async (field, override) => {
    const anchor = vi.fn(async () => stubResult);
    const base = await serve(anchor);

    const res = await post(base, { requestId: "r", manifest: { ...manifest(1), ...override } });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(field);
    expect(anchor).not.toHaveBeenCalled();
  });

  it("accepts bare lowercase hashes, as the recorder sends them", async () => {
    const anchor = vi.fn(async () => stubResult);
    const base = await serve(anchor);
    const bare = { rootHash: "a".repeat(64), manifestHash: "b".repeat(64), merkleRoot: "c".repeat(64) };

    const res = await post(base, { requestId: "r", manifest: bare });

    expect(res.status).toBe(200);
    expect(anchor).toHaveBeenCalledWith("r", bare, undefined);
  });

  it("returns the anchor with its network and label", async () => {
    const base = await serve(async () => stubResult);

    const res = await post(base, { requestId: "r", manifest: manifest(1) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, ...stubResult });
  });

  it("sheds load with 503 and Retry-After when the submit queue is full, still naming network and label", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await serve(async () => {
      throw new SubmitQueueFullError(50);
    });

    const res = await post(base, { requestId: "r", manifest: manifest(1) });

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
    expect(await res.json()).toEqual({
      success: false,
      error: "submit queue is full: 50 submissions pending",
      network: "preprod",
      label: 2222,
    });
  });

  it("reports any other failure as 500 with network and label", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = await serve(async () => {
      throw new Error("Could not submit transaction.");
    });

    const res = await post(base, { requestId: "r", manifest: manifest(1) });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      success: false,
      error: "Could not submit transaction.",
      network: "preprod",
      label: 2222,
    });
  });
});

describe("POST /anchor/process-trace against a one-UTxO wallet", () => {
  it("serves a concurrent burst, duplicates included, as one chain of distinct anchors", async () => {
    const { anchor, submitted } = await emulatorHarness();
    const base = await serve(anchor);

    const responses = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => post(base, { requestId: `r${i}`, manifest: manifest(i) })),
      ...[2, 5, 5].map((i, n) => post(base, { requestId: `dup${n}`, manifest: manifest(i) })),
    ]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{ txHash: string }>;

    expect(responses.map((r) => r.status)).toEqual(Array(13).fill(200));
    expect(submitted).toHaveLength(10);
    expectEachSpendsThePreviousChange(submitted);
    expect(bodies[10]!.txHash).toBe(bodies[2]!.txHash);
    expect(bodies[11]!.txHash).toBe(bodies[5]!.txHash);
    expect(bodies[12]!.txHash).toBe(bodies[5]!.txHash);
  });

  it("answers 503 to new manifests once maxPending are waiting, and lands the admitted ones", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { emulator, anchor, submitted } = await emulatorHarness({ maxPending: 2 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const submitTx = emulator.submitTx.bind(emulator);
    emulator.submitTx = async (cbor: string) => {
      await held;
      return submitTx(cbor);
    };
    const base = await serve(anchor);

    const answered: Response[] = [];
    const pending = Array.from({ length: 5 }, (_, i) =>
      post(base, { requestId: `r${i}`, manifest: manifest(i) }).then((res) => {
        answered.push(res);
        return res;
      })
    );
    // The first admitted request is held at submit, so the other admitted one
    // waits behind it and the remaining three must be turned away meanwhile.
    await vi.waitFor(() => expect(answered.filter((r) => r.status === 503)).toHaveLength(3));
    release();
    const responses = await Promise.all(pending);

    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 200, 503, 503, 503]);
    for (const res of responses.filter((r) => r.status === 503)) {
      expect(res.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
      expect(await res.json()).toMatchObject({ success: false, network: "preprod", label: 2222 });
    }
    expect(submitted).toHaveLength(2);
    expectEachSpendsThePreviousChange(submitted);
  });
});
