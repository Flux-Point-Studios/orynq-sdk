# @fluxpointstudios/orynq-mcp

MCP server for Orynq SDK — process tracing, Cardano anchoring, and verification tools.

Exposes 10 high-level MCP tools for the full trace-to-anchor lifecycle:
create traces, add spans/events, finalize, prepare Cardano anchors, verify on-chain, and estimate costs.

## Quick start

```bash
# From monorepo root
pnpm install
pnpm --filter @fluxpointstudios/orynq-mcp build

# Run via stdio (for Claude Desktop / Claude Code)
node packages/orynq-mcp/dist/index.js
```

### Claude Desktop config

```json
{
  "mcpServers": {
    "orynq": {
      "command": "node",
      "args": ["/path/to/orynq-sdk/packages/orynq-mcp/dist/index.js"],
      "env": {
        "CARDANO_NETWORK": "preprod",
        "BLOCKFROST_PROJECT_ID": "preprodXXXXXX"
      }
    }
  }
}
```

## Configuration

| Env var | Required | Default | Description |
|---------|----------|---------|-------------|
| `CARDANO_NETWORK` | No | `preprod` | `mainnet`, `preprod`, or `preview` |
| `BLOCKFROST_PROJECT_ID` | No | — | Blockfrost API key (enables `verify_cardano_anchor`) |
| `KOIOS_NETWORK` | No | — | Koios fallback (if no Blockfrost key) |
| `CARDANO_SIGNER_KEY` | No | — | Enables `anchor_cardano_submit` |

## Tools (10)

### Trace lifecycle

| Tool | Description | Risk |
|------|-------------|------|
| `trace_create` | Create a new trace run for an agent | Safe |
| `trace_add_span` | Add a span to group related events | Safe |
| `trace_append_events` | Append events (command, output, decision, etc.) to a span | Safe |
| `trace_close_span` | Close an open span | Safe |
| `trace_finalize` | Finalize trace into immutable bundle with root hash | Safe |
| `trace_summary` | Read-only summary of trace state | Safe |

### Cardano anchoring

| Tool | Description | Risk |
|------|-------------|------|
| `anchor_cardano_prepare` | Prepare anchor metadata from finalized trace | Safe |
| `anchor_cardano_submit` | Submit anchor tx (v1: outputs CLI instructions) | HIGH |

### Verification & cost

| Tool | Description | Risk |
|------|-------------|------|
| `verify_cardano_anchor` | Verify on-chain anchor by tx hash | Safe |
| `estimate_cost` | Estimate ADA fee for anchoring | Safe |

## Safety model

- All trace tools are safe — they only modify in-memory state
- `anchor_cardano_prepare` computes hashes but never signs or submits
- `anchor_cardano_submit` requires `confirm: true` and `CARDANO_SIGNER_KEY`; in v1 it returns serialized metadata for manual CLI submission
- `verify_cardano_anchor` and `estimate_cost` are read-only

## Architecture

```
src/
├── index.ts        # CLI entrypoint (stdio transport)
├── server.ts       # McpServer factory
├── config.ts       # Env var loading
├── store.ts        # In-memory TraceStore (Map-backed)
├── errors.ts       # MCP result helpers (toolSuccess/toolError/safeTool)
└── tools/
    ├── index.ts    # registerAllTools orchestrator
    └── *.ts        # Individual tool registrations
```

## License

MIT
