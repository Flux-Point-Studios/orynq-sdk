#!/usr/bin/env bash
# Run all five demos and emit a single JSON summary to stdout.
#
# Demos 2, 4 (hermetic), and 5 (with Blockfrost) always run when their
# secrets are present. Demos 1 and 3 require OBSERVE_API_KEY +
# OBSERVER_WALLET_JSON and consume a sponsored preprod tADA each.
#
# Output: writes per-demo JSON files into each demo dir, then
# assembles them into ./run-all-summary.json (also printed to stdout).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if ! python -c "import orynq_observe" 2>/dev/null; then
  pip install -q -e "$ROOT/packages/orynq-observe"
fi
if ! python -c "import pytest" 2>/dev/null; then
  pip install -q pytest
fi

# --- Demo 1 ---
if [[ -n "${OBSERVE_API_KEY:-}" && -n "${OBSERVER_WALLET_JSON:-}" ]]; then
  echo "running demo 1..." >&2
  "$HERE/01-pipeline/run.sh" || true
fi

# --- Demo 2 (hermetic) ---
echo "running demo 2 (hermetic)..." >&2
pytest -q "$HERE/02-schema-fidelity/test_roundtrip.py" \
  > "$HERE/02-schema-fidelity/pytest.log" 2>&1 && DEMO2=PASS || DEMO2=FAIL

# --- Demo 3 ---
if [[ -n "${OBSERVE_API_KEY:-}" && -n "${OBSERVER_WALLET_JSON:-}" && -n "${BLOCKFROST_PROJECT_ID_PREPROD:-}" ]]; then
  echo "running demo 3..." >&2
  "$HERE/03-suppression-resistance/run.sh" || true
fi

# --- Demo 4 ---
echo "running demo 4 (hermetic suite + live verify if demo 1 produced output)..." >&2
pytest -q "$HERE/04-independent-verify/test_verify.py" \
  > "$HERE/04-independent-verify/pytest.log" 2>&1 && DEMO4_HERMETIC=PASS || DEMO4_HERMETIC=FAIL

if [[ -f "$HERE/01-pipeline/result.json" && -n "${BLOCKFROST_PROJECT_ID_PREPROD:-}" ]]; then
  CH="$(python -c "import json; print(json.load(open('$HERE/01-pipeline/result.json')).get('content_hash',''))")"
  if [[ -n "$CH" ]]; then
    python "$HERE/04-independent-verify/verify.py" --content-hash "$CH" \
      > "$HERE/04-independent-verify/result.json" 2>&1 || true
  fi
fi

# --- Demo 5 ---
if [[ -n "${BLOCKFROST_PROJECT_ID_PREPROD:-}" || -n "${BLOCKFROST_PROJECT_ID_MAINNET:-}" ]]; then
  echo "running demo 5..." >&2
  python "$HERE/05-cost/compute.py" > "$HERE/05-cost/result.json" 2>&1 || true
fi

# --- Assemble summary ---
python - "$HERE" "$DEMO2" "$DEMO4_HERMETIC" <<'PYEOF'
import json
import os
import sys

here, demo2, demo4_hermetic = sys.argv[1], sys.argv[2], sys.argv[3]

def load(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        return {"error": str(e)[:200]}

summary = {
    "01_pipeline":
        load(os.path.join(here, "01-pipeline", "result.json"))
        if os.path.exists(os.path.join(here, "01-pipeline", "result.json"))
        else {"skipped": "missing OBSERVE_API_KEY or OBSERVER_WALLET_JSON"},
    "02_schema_fidelity":
        {"status": demo2, "byte_identical": demo2 == "PASS"},
    "03_suppression_resistance":
        load(os.path.join(here, "03-suppression-resistance", "removal-attempts.json"))
        if os.path.exists(os.path.join(here, "03-suppression-resistance", "removal-attempts.json"))
        else {"skipped": "missing secrets"},
    "04_independent_verify":
        load(os.path.join(here, "04-independent-verify", "result.json"))
        if os.path.exists(os.path.join(here, "04-independent-verify", "result.json"))
        else {"hermetic_suite": demo4_hermetic, "live_verify": "skipped"},
    "05_cost":
        load(os.path.join(here, "05-cost", "result.json"))
        if os.path.exists(os.path.join(here, "05-cost", "result.json"))
        else {"skipped": "missing BLOCKFROST_PROJECT_ID_*"},
}
with open(os.path.join(here, "run-all-summary.json"), "w", encoding="utf-8") as f:
    json.dump(summary, f, indent=2, default=str)
print(json.dumps(summary, indent=2, default=str))
PYEOF
