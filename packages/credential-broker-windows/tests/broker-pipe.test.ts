import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type BrokerConnection, connectBroker } from "../src/client.js";
import { type Frontend, type FrontendOptions, type Principal, startFrontend } from "../src/frontend.js";
import { FRONTEND_EXECUTABLE } from "./frontend-executable.js";

const whoami = (...args: string[]) =>
  execFileSync(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\whoami.exe`, args, { encoding: "utf8" });
const ownSid = () => whoami("/user", "/fo", "csv", "/nh").trim().split(",")[1].replaceAll('"', "");
const pipeName = () => `\\\\.\\pipe\\orynq-broker-test-${randomBytes(6).toString("hex")}`;
const text = (value: string) => Buffer.from(value, "utf8");

describe.runIf(process.platform === "win32")("broker pipe", { timeout: 30_000 }, () => {
  const frontends: Frontend[] = [];
  const clients: BrokerConnection[] = [];
  const start = async (options: Partial<FrontendOptions> & Pick<FrontendOptions, "handle">) => {
    const frontend = await startFrontend({ executable: FRONTEND_EXECUTABLE, pipe: pipeName(), ...options });
    frontends.push(frontend);
    return frontend;
  };
  const connect = async (frontend: Frontend, serverSid = ownSid()) => {
    const client = await connectBroker(frontend.pipe, serverSid);
    clients.push(client);
    return client;
  };
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(frontends.splice(0).map((frontend) => frontend.close()));
  });

  it("relays a request to the handler and its response back to the client", async () => {
    const frontend = await start({ handle: async (frame) => text(`echo:${frame.toString("utf8")}`) });
    const client = await connect(frontend);
    expect((await client.request(text("ping"))).toString("utf8")).toBe("echo:ping");
    expect((await client.request(text("again"))).toString("utf8")).toBe("echo:again");
  });

  it("tells the handler which Windows account is calling", async () => {
    const seen: (Principal | null)[] = [];
    const frontend = await start({
      handle: async (_frame, principal) => {
        seen.push(principal);
        return text("{}");
      },
    });
    await (await connect(frontend)).request(text("{}"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sid: ownSid(), pid: process.pid });
  });

  it("refuses to talk to a pipe owned by another account", async () => {
    let calls = 0;
    const frontend = await start({
      handle: async () => {
        calls += 1;
        return text("{}");
      },
    });
    await expect(connectBroker(frontend.pipe, "S-1-5-18")).rejects.toThrow(/owned by S-1-5-21-[\d-]+, not S-1-5-18/);
    expect(calls).toBe(0);
  });

  it("closes only the connection whose handler failed", async () => {
    const errors: unknown[] = [];
    let first = true;
    const frontend = await start({
      onError: (error) => errors.push(error),
      handle: async () => {
        if (first) {
          first = false;
          throw new Error("handler bug");
        }
        return text("ok");
      },
    });
    const failing = await connect(frontend);
    const healthy = await connect(frontend);
    await expect(failing.request(text("{}"))).rejects.toThrow(/closed/);
    expect((await healthy.request(text("{}"))).toString("utf8")).toBe("ok");
    expect(errors).toEqual([new Error("handler bug")]);
  });

  it("cancels a pending request when the client closes", async () => {
    const frontend = await start({ handle: () => new Promise<Uint8Array>(() => undefined) });
    const client = await connect(frontend);
    const pending = client.request(text("{}"));
    await client.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("stops serving once closed", async () => {
    const frontend = await start({ handle: async () => text("{}") });
    await frontend.close();
    await expect(connectBroker(frontend.pipe, ownSid())).rejects.toThrow(/CreateFileW failed with Windows error 2\b/);
  });

  it("reports why the sidecar could not start", async () => {
    const frontend = await start({ handle: async () => text("{}") });
    await expect(startFrontend({ executable: FRONTEND_EXECUTABLE, pipe: frontend.pipe, handle: async () => text("{}") })).rejects.toThrow(
      /cannot create .*orynq-broker-test/,
    );
  });
});
