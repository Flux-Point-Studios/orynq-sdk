#!/usr/bin/env bash
# Demo 1 orchestrator.
#
# Submits one signed observation through the live preprod pipeline and
# blocks until both Materios L2 and Cardano L1 anchor transactions are
# observable through the gateway lookup endpoint.
#
# Output: a single line of JSON on stdout; non-zero exit on failure.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [[ -z "${OBSERVE_API_KEY:-}" ]]; then
  echo "error: OBSERVE_API_KEY is required" >&2
  exit 1
fi
if [[ -z "${OBSERVER_WALLET_JSON:-}" ]]; then
  echo "error: OBSERVER_WALLET_JSON is required (path to observer keyfile)" >&2
  exit 1
fi

cd "$ROOT"

# Install the SDK in editable mode the first time we see it.
if ! python -c "import orynq_observe" 2>/dev/null; then
  pip install -q -e "$ROOT/packages/orynq-observe"
fi

OUT="$HERE/result.json"
python "$HERE/submit.py" | tee "$OUT"

# Cexplorer / Cardanoscan URLs for the operator.
TX="$(python -c "import json; print(json.load(open('$OUT'))['cardano_anchor_tx'] or '')")"
if [[ -n "$TX" ]]; then
  echo ""
  echo "Cardano preprod tx:  $TX"
  echo "  Cexplorer:         https://preprod.cexplorer.io/tx/$TX"
  echo "  Cardanoscan:       https://preprod.cardanoscan.io/transaction/$TX"
fi
