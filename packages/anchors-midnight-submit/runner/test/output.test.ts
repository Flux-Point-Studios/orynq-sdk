import { describe, expect, it } from "vitest";
import { MAX_SUMMARY_BUFFER, ProgressLines, PromptSegments, summaryBlock } from "../output.js";

const summary = [
  "network          mainnet (Midnight Mainnet)",
  "runtime          1000300, ledger 8.1.1",
  "contract address aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "deploy tx hash   bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "anchor           vk sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "anchor_hiding    vk sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "authority        committee [] (0 members), threshold 1, counter 0",
  "fee (declared)   0.01 DUST, all of it burned",
  "DUST balance     20 DUST at mn_dust1fixture",
  "paid from        mn_addr1fixture",
  "valid until      2026-10-26T19:00:00.000Z",
  "final bytes      8000",
].join("\n");
const prompt = '\nType exactly "DEPLOY bbbbbbbbbbbbbbbb" to confirm these bytes: ';

describe("bounded tool output framing", () => {
  it("frames proof releases only under their explicit action without weakening anchor framing", () => {
    const proof = [
      "network mainnet", "runtime 1000300", "label proveCapability", `contract ${"ab".repeat(32)}`,
      `code hash ${"cd".repeat(32)}`, `initial state ${"ef".repeat(32)}`, "authority empty committee, threshold 1, counter 0",
      "statement {}", "fee (declared) 0.01 DUST", "DUST balance 20 DUST", "paid from mn_addr1fixture",
      "valid until 2026-10-26T19:00:00.000Z", "final bytes 8000", `proof tx hash ${"bb".repeat(32)}`,
    ].join("\n");
    const segment = (body: string) => new PromptSegments().push(`${body}\nType exactly "ANCHOR bbbbbbbbbbbbbbbb"`)[0]!;
    expect(summaryBlock(segment(proof), "proofs")).toEqual({ summary: proof });
    expect(summaryBlock(segment(proof)).problem).toBeDefined();
    expect(summaryBlock(segment(`${proof}\ncode hash duplicate`), "proofs").problem).toBeDefined();
    expect(summaryBlock(segment(proof.replace("runtime 1000300\n", "")), "proofs").problem).toMatch(/runtime/);
    expect(summaryBlock(segment(proof.replace("statement {}", "untrusted text\nstatement {}")), "proofs").problem).toBeDefined();
  });
  it("forgets a long progress stream, preserves split prompts, and consumes each summary once", () => {
    const stream = new PromptSegments();
    for (let i = 0; i < 10_000; i++) {
      expect(stream.push(`Syncing ${i}: ${"x".repeat(1024)}\n`)).toEqual([]);
      expect(stream.bufferedLength).toBeLessThanOrEqual(MAX_SUMMARY_BUFFER);
    }
    expect(stream.push(`\n${summary}\nType exact`)).toEqual([]);
    const [event] = stream.push('ly "DEPLOY bbbbbbbbbbbbbbbb"');
    expect(event?.token).toBe("bbbbbbbbbbbbbbbb");
    expect(summaryBlock(event!)).toEqual({ summary });
    expect(stream.push(" to confirm these bytes: ")).toEqual([]);
    const [next] = stream.push(`\n${summary}${prompt}`);
    expect(summaryBlock(next!)).toEqual({ summary });
    expect(stream.bufferedLength).toBeLessThan(100);
  });

  it.each([
    { name: "two summaries", body: `${summary}\n${summary}` },
    { name: "duplicate field", body: `${summary}\npaid from        stranger` },
    { name: "interleaved provider text", body: summary.replace("fee (declared)", "untrusted provider text\nfee (declared)") },
    { name: "missing complete header", body: summary.replace(/^network.*\n/, "") },
  ])("refuses $name before a confirmation decision", ({ body }) => {
    const [event] = new PromptSegments().push(body + prompt);
    expect(summaryBlock(event!).problem).toBeDefined();
  });

  it("refuses a summary whose beginning was discarded rather than trusting its tail", () => {
    const stream = new PromptSegments();
    stream.push(`network          injected\n${"x".repeat(MAX_SUMMARY_BUFFER + 100)}`);
    const [event] = stream.push(`\n${summary}${prompt}`);
    expect(summaryBlock(event!).problem).toMatch(/bounded/);
  });

  it("joins split and multiple progress lines and flushes a final unterminated line", () => {
    const lines = new ProgressLines();
    expect(lines.push("Syncing wal")).toBeUndefined();
    expect(lines.push("let\nfirst\nsecond\ntail")).toBe("second");
    expect(lines.push(" split")).toBeUndefined();
    expect(lines.finish()).toBe("tail split");
    expect(lines.finish()).toBeUndefined();
  });
});
