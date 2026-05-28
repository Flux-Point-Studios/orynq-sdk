#!/usr/bin/env bash
# Demo 3 orchestrator.
#
# Two phases:
#   Phase 1 (synthetic.py)        — publish a synthetic suppression test
#                                   observation through the live pipeline.
#   Phase 2 (attempt_removal.py)  — try to remove it through every channel
#                                   FPS controls. Pass iff removal fails
#                                   for ALL channels.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [[ -z "${OBSERVE_API_KEY:-}" ]]; then
  echo "error: OBSERVE_API_KEY is required" >&2; exit 1
fi
if [[ -z "${OBSERVER_WALLET_JSON:-}" ]]; then
  echo "error: OBSERVER_WALLET_JSON is required" >&2; exit 1
fi
if [[ -z "${BLOCKFROST_PROJECT_ID_PREPROD:-}" ]]; then
  echo "error: BLOCKFROST_PROJECT_ID_PREPROD is required" >&2; exit 1
fi

cd "$ROOT"
if ! python -c "import orynq_observe" 2>/dev/null; then
  pip install -q -e "$ROOT/packages/orynq-observe"
fi

echo "=== phase 1: publishing synthetic suppression observation ==="
python "$HERE/synthetic.py"

echo ""
echo "=== phase 2: attempting removal through every FPS channel ==="
python "$HERE/attempt_removal.py"
