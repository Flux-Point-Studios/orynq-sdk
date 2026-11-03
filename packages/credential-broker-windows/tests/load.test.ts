import { describe, expect, it, vi } from "vitest";

const { calls, loads } = vi.hoisted(() => ({ calls: [] as string[], loads: [] as string[] }));

vi.mock("koffi", () => {
  loads.push("koffi");
  return {
    default: new Proxy(
      {},
      {
        get: (_target, property) => () => {
          calls.push(String(property));
          return {};
        },
      },
    ),
  };
});

describe("package entries", () => {
  it("load koffi only from the root entry, and bind no native code until a function is called", async () => {
    const frontend = await import("../src/frontend.js");
    expect(Object.keys(frontend)).toEqual(["spawnPipeFrontend"]);
    expect(loads).toEqual([]);
    const root = await import("../src/index.js");
    expect(Object.keys(root).sort()).toEqual(["connectBroker", "deleteSealingKey", "sealSecret", "spawnPipeFrontend", "unsealSecret"]);
    expect(loads).toEqual(["koffi"]);
    expect(calls).toEqual([]);
  });
});
