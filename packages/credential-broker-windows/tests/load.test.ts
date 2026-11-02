import { describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("koffi", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, property) => () => {
        calls.push(String(property));
        return {};
      },
    },
  ),
}));

describe("package entry", () => {
  it("binds no native code until a function is called", async () => {
    const entry = await import("../src/index.js");
    expect(Object.keys(entry).sort()).toEqual(["connectBroker", "deleteSealingKey", "sealSecret", "startFrontend", "unsealSecret"]);
    expect(calls).toEqual([]);
  });
});
