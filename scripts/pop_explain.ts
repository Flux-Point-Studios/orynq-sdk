import fs from "node:fs/promises";
import path from "node:path";

type Manifest = {
  runId: string;
  agentId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  totalSpans: number;
  totalEvents: number;
  rootHash: string;
  manifestHash: string;
  merkleRoot: string;
  chunks: Array<{ index: number; hash: string; spanIds: string[] }>;
};

type TraceEvent = {
  id: string;
  kind: string;
  seq: number;
  timestamp: string;
  visibility: string;
  // kind-specific fields
  command?: string;
  args?: string[];
  cwd?: string;
  stream?: string;
  content?: string;
  observation?: string;
  data?: Record<string, unknown>;
  error?: string;
  eventType?: string;
};

type TraceSpan = {
  id: string;
  spanSeq: number;
  name: string;
  status: string;
  visibility: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  eventIds: string[];
  metadata?: Record<string, unknown>;
};

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf-8"));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

function truncate(s: string, max = 120): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("Usage: pnpm tsx scripts/pop_explain.ts <runDir>");
    console.error("Example: pnpm tsx scripts/pop_explain.ts .poi-trace/claude/runs/abc123");
    process.exit(1);
  }

  const manifestPath = path.join(runDir, "manifest.json");

  let manifest: Manifest;
  try {
    manifest = await readJson<Manifest>(manifestPath);
  } catch (e) {
    console.error(`Could not read manifest at: ${manifestPath}`);
    process.exit(1);
  }

  // load all chunks
  const chunksDir = path.join(runDir, "chunks");
  let chunkFiles: string[] = [];
  try {
    chunkFiles = await fs.readdir(chunksDir);
  } catch {
    // No chunks directory - data might be in manifest.publicView
  }

  const spans: TraceSpan[] = [];
  const events: TraceEvent[] = [];

  for (const f of chunkFiles) {
    if (!f.endsWith(".json")) continue;
    const chunk = await readJson<{ spans?: TraceSpan[]; events?: TraceEvent[] }>(
      path.join(chunksDir, f)
    );
    spans.push(...(chunk.spans || []));
    events.push(...(chunk.events || []));
  }

  spans.sort((a, b) => (a.spanSeq ?? 0) - (b.spanSeq ?? 0));
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const eventsById = new Map(events.map((e) => [e.id, e]));

  console.log("\n" + "═".repeat(60));
  console.log(" PROOF-OF-PROCESS REPORT (Plain English)");
  console.log("═".repeat(60) + "\n");

  console.log(`📋 Run ID:    ${manifest.runId}`);
  console.log(`🤖 Agent:     ${manifest.agentId}`);
  console.log(`⏱️  Duration:  ${formatDuration(manifest.durationMs)}`);
  console.log(`📅 Started:   ${manifest.startedAt}`);
  console.log(`📅 Ended:     ${manifest.endedAt}`);
  console.log(`📊 Counts:    ${manifest.totalSpans} spans, ${manifest.totalEvents} events`);
  console.log("");
  console.log(`🔐 Cryptographic Commitments:`);
  console.log(`   rootHash:     ${manifest.rootHash}`);
  console.log(`   manifestHash: ${manifest.manifestHash}`);
  console.log(`   merkleRoot:   ${manifest.merkleRoot}`);
  console.log("\n" + "─".repeat(60) + "\n");

  // Count tools by type
  const toolCounts = new Map<string, number>();
  const subagentCounts = new Map<string, number>();

  for (const s of spans) {
    if (s.name.startsWith("Tool:")) {
      const tool = s.name.replace("Tool:", "");
      toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
    } else if (s.name.startsWith("Subagent:")) {
      const type = s.name.replace("Subagent:", "");
      subagentCounts.set(type, (subagentCounts.get(type) || 0) + 1);
    }
  }

  if (toolCounts.size > 0) {
    console.log("🔧 TOOL USAGE SUMMARY:");
    for (const [tool, count] of [...toolCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${tool}: ${count}x`);
    }
    console.log("");
  }

  if (subagentCounts.size > 0) {
    console.log("🤖 SUBAGENT ACTIVITY:");
    for (const [type, count] of [...subagentCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${type}: ${count}x`);
    }
    console.log("");
  }

  console.log("─".repeat(60));
  console.log(" TIMELINE (chronological)");
  console.log("─".repeat(60) + "\n");

  for (const s of spans) {
    const name = s.name || "UnnamedSpan";
    const status = s.status || "unknown";
    const duration = s.durationMs ? ` (${formatDuration(s.durationMs)})` : "";
    const statusIcon = status === "completed" ? "✓" : status === "failed" ? "✗" : "○";

    console.log(`[${statusIcon}] ${name}${duration}`);

    const spanEvents = (s.eventIds || [])
      .map((id: string) => eventsById.get(id))
      .filter((e): e is TraceEvent => Boolean(e))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    for (const e of spanEvents) {
      if (e.kind === "command") {
        const cmd = e.command || "";
        const args = (e.args || []).join(" ");
        console.log(`    ▸ Command: ${truncate(cmd + (args ? " " + args : ""), 100)}`);
      } else if (e.kind === "output") {
        const preview = String(e.content || "")
          .replace(/\s+/g, " ")
          .trim();
        if (preview) {
          console.log(`    ◦ Output (${e.stream}): ${truncate(preview, 80)}`);
        }
      } else if (e.kind === "observation") {
        const obs = e.observation || "";
        if (obs === "bash_result" && e.data) {
          const code = (e.data as { exitCode?: number }).exitCode;
          console.log(`    ◦ Exit code: ${code}`);
        } else if (obs === "session_start" || obs === "session_end") {
          // Skip these in per-span output
        } else if (obs === "subagent_start") {
          const data = e.data as { agent_type?: string };
          console.log(`    ◦ Subagent started: ${data?.agent_type || "unknown"}`);
        } else if (obs === "subagent_stop") {
          console.log(`    ◦ Subagent completed`);
        } else {
          console.log(`    ◦ ${obs}: ${e.data ? JSON.stringify(e.data).slice(0, 60) : ""}`);
        }
      } else if (e.kind === "error") {
        console.log(`    ✗ Error: ${truncate(e.error || "", 80)}`);
      } else if (e.kind === "custom") {
        const eventType = e.eventType || "custom";
        if (eventType === "tool_intent" && e.data) {
          const tool = (e.data as { tool?: string }).tool;
          const toolInput = (e.data as { tool_input?: Record<string, unknown> }).tool_input;
          if (tool === "Task" && toolInput) {
            console.log(`    ▸ Spawning subagent: ${(toolInput as { subagent_type?: string }).subagent_type || "unknown"}`);
          } else if (tool === "Read" && toolInput) {
            console.log(`    ▸ Reading: ${(toolInput as { file_path?: string }).file_path || "unknown"}`);
          } else if (tool === "Write" && toolInput) {
            console.log(`    ▸ Writing: ${(toolInput as { file_path?: string }).file_path || "unknown"}`);
          } else if (tool === "Edit" && toolInput) {
            console.log(`    ▸ Editing: ${(toolInput as { file_path?: string }).file_path || "unknown"}`);
          } else if (tool === "Glob" && toolInput) {
            console.log(`    ▸ Globbing: ${(toolInput as { pattern?: string }).pattern || "unknown"}`);
          } else if (tool === "Grep" && toolInput) {
            console.log(`    ▸ Searching: ${(toolInput as { pattern?: string }).pattern || "unknown"}`);
          } else {
            console.log(`    ▸ Tool: ${tool}`);
          }
        } else if (eventType === "tool_success") {
          // Skip success markers in detailed view
        } else if (eventType === "tool_failure") {
          console.log(`    ✗ Tool failed`);
        }
      }
    }

    console.log("");
  }

  console.log("═".repeat(60));
  console.log(" END OF REPORT");
  console.log("═".repeat(60) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
