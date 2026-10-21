import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { audit, ensureRunnerRoot, readAudit, runnerFiles } from "../state.js";
import { stateRoot } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("the audit log", () => {
  // Node's appendFileSync opens, writes, syncs and closes through the fs module object, and syncs
  // only when asked to (its UTF-8 fast path, taken when an encoding is named, never syncs).
  it("syncs each line to disk before closing the file", () => {
    const { paths } = stateRoot();
    ensureRunnerRoot(paths.root);
    const file = runnerFiles(paths.root).audit;
    const spies = { open: vi.spyOn(fs, "openSync"), write: vi.spyOn(fs, "writeSync"), sync: vi.spyOn(fs, "fsyncSync"), close: vi.spyOn(fs, "closeSync") };
    for (const attempt of [1, 2]) audit(paths.root, { intent: "bf35fa0c", event: "run-start", attempt });
    // What happened to each descriptor, in call order.
    const calls = Object.entries(spies)
      .flatMap(([kind, spy]) => spy.mock.calls.map((args, i) => ({ kind, order: spy.mock.invocationCallOrder[i]!, fd: kind === "open" ? spy.mock.results[i]!.value : args[0], path: args[0] })))
      .sort((a, b) => a.order - b.order);
    const opens = calls.filter((c) => c.kind === "open" && c.path === file);
    expect(opens).toHaveLength(2);
    for (const open of opens) {
      const after = calls.filter((c) => c.order > open.order && c.kind !== "open" && c.fd === open.fd).map((c) => c.kind);
      expect(after.slice(0, after.indexOf("close") + 1)).toEqual(["write", "sync", "close"]);
    }
    expect(readAudit(paths.root).map((e) => e.attempt)).toEqual([1, 2]);
  });
});
