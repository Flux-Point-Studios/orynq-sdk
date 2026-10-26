// Stream framing for the interactive tools. Logs retain the original chunks; only the
// current summary and unfinished progress line live in memory.
export const MAX_SUMMARY_BUFFER = 64 * 1024;
const PROMPT = /Type exactly "(DEPLOY|ANCHOR) ([0-9a-f]{16})"/;

export interface PromptSegment {
  verb: "DEPLOY" | "ANCHOR";
  token: string;
  summary: string;
  discardedSummary: boolean;
}

export class PromptSegments {
  private pending = "";
  private discardedSummary = false;
  get bufferedLength(): number { return this.pending.length; }

  push(text: string): PromptSegment[] {
    this.pending += text.replaceAll("\r", "");
    const out: PromptSegment[] = [];
    for (let match; (match = PROMPT.exec(this.pending));) {
      out.push({ verb: match[1] as PromptSegment["verb"], token: match[2]!, summary: this.pending.slice(0, match.index), discardedSummary: this.discardedSummary });
      this.pending = this.pending.slice(match.index + match[0].length);
      this.discardedSummary = false;
    }
    if (this.pending.length > MAX_SUMMARY_BUFFER) {
      const cut = this.pending.length - MAX_SUMMARY_BUFFER;
      // Include a short overlap so a summary label split at the cut is still noticed.
      this.discardedSummary ||= /(?:^|\n)(?:network|journal) +/.test(this.pending.slice(0, cut + 64));
      this.pending = this.pending.slice(cut);
    }
    return out;
  }
}

const COMMON = ["network", "runtime", "fee (declared)", "DUST balance", "paid from", "valid until", "final bytes"];
const DEPLOY = ["contract address", "deploy tx hash", "anchor", "anchor_hiding", "authority"];
const ANCHOR = ["label", "kind", "registry", "commitment", "author key", "anchor tx hash"];
const ALLOWED = new Set([...COMMON, ...DEPLOY, ...ANCHOR, "journal", "root hash", "manifest hash", "merkle root", "attribute", "members", "materios genesis"]);
const FIELDS = [...ALLOWED].sort((a, b) => b.length - a.length);
const PROOF = ["label", "contract", "code hash", "initial state", "authority", "proof tx hash"];
const PROOF_FIELDS = [...COMMON, ...PROOF, "statement"].sort((a, b) => b.length - a.length);

export function summaryBlock(segment: PromptSegment, action?: "deploy" | "anchors" | "proofs"): { summary: string; problem?: string } {
  const refuse = (problem: string) => ({ summary: "", problem });
  if (segment.discardedSummary) return refuse("the confirmation summary exceeded its bounded buffer");
  const lines = segment.summary.split("\n");
  const starts = lines.flatMap((line, i) => /^network +/.test(line) ? [i] : []);
  if (starts.length !== 1) return refuse("a prompt must follow exactly one complete summary block");
  let start = starts[0]!;
  if (start > 0 && /^journal +/.test(lines[start - 1]!)) start--;
  const block = lines.slice(start).filter((line) => line.trim().length > 0);
  const found = new Set<string>();
  for (const line of block) {
    const field = (action === "proofs" ? PROOF_FIELDS : FIELDS).find((name) => line.startsWith(`${name} `) && line.slice(name.length).trim().length > 0);
    if (!field || found.has(field) || /[\x00-\x1f\x7f]/.test(line)) return refuse("a prompt must follow exactly one unambiguous summary block");
    found.add(field);
  }
  for (const field of [...COMMON, ...(action === "proofs" ? PROOF : segment.verb === "DEPLOY" ? DEPLOY : ANCHOR)]) {
    if (!found.has(field)) return refuse(`the confirmation summary lacks ${field}`);
  }
  return { summary: block.join("\n") };
}

export class ProgressLines {
  private pending = "";
  push(text: string): string | undefined {
    const lines = (this.pending + text.replaceAll("\r", "")).split("\n");
    this.pending = lines.pop()!.slice(-4096);
    return lines.map((line) => line.trim()).filter(Boolean).at(-1)?.slice(-4096);
  }
  finish(): string | undefined {
    const line = this.pending.trim();
    this.pending = "";
    return line || undefined;
  }
}
