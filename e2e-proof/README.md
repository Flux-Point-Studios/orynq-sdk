# `e2e-proof/` — technical correctness proof of the orynq-observe substrate

Five executable demos. Each produces a verifiable on-chain artefact a third
party can replay from a fresh clone of this repository. No FPS-controlled
non-public endpoint is required for verification — every check goes through
either a public RPC or a third-party block explorer.

| # | Demo | Property proven | On-chain output |
|---|---|---|---|
| 1 | [`01-pipeline/`](./01-pipeline) | End-to-end pipeline: SDK → gateway → cert-daemon M-of-N → anchor-worker → Cardano L1 | Cardano preprod tx hash |
| 2 | [`02-schema-fidelity/`](./02-schema-fidelity) | A published AI capability finding round-trips through `ai_capability_observation_v1` without semantic loss | Byte-identical canonical CBOR + content_hash |
| 3 | [`03-suppression-resistance/`](./03-suppression-resistance) | Once anchored, an observation cannot be removed or modified by FPS through any channel we control | Cardano preprod tx hash of a deliberately-embarrassing synthetic, plus failed removal log |
| 4 | [`04-independent-verify/`](./04-independent-verify) | The full lineage `contentHash → Materios L2 → Cardano L1` is reconstructible using ONLY public RPCs | JSON lineage proof from public-only endpoints |
| 5 | [`05-cost/`](./05-cost) | The all-in USD cost per observation, computed live from current network fees | A Markdown table; values change with fee market |

## Prerequisites

* Python 3.11+, `pip`
* Node.js 20+, `pnpm`
* A Cardano preprod wallet with ~5 tADA — the [Cardano preprod faucet]
  (https://docs.cardano.org/cardano-testnets/tools/faucet) is free and
  drops tADA on demand
* A Blockfrost free-tier project ID for `cardano-preprod` (used for L1
  verification — sign up at https://blockfrost.io)
* A gateway API token for the preprod observation channel (request via
  the repo's Discussions tab — preprod tokens are issued free to anyone
  who asks)

## Environment

```bash
# Required for all demos
export BLOCKFROST_PROJECT_ID_PREPROD=preprodXXXX...

# Required for demos 1 and 3 (need to submit to preprod)
export OBSERVE_API_KEY=matra_...
export OBSERVER_WALLET_JSON=/abs/path/to/observer.json   # produced by `orynq-observe keygen`

# Required for demo 5 mainnet cost estimate
export BLOCKFROST_PROJECT_ID_MAINNET=mainnetXXXX...      # any free Blockfrost mainnet project
```

Defaults (override if you self-host):

```
ORYNQ_GATEWAY_URL=https://materios.fluxpointstudios.com/preprod-blobs
ORYNQ_RPC_URL=wss://materios.fluxpointstudios.com/rpc
```

## Run all five

```bash
cd e2e-proof
./run-all.sh
```

The script prints a JSON summary at the end:

```json
{
  "01_pipeline":              { "content_hash": "...", "materios_tx": "0x...", "cardano_anchor_tx": "..." },
  "02_schema_fidelity":       { "status": "PASS", "byte_identical": true },
  "03_suppression_resistance":{ "synthetic_content_hash": "...", "cardano_anchor_tx": "...", "removal_attempts_failed": 3 },
  "04_independent_verify":    { "input_content_hash": "...", "materios_root": "...", "cardano_anchor_tx": "..." },
  "05_cost":                  { "preprod_usd_per_observation": 0.0, "mainnet_usd_per_observation": 0.xxx }
}
```

## CI

The GitHub Actions workflow `.github/workflows/e2e-proof.yml` runs the
harness on every push to `main`. Demos 1 and 3 consume one preprod tADA
each per run, capped at one execution per push.

## How to read this directory

Each demo is a directory:

* `README.md` — the recipe (third-party-runnable from this file alone)
* `run.{sh,py}` — the orchestrator
* `test_*.py` — unit tests with hermetic fixtures (no network)

If a demo can be verified without ever touching FPS infrastructure, its
README will state that explicitly under "**Third-party verification**".
