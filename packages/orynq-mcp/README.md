# @fluxpointstudios/orynq-mcp

MCP server for Orynq SDK — process tracing, Cardano and Materios anchoring, and verification tools.

Exposes 12 high-level MCP tools for the full trace-to-anchor lifecycle:
create traces, add spans/events, finalize, prepare and submit anchors, verify Cardano and Midnight
anchors, and estimate costs.

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
| `MATERIOS_RPC_URL`, `MATERIOS_SIGNER_URI` | No | — | Enable `anchor_materios_submit` (the signer URI is a mnemonic or derivation path) |
| `MATERIOS_BLOB_GATEWAY_URL`, `MATERIOS_BLOB_GATEWAY_API_KEY` | No | Materios preprod gateway | Where `anchor_materios_submit` uploads the bundle |
| `MIDNIGHT_NETWORK` | No | `mainnet` | `mainnet` or `preprod`, for `verify_midnight_anchor` |
| `MIDNIGHT_BLOCKFROST_PROJECT_ID_FILE` | No | — | Path to a file, readable only by its owner, holding a Blockfrost Midnight project id |
| `MIDNIGHT_INDEXER_URL`, `MIDNIGHT_RPC_URL` | No | — | Any Midnight indexer (GraphQL) and node (JSON-RPC), in place of Blockfrost |

## Tools (12)

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

### Materios anchoring

| Tool | Description | Risk |
|------|-------------|------|
| `anchor_materios_submit` | Submit a finalized trace as a Materios receipt, wait for certification and optionally the Cardano checkpoint | HIGH |

### Verification & cost

| Tool | Description | Risk |
|------|-------------|------|
| `verify_cardano_anchor` | Verify on-chain anchor by tx hash | Safe |
| `verify_midnight_anchor` | Verify a Midnight anchor by tx hash: status, assurance, author, matched fields, checks | Safe |
| `estimate_cost` | Estimate ADA fee for anchoring | Safe |

## Safety model

- All trace tools are safe — they only modify in-memory state
- `anchor_cardano_prepare` computes hashes but never signs or submits
- `anchor_cardano_submit` requires `confirm: true` and `CARDANO_SIGNER_KEY`; in v1 it returns serialized metadata for manual CLI submission
- `anchor_materios_submit` is a dry run unless `confirm: true`, an argument the model supplies, not a person's approval; it needs `MATERIOS_RPC_URL` and `MATERIOS_SIGNER_URI`
- `verify_cardano_anchor`, `verify_midnight_anchor` and `estimate_cost` are read-only
- `verify_midnight_anchor` takes a transaction hash and at most one expectation (a bundle's `entry`
  hashes, a kind-1 `commitment` or a kind-2 `attribute`), plus an optional `expectedAuthor`. It
  refuses any other argument, so a model can pass it no key, file or URL; the source comes from
  the server's environment. Its result is the anchors-midnight `verifyReport`: `valid` only at
  `consensus-verified` assurance, with every source's text made printable and cut at 300 characters.
- There is no Midnight anchoring tool. Anchoring spends the user's own DUST with the user's own
  key, and an MCP server cannot tell a person's answer from a client's: a tool argument is the
  model's, and an elicitation reply is whatever the client sends. Anchor with
  `orynq anchor midnight --submit` from `@fluxpointstudios/orynq-sdk-quickstart`, which needs a
  person at a terminal. No tool here ever takes a Flux Point Studios key.

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
