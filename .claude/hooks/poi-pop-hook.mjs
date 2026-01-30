import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve the package from the project root's node_modules or dist
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

// Load .env.local from project root (simple inline parser, no external deps)
function loadEnvFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // File doesn't exist or can't be read - that's fine
  }
}

// Load env files (order: .env.local takes precedence)
loadEnvFile(path.join(projectRoot, ".env.local"));
loadEnvFile(path.join(projectRoot, ".env"));

// Dynamic import from the built packages (use file:// URL for Windows compatibility)
const processTracePath = path.join(projectRoot, "packages/process-trace/dist/index.js");
const processTrace = await import(pathToFileURL(processTracePath).href);
const {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  createManifest,
  getChunkPath,
} = processTrace;

// Import anchors-cardano for on-chain anchoring
const anchorsCardanoPath = path.join(projectRoot, "packages/anchors-cardano/dist/index.js");
const anchorsCardano = await import(pathToFileURL(anchorsCardanoPath).href);
const {
  createAnchorEntryFromBundle,
  buildAnchorMetadata,
  serializeForCbor,
  createBlockfrostProvider,
  verifyAnchor,
} = anchorsCardano;

const POI_METADATA_LABEL = 2222;

// ---------- tiny utils ----------
async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const s = Buffer.concat(chunks).toString("utf-8").trim();
  return s ? JSON.parse(s) : {};
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function loadJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, "utf-8"));
  } catch {
    return fallback;
  }
}

async function saveJson(p, obj) {
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf-8");
}

// naive file lock (good enough for a local run)
async function withLock(lockPath, fn) {
  let fh;
  for (let i = 0; i < 50; i++) {
    try {
      fh = await fs.open(lockPath, "wx");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!fh) throw new Error(`Could not acquire lock: ${lockPath}`);
  try {
    return await fn();
  } finally {
    await fh.close();
    await fs.rm(lockPath, { force: true });
  }
}

function projectDirFrom(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

// ---------- mapping from Claude tool calls → PoP events ----------
function toolSpanName(input) {
  const tn = input.tool_name || "UnknownTool";
  return `Tool:${tn}`;
}

function summarizeToolInput(input) {
  const tn = input.tool_name;
  const ti = input.tool_input || {};
  if (tn === "Bash")
    return {
      command: ti.command,
      description: ti.description,
      timeout: ti.timeout,
    };
  if (tn === "Read")
    return { file_path: ti.file_path, offset: ti.offset, limit: ti.limit };
  if (tn === "Write")
    return { file_path: ti.file_path, bytes: (ti.content || "").length };
  if (tn === "Edit")
    return {
      file_path: ti.file_path,
      old_len: (ti.old_string || "").length,
      new_len: (ti.new_string || "").length,
    };
  if (tn === "Glob") return { pattern: ti.pattern, path: ti.path };
  if (tn === "Grep")
    return { pattern: ti.pattern, path: ti.path, glob: ti.glob };
  if (tn === "Task")
    return {
      subagent_type: ti.subagent_type,
      description: ti.description,
      prompt_preview: (ti.prompt || "").slice(0, 200),
    };
  return ti;
}

function extractBashResult(toolResponse) {
  // Tool response schema can evolve; grab common patterns
  const tr = toolResponse || {};
  const stdout = tr.stdout ?? tr.output ?? tr.result ?? "";
  const stderr = tr.stderr ?? "";
  const exitCode = tr.exitCode ?? tr.exit_code ?? tr.code ?? null;
  return { stdout, stderr, exitCode };
}

// Truncate long strings
function truncStr(s, max = 4000) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + `... [truncated, total ${s.length} chars]`;
}

// ---------- state ----------
function paths(baseDir, sessionId) {
  const root = path.join(baseDir, ".poi-trace", "claude");
  return {
    root,
    stateDir: path.join(root, "state"),
    runsDir: path.join(root, "runs"),
    stateFile: path.join(root, "state", `${sessionId}.json`),
    lockFile: path.join(root, "state", `${sessionId}.lock`),
  };
}

async function main() {
  const input = await readStdinJson();
  const event = input.hook_event_name;
  const sessionId = input.session_id || "unknown-session";

  const baseDir = projectDirFrom(input);
  const P = paths(baseDir, sessionId);

  await ensureDir(P.stateDir);
  await ensureDir(P.runsDir);

  await withLock(P.lockFile, async () => {
    const state = await loadJson(P.stateFile, {
      sessionId,
      run: null,
      pendingToolSpans: {}, // tool_use_id -> spanId
      subagents: {}, // agent_id -> spanId
    });

    // ---------------- SessionStart: create the run ----------------
    if (event === "SessionStart") {
      if (!state.run) {
        const run = await createTrace({ agentId: `claude-code:${sessionId}` });
        // a root span for the overall session
        const rootSpan = addSpan(run, {
          name: "ClaudeSession",
          visibility: "private",
          metadata: {
            transcript_path: input.transcript_path,
            cwd: input.cwd,
          },
        });
        await addEvent(run, rootSpan.id, {
          kind: "observation",
          observation: "session_start",
          data: { transcript_path: input.transcript_path, cwd: input.cwd },
          visibility: "private",
        });
        state.run = run;
        state.rootSpanId = rootSpan.id;
      }
      await saveJson(P.stateFile, state);
      return;
    }

    if (!state.run) {
      // If SessionStart didn't fire for some reason, bootstrap here.
      state.run = await createTrace({ agentId: `claude-code:${sessionId}` });
      state.rootSpanId = addSpan(state.run, {
        name: "ClaudeSession",
        visibility: "private",
      }).id;
    }

    const run = state.run;

    // ---------------- SubagentStart/Stop ----------------
    if (event === "SubagentStart") {
      const agentId = input.agent_id;
      const agentType = input.agent_type;
      const s = addSpan(run, {
        name: `Subagent:${agentType || "Unknown"}`,
        visibility: "private",
        metadata: { agent_id: agentId, agent_type: agentType },
      });
      state.subagents[agentId] = s.id;

      await addEvent(run, s.id, {
        kind: "observation",
        observation: "subagent_start",
        data: { agent_id: agentId, agent_type: agentType },
        visibility: "private",
      });

      await saveJson(P.stateFile, state);
      return;
    }

    if (event === "SubagentStop") {
      const agentId = input.agent_id;
      const spanId = state.subagents[agentId];
      if (spanId) {
        await addEvent(run, spanId, {
          kind: "observation",
          observation: "subagent_stop",
          data: {
            agent_id: agentId,
            agent_transcript_path: input.agent_transcript_path,
          },
          visibility: "private",
        });
        await closeSpan(run, spanId, "completed");
        delete state.subagents[agentId];
      }
      await saveJson(P.stateFile, state);
      return;
    }

    // ---------------- PreToolUse: open a span + record intent ----------------
    if (event === "PreToolUse") {
      const toolUseId = input.tool_use_id;
      const span = addSpan(run, {
        name: toolSpanName(input),
        visibility: "private",
        metadata: { tool_use_id: toolUseId },
      });
      if (toolUseId) state.pendingToolSpans[toolUseId] = span.id;

      // Bash gets a CommandEvent; everything else becomes an observation/custom
      if (input.tool_name === "Bash") {
        const ti = input.tool_input || {};
        await addEvent(run, span.id, {
          kind: "command",
          command: ti.command || "",
          cwd: input.cwd,
          visibility: "public", // command line itself is usually ok; outputs remain private
        });
      } else {
        await addEvent(run, span.id, {
          kind: "custom",
          eventType: "tool_intent",
          data: {
            tool: input.tool_name,
            tool_input: summarizeToolInput(input),
          },
          visibility: "private",
        });
      }

      await saveJson(P.stateFile, state);
      return;
    }

    // ---------------- PostToolUse: record result + close span ----------------
    if (event === "PostToolUse" || event === "PostToolUseFailure") {
      const toolUseId = input.tool_use_id;
      const spanId =
        (toolUseId && state.pendingToolSpans[toolUseId]) || null;
      const useSpanId =
        spanId ||
        addSpan(run, { name: toolSpanName(input), visibility: "private" }).id;

      const resp = input.tool_response || {};
      if (input.tool_name === "Bash") {
        const { stdout, stderr, exitCode } = extractBashResult(resp);

        if (stdout) {
          await addEvent(run, useSpanId, {
            kind: "output",
            stream: "stdout",
            content: truncStr(String(stdout)),
          });
        }
        if (stderr) {
          await addEvent(run, useSpanId, {
            kind: "output",
            stream: "stderr",
            content: truncStr(String(stderr)),
          });
        }

        await addEvent(run, useSpanId, {
          kind: "observation",
          observation: "bash_result",
          data: { exitCode },
          visibility: "public",
        });

        await closeSpan(
          run,
          useSpanId,
          event === "PostToolUse" ? "completed" : "failed"
        );
      } else {
        // For non-Bash tools, truncate any large response content
        let respData = resp;
        if (typeof resp === "string" && resp.length > 4000) {
          respData = truncStr(resp);
        } else if (resp && typeof resp === "object") {
          // Shallow truncate string fields
          respData = {};
          for (const [k, v] of Object.entries(resp)) {
            respData[k] = typeof v === "string" ? truncStr(v) : v;
          }
        }

        await addEvent(run, useSpanId, {
          kind: "custom",
          eventType: event === "PostToolUse" ? "tool_success" : "tool_failure",
          data: { tool: input.tool_name, tool_response: respData },
          visibility: "private",
        });
        await closeSpan(
          run,
          useSpanId,
          event === "PostToolUse" ? "completed" : "failed"
        );
      }

      if (toolUseId) delete state.pendingToolSpans[toolUseId];
      await saveJson(P.stateFile, state);
      return;
    }

    // ---------------- SessionEnd: finalize + write artifact ----------------
    if (event === "SessionEnd") {
      // Close any remaining open subagent spans
      for (const [agentId, spanId] of Object.entries(state.subagents)) {
        await addEvent(run, spanId, {
          kind: "observation",
          observation: "subagent_orphaned",
          data: { agent_id: agentId },
          visibility: "private",
        });
        await closeSpan(run, spanId, "cancelled");
      }

      // Close any remaining open tool spans
      for (const [toolUseId, spanId] of Object.entries(state.pendingToolSpans)) {
        await addEvent(run, spanId, {
          kind: "observation",
          observation: "tool_orphaned",
          data: { tool_use_id: toolUseId },
          visibility: "private",
        });
        await closeSpan(run, spanId, "cancelled");
      }

      await addEvent(run, state.rootSpanId, {
        kind: "observation",
        observation: "session_end",
        data: { reason: input.reason, transcript_path: input.transcript_path },
        visibility: "private",
      });
      await closeSpan(run, state.rootSpanId, "completed");

      const bundle = await finalizeTrace(run);
      const { manifest, chunks } = await createManifest(bundle, {
        chunkSize: 500_000,
      });

      // anchors-cardano requires bundle.manifestHash
      bundle.manifestHash = manifest.manifestHash;

      // write out
      const outDir = path.join(P.runsDir, sessionId);
      await ensureDir(path.join(outDir, "chunks"));
      await fs.writeFile(
        path.join(outDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf-8"
      );
      for (const ch of chunks) {
        await fs.writeFile(
          path.join(outDir, getChunkPath(ch.info)),
          ch.content,
          "utf-8"
        );
      }

      // ----- On-chain anchoring (if credentials available) -----
      const projectId = process.env.BLOCKFROST_PROJECT_ID_MAINNET;
      const mnemonic = process.env.CARDANO_MNEMONIC;
      let anchorResult = null;

      if (projectId && mnemonic) {
        try {
          console.log(`[PoP] Anchoring trace to Cardano mainnet...`);

          // Build anchor metadata (label 2222)
          const entry = createAnchorEntryFromBundle(bundle, {
            agentId: `claude-code:${sessionId}`,
            includeMerkleRoot: true,
          });
          const txMeta = buildAnchorMetadata(entry);
          const cbor = serializeForCbor(txMeta);
          const metadataValue = cbor[POI_METADATA_LABEL] ?? cbor[String(POI_METADATA_LABEL)];

          if (!metadataValue) {
            throw new Error("Failed to extract label 2222 value for attachMetadata()");
          }

          // Dynamic import lucid-cardano (ESM only)
          const { Lucid, Blockfrost } = await import("lucid-cardano");

          const lucid = await Lucid.new(
            new Blockfrost("https://cardano-mainnet.blockfrost.io/api/v0", projectId),
            "Mainnet"
          );
          lucid.selectWalletFromSeed(mnemonic);

          const addr = await lucid.wallet.address();

          // Build and submit transaction
          const tx = await lucid
            .newTx()
            .payToAddress(addr, { lovelace: 2_000_000n })
            .attachMetadata(POI_METADATA_LABEL, metadataValue)
            .complete();

          const signed = await tx.sign().complete();
          const txHash = await signed.submit();

          anchorResult = {
            txHash,
            network: "mainnet",
            label: POI_METADATA_LABEL,
            address: addr,
            rootHash: bundle.rootHash,
            manifestHash: bundle.manifestHash,
            merkleRoot: bundle.merkleRoot,
            timestamp: new Date().toISOString(),
          };

          // Write anchor.json
          await fs.writeFile(
            path.join(outDir, "anchor.json"),
            JSON.stringify(anchorResult, null, 2),
            "utf-8"
          );

          console.log(`[PoP] ✅ Anchored to mainnet: ${txHash}`);
        } catch (anchorErr) {
          console.error(`[PoP] ⚠️ Anchoring failed (trace still saved locally): ${anchorErr?.message || anchorErr}`);
        }
      } else {
        console.log(`[PoP] Skipping on-chain anchor (no BLOCKFROST_PROJECT_ID_MAINNET or CARDANO_MNEMONIC)`);
      }

      // wipe state
      await fs.rm(P.stateFile, { force: true });

      // print summary to transcript
      console.log(`[PoP] wrote trace artifact: ${outDir}`);
      console.log(
        `[PoP] rootHash=${bundle.rootHash} manifestHash=${manifest.manifestHash} merkleRoot=${bundle.merkleRoot}`
      );
      if (anchorResult) {
        console.log(`[PoP] txHash=${anchorResult.txHash} (Cardano mainnet)`);
      }
      return;
    }

    // default: ignore
    await saveJson(P.stateFile, state);
  });
}

main().catch((e) => {
  console.error(`[PoP hook] error: ${e?.stack || e}`);
  process.exit(0); // don't brick Claude Code if recorder fails
});
