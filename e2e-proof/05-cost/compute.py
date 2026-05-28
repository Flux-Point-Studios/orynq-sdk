"""Demo 5 — cost transparency.

Computes the all-in USD cost per observation, live, from current network
fee state. Output is a Markdown table.

Sources:

  * Materios chain `OrinqReceipts.ReceiptSubmissionFee` — the per-receipt
    MATRA fee charged by `submit_receipt_v2`. Read from the public RPC.

  * Cardano fee parameters via Blockfrost `/network/parameters` — the
    `min_fee_a` (lovelace per byte) and `min_fee_b` (constant lovelace),
    used to compute the expected fee for the anchor tx.

  * ADA/USD spot price via CoinGecko (no key required). Fetched at
    compute time so the table reflects the live market.

Outputs JSON (machine-readable) and a Markdown block (paste-ready into
the `/orynq/observe` docs page). The companion GitHub Actions workflow
at `.github/workflows/e2e-proof-cost-refresh.yml` runs this script
weekly and opens a PR if the table drifts > 10%.

For preprod the only paid path is the Cardano L1 anchor (tADA, no
market value). For mainnet the all-in cost is MATRA fee + Cardano L1
fee — neither of which FPS controls unilaterally.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Optional

import httpx
from substrateinterface import SubstrateInterface


MATERIOS_RPC_PREPROD = "wss://materios.fluxpointstudios.com/rpc"
MATERIOS_RPC_MAINNET = os.environ.get(
    "ORYNQ_RPC_URL_MAINNET", "wss://materios.fluxpointstudios.com/rpc-mainnet"
)
BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0"
BLOCKFROST_MAINNET = "https://cardano-mainnet.blockfrost.io/api/v0"
COINGECKO_ADA_USD = (
    "https://api.coingecko.com/api/v3/simple/price"
    "?ids=cardano&vs_currencies=usd"
)

# A typical Materios anchor tx is one input → one self-output + ~250
# bytes of metadata. Empirical sizing from
# `services/anchor-worker-materios` recent invocations.
ANCHOR_TX_BYTES = 700


class CostError(RuntimeError):
    """Raised when a fee source is unreachable or returns malformed data."""


# ---------------------------------------------------------------------------
# Source pulls
# ---------------------------------------------------------------------------


def pull_materios_fee(rpc_url: str) -> Dict[str, Any]:
    si = SubstrateInterface(url=rpc_url)
    try:
        fee = si.query("OrinqReceipts", "ReceiptSubmissionFee")
        floor = si.query("OrinqReceipts", "ReceiptSubmissionFeeFloor")
        props = si.properties or {}
        token_decimals = props.get("tokenDecimals", 6)
        token_symbol = props.get("tokenSymbol", "MATRA")
        if fee is None or fee.value is None:
            raise CostError(
                f"{rpc_url}: ReceiptSubmissionFee storage returned None"
            )
        base_units = int(fee.value)
        display = base_units / (10 ** int(token_decimals))
        return {
            "rpc_url": rpc_url,
            "receipt_submission_fee_base": base_units,
            "receipt_submission_fee_floor_base": (
                int(floor.value) if floor is not None and floor.value is not None else None
            ),
            "token_decimals": int(token_decimals),
            "token_symbol": token_symbol,
            "receipt_submission_fee_display": display,
        }
    finally:
        si.close()


def pull_cardano_network_params(
    base: str, project_id: str
) -> Dict[str, Any]:
    url = f"{base.rstrip('/')}/network/parameters"
    headers = {"project_id": project_id}
    with httpx.Client(timeout=20.0) as client:
        resp = client.get(url, headers=headers)
    if not (200 <= resp.status_code < 300):
        raise CostError(
            f"{url} returned HTTP {resp.status_code}: {resp.text[:200]!r}"
        )
    return resp.json()


def pull_ada_usd_spot() -> Optional[float]:
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(COINGECKO_ADA_USD)
        if not (200 <= resp.status_code < 300):
            return None
        data = resp.json()
        return float(data.get("cardano", {}).get("usd") or 0.0) or None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Cost math
# ---------------------------------------------------------------------------


def expected_cardano_tx_lovelace(
    params: Dict[str, Any], tx_bytes: int = ANCHOR_TX_BYTES
) -> int:
    """Compute a Cardano tx fee from current network parameters.

    Fee formula: `min_fee_b + min_fee_a * tx_bytes` (in lovelace).
    """
    a = int(params.get("min_fee_a", 44))
    b = int(params.get("min_fee_b", 155381))
    return b + a * tx_bytes


def compute_cost_table(
    *,
    network: str,
    materios_fee: Dict[str, Any],
    cardano_params: Dict[str, Any],
    ada_usd: Optional[float],
    sponsored: bool,
    tx_bytes: int = ANCHOR_TX_BYTES,
) -> Dict[str, Any]:
    lovelace = expected_cardano_tx_lovelace(cardano_params, tx_bytes)
    ada = lovelace / 1_000_000.0

    matra_paid = (
        0.0
        if sponsored
        else float(materios_fee["receipt_submission_fee_display"])
    )

    if ada_usd is None or sponsored or network == "preprod":
        # preprod tADA has no market price
        usd_total = None
        usd_l1 = None
    else:
        usd_l1 = ada * ada_usd
        # MATRA → USD: we have no market price for MATRA on day 1; show
        # the MATRA quantity but leave usd_matra null until a listed
        # pair exists.
        usd_total = usd_l1

    return {
        "network": network,
        "materios": {
            "rpc_url": materios_fee["rpc_url"],
            "receipt_submission_fee_matra": (
                materios_fee["receipt_submission_fee_display"]
            ),
            "sponsored": sponsored,
            "matra_paid_by_observer": matra_paid,
        },
        "cardano": {
            "min_fee_a": int(cardano_params.get("min_fee_a", 0)),
            "min_fee_b": int(cardano_params.get("min_fee_b", 0)),
            "anchor_tx_bytes_estimate": tx_bytes,
            "expected_lovelace": lovelace,
            "expected_ada": ada,
        },
        "market": {
            "ada_usd": ada_usd,
        },
        "totals": {
            "usd_cardano_l1": usd_l1,
            "usd_per_observation": usd_total,
        },
    }


def to_markdown(rows: Dict[str, Dict[str, Any]]) -> str:
    """Render a one-line-per-network Markdown table."""
    out = []
    out.append(
        "| Network | Sponsored | MATRA fee | Cardano L1 fee (ADA) | "
        "ADA/USD | USD per observation |"
    )
    out.append("|---|---|---|---|---|---|")
    for net, r in rows.items():
        sp = "yes" if r["materios"]["sponsored"] else "no"
        matra = (
            "n/a (sponsored)"
            if r["materios"]["sponsored"]
            else f"{r['materios']['matra_paid_by_observer']:.6f}"
        )
        ada = f"{r['cardano']['expected_ada']:.6f}"
        usd_price = (
            "n/a"
            if r["market"]["ada_usd"] is None
            else f"${r['market']['ada_usd']:.4f}"
        )
        usd_total = (
            "$0.00 (preprod, no market)"
            if r["totals"]["usd_per_observation"] is None and net == "preprod"
            else "n/a"
            if r["totals"]["usd_per_observation"] is None
            else f"${r['totals']['usd_per_observation']:.6f}"
        )
        out.append(f"| {net} | {sp} | {matra} | {ada} | {usd_price} | {usd_total} |")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run(
    *,
    blockfrost_preprod: Optional[str],
    blockfrost_mainnet: Optional[str],
    preprod_rpc: str,
    mainnet_rpc: str,
    include_mainnet: bool,
) -> Dict[str, Any]:
    out: Dict[str, Any] = {"results": {}}

    if blockfrost_preprod:
        materios_pre = pull_materios_fee(preprod_rpc)
        cardano_pre = pull_cardano_network_params(
            BLOCKFROST_PREPROD, blockfrost_preprod
        )
        out["results"]["preprod"] = compute_cost_table(
            network="preprod",
            materios_fee=materios_pre,
            cardano_params=cardano_pre,
            ada_usd=None,
            sponsored=True,
        )

    if include_mainnet and blockfrost_mainnet:
        try:
            materios_mn = pull_materios_fee(mainnet_rpc)
        except Exception as e:
            # mainnet RPC may not yet exist — fall back to preprod fee
            # constants for the estimate, label clearly.
            materios_mn = pull_materios_fee(preprod_rpc)
            materios_mn["rpc_url"] = (
                f"{preprod_rpc} (mainnet RPC unavailable: "
                f"{str(e)[:80]!r})"
            )
        cardano_mn = pull_cardano_network_params(
            BLOCKFROST_MAINNET, blockfrost_mainnet
        )
        ada_usd = pull_ada_usd_spot()
        out["results"]["mainnet"] = compute_cost_table(
            network="mainnet",
            materios_fee=materios_mn,
            cardano_params=cardano_mn,
            ada_usd=ada_usd,
            sponsored=False,
        )

    out["markdown"] = to_markdown(out["results"])
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--blockfrost-preprod",
        default=os.environ.get("BLOCKFROST_PROJECT_ID_PREPROD"),
    )
    parser.add_argument(
        "--blockfrost-mainnet",
        default=os.environ.get("BLOCKFROST_PROJECT_ID_MAINNET"),
    )
    parser.add_argument(
        "--preprod-rpc", default=os.environ.get("ORYNQ_RPC_URL", MATERIOS_RPC_PREPROD)
    )
    parser.add_argument(
        "--mainnet-rpc", default=MATERIOS_RPC_MAINNET,
    )
    parser.add_argument(
        "--include-mainnet",
        action="store_true",
        default=bool(os.environ.get("BLOCKFROST_PROJECT_ID_MAINNET")),
    )
    parser.add_argument("--markdown-only", action="store_true")
    args = parser.parse_args()

    if not args.blockfrost_preprod and not args.blockfrost_mainnet:
        print(
            "error: at least one of BLOCKFROST_PROJECT_ID_PREPROD or "
            "BLOCKFROST_PROJECT_ID_MAINNET must be set",
            file=sys.stderr,
        )
        return 1

    result = run(
        blockfrost_preprod=args.blockfrost_preprod,
        blockfrost_mainnet=args.blockfrost_mainnet,
        preprod_rpc=args.preprod_rpc,
        mainnet_rpc=args.mainnet_rpc,
        include_mainnet=args.include_mainnet,
    )

    if args.markdown_only:
        print(result["markdown"])
    else:
        print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
