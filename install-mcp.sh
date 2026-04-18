#!/usr/bin/env bash
# Orynq MCP installer for Claude Code.
#
# Registers the `orynq` MCP server (11 tools for Materios + Cardano L1 anchoring)
# with Claude Code on this machine.
#
# Basic usage (signs as //Alice, preprod):
#   curl -sSL https://raw.githubusercontent.com/Flux-Point-Studios/orynq-sdk/main/install-mcp.sh | bash
#
# Custom signer + endpoints:
#   SIGNER_URI='your twelve word mnemonic' \
#   RPC_URL=wss://materios.fluxpointstudios.com/preprod-rpc \
#   curl -sSL https://raw.githubusercontent.com/Flux-Point-Studios/orynq-sdk/main/install-mcp.sh | bash

set -euo pipefail
BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; CLR=$'\e[0m'
say()  { echo "${GREEN}==>${CLR} $*"; }
warn() { echo "${YELLOW}!!${CLR}  $*" >&2; }
die()  { echo "${RED}xx${CLR} $*" >&2; exit 1; }

# ---- config (override via env) -----------------------------------------------
ORYNQ_DIR="${ORYNQ_DIR:-$HOME/orynq-sdk}"
SIGNER_URI="${SIGNER_URI:-//Alice}"
RPC_URL="${RPC_URL:-wss://materios.fluxpointstudios.com/preprod-rpc}"
BLOBS_URL="${BLOBS_URL:-https://materios.fluxpointstudios.com/preprod-blobs}"
NETWORK="${NETWORK:-preprod}"
REF="${REF:-main}"

say "Orynq MCP installer"
echo "    dir:      $ORYNQ_DIR"
echo "    ref:      $REF"
echo "    rpc:      $RPC_URL"
echo "    network:  $NETWORK"
# redact mnemonic — just show first word and length
first_word="$(echo "$SIGNER_URI" | awk '{print $1}')"
word_count="$(echo "$SIGNER_URI" | wc -w | tr -d ' ')"
if [ "$word_count" -ge 12 ]; then
  echo "    signer:   ${first_word}... (${word_count} words)"
else
  echo "    signer:   $SIGNER_URI"
fi

# ---- prereqs ------------------------------------------------------------------
command -v git    >/dev/null || die "git is required"
command -v node   >/dev/null || die "node >= 20 required; install via nvm: https://nvm.sh"
command -v pnpm   >/dev/null || { say "Installing pnpm..."; npm i -g pnpm; }
command -v claude >/dev/null || die "claude CLI not found; install Claude Code first: https://claude.ai/code"

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (got $(node -v))"

# ---- clone/update -------------------------------------------------------------
if [ -d "$ORYNQ_DIR/.git" ]; then
  say "Updating clone at $ORYNQ_DIR"
  git -C "$ORYNQ_DIR" fetch origin "$REF"
  git -C "$ORYNQ_DIR" checkout "$REF"
  git -C "$ORYNQ_DIR" pull --ff-only origin "$REF"
else
  say "Cloning orynq-sdk -> $ORYNQ_DIR"
  git clone --branch "$REF" --single-branch https://github.com/Flux-Point-Studios/orynq-sdk "$ORYNQ_DIR"
fi

# ---- build --------------------------------------------------------------------
say "Building orynq-mcp (first run ~2 min)..."
(cd "$ORYNQ_DIR" && pnpm install --filter '@fluxpointstudios/orynq-mcp...' 2>&1 | tail -3)
(cd "$ORYNQ_DIR" && pnpm --filter '@fluxpointstudios/orynq-mcp...' build 2>&1 | tail -5)

MCP_ENTRY="$ORYNQ_DIR/packages/orynq-mcp/dist/index.js"
[ -f "$MCP_ENTRY" ] || die "MCP entry not built at $MCP_ENTRY — check build output above"
say "Built: $MCP_ENTRY"

# ---- register with Claude Code -----------------------------------------------
say "Registering 'orynq' MCP with Claude Code (user scope)..."
claude mcp remove orynq --scope user >/dev/null 2>&1 || true
claude mcp add orynq --scope user \
  --env CARDANO_NETWORK="$NETWORK" \
  --env MATERIOS_RPC_URL="$RPC_URL" \
  --env MATERIOS_SIGNER_URI="$SIGNER_URI" \
  --env MATERIOS_BLOB_GATEWAY_URL="$BLOBS_URL" \
  -- node "$MCP_ENTRY"

# ---- next steps ---------------------------------------------------------------
cat <<EOF

${BOLD}Done.${CLR} Start a NEW Claude Code session; ${BOLD}/mcp${CLR} should list 'orynq' with 11 tools.

${BOLD}Tool surface:${CLR}
   trace_create, trace_add_span, trace_append_events, trace_close_span,
   trace_finalize, trace_summary, anchor_materios_submit, anchor_cardano_prepare,
   anchor_cardano_submit, verify_cardano_anchor, estimate_cost

${BOLD}Fund your signer${CLR} (skip if using //Alice — it's pre-funded):
   If Claude Code complains about 'Inability to pay some fees', derive your SS58
   address from SIGNER_URI (any wallet that supports sr25519) and request a drip:
     curl -X POST $BLOBS_URL/faucet/drip \\
       -H 'Content-Type: application/json' \\
       -d '{"address":"<your_ss58_42_address>"}'
   One drip per address, ever. MOTRA accumulates over the next few blocks.

${BOLD}Uninstall:${CLR}
   claude mcp remove orynq --scope user
EOF
