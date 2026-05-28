# Demo 5 — Cost transparency

Compute the all-in USD cost per observation, **live**, from current
network fee state. No FPS-published guess; the script reads the fees
from on-chain storage and Blockfrost network parameters at call time.

## Sources

| Source | What we pull | Why |
|---|---|---|
| Materios public RPC | `OrinqReceipts.ReceiptSubmissionFee` | The MATRA fee charged by `submit_receipt_v2` |
| Blockfrost `/network/parameters` | `min_fee_a`, `min_fee_b` (lovelace) | The protocol coefficients used to compute the anchor tx fee |
| CoinGecko `simple/price` | ADA/USD spot | To convert lovelace → USD on mainnet (preprod has no market value) |

The default anchor tx size used in the math is `700` bytes (one input,
one self-output, ~250 bytes of metadata label 8746). Empirical measure
from `services/anchor-worker-materios` recent invocations.

## Run

```bash
export BLOCKFROST_PROJECT_ID_PREPROD=preprodXXXX
export BLOCKFROST_PROJECT_ID_MAINNET=mainnetXXXX   # optional
python e2e-proof/05-cost/compute.py
```

JSON output keys:

```json
{
  "results": {
    "preprod": { ... },
    "mainnet": { ... }
  },
  "markdown": "| Network | Sponsored | ..."
}
```

Or get the Markdown table directly:

```bash
python e2e-proof/05-cost/compute.py --markdown-only
```

## What the table reports

| Network | Sponsored | MATRA fee | Cardano L1 fee | USD/observation |
|---|---|---|---|---|
| preprod | yes | n/a (sponsored) | covered by sponsored anchor-worker (tADA, no market value) | $0.00 |
| mainnet | no | 1.000000 MATRA (current chain state — read live) | min_fee_b + min_fee_a × ~700 bytes ≈ 0.000186 ADA | ADA-USD spot × Cardano lovelace |

For preprod the only paid path is the Cardano L1 anchor tx, and the
gateway operator covers it. For mainnet the observer pays both the
MATRA fee AND the Cardano L1 fee on its own wallet — the gateway no
longer sponsors.

## Weekly refresh CI

`.github/workflows/e2e-proof-cost-refresh.yml` runs this script weekly
(Sundays 00:00 UTC). If either column drifts by more than 10%, the job
opens a PR updating the canonical cost table in the docs.

## Hermetic tests

```bash
pytest e2e-proof/05-cost/test_cost.py -v
```

| # | Property |
|---|---|
| T1 | `expected_cardano_tx_lovelace` matches the protocol formula `min_fee_b + min_fee_a × tx_bytes` |
| T2 | Sponsored networks zero the MATRA fee paid by the observer |
| T3 | `usd_per_observation` is `null` when ADA/USD spot is unavailable OR the network is preprod |
| T4 | Markdown emits the documented one-line-per-network shape |
| T5 | The default `ANCHOR_TX_BYTES` is a positive integer below Cardano's 16 KB tx cap |

## Honesty constraint

* We do NOT publish a single "the cost is $X" number. The cost is a
  function of three live variables; the script is the canonical answer.
* If MATRA gets a market price in the future, the script will
  automatically incorporate it via an additional `market.matra_usd`
  field — the math is parameterised on the source feeds, not hard-coded.
