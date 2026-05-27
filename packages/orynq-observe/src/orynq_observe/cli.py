"""Command-line interface for orynq-observe.

Two subcommands:

  * `keygen`  — generate an sr25519 observer keyfile.
  * `submit`  — sign + POST an ai_capability_observation_v1 record.

Example:

    orynq-observe keygen --out /etc/observer/key.json

    orynq-observe submit \\
        --model claude-opus-4-7 \\
        --model-version 20260201 \\
        --taxonomy AUTO-MONEY-001 \\
        --severity high \\
        --observer-context "independent red-team session" \\
        --prompt-file prompt.txt \\
        --response-file response.txt \\
        --wallet /etc/observer/key.json \\
        --network preprod \\
        --api-key matra_xxx

Exit codes:
    0 — success
    1 — configuration error (missing arg, file not found, etc.)
    2 — observation / canonical validation error
    3 — network / gateway error
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from typing import List, Optional, Sequence

from .keypair import InvalidKeyfileError, ObserverKeypair
from .observation import Observation, ObservationError
from .submit import GatewayError, SubmitError


def _read_blob(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _maybe_text(path: str, *, treat_as_text: bool) -> str:
    blob = _read_blob(path)
    if treat_as_text:
        return blob.decode("utf-8", errors="replace")
    return blob.decode("utf-8", errors="replace") if blob.isascii() else blob.hex()


def _cmd_keygen(args: argparse.Namespace) -> int:
    if not args.out:
        print("error: --out is required", file=sys.stderr)
        return 1
    if args.seed:
        kp = ObserverKeypair.from_seed_hex(args.seed)
    else:
        kp = ObserverKeypair.generate()
    kp.save(args.out)
    print(
        json.dumps(
            {
                "scheme": kp.SCHEME,
                "public_hex": kp.public_hex,
                "ss58_address": kp.ss58_address,
                "keyfile": args.out,
            },
            indent=2,
        )
    )
    return 0


def _cmd_submit(args: argparse.Namespace) -> int:
    try:
        kp = ObserverKeypair.load(args.wallet)
    except InvalidKeyfileError as e:
        print(f"error: could not load wallet: {e}", file=sys.stderr)
        return 1

    try:
        obs = Observation(
            model_name=args.model,
            model_version=args.model_version,
            taxonomy_id=args.taxonomy,
            severity=args.severity,
            observer_context=args.observer_context,
            model_hash=args.model_hash,
        )
        prompt_text = _read_blob(args.prompt_file).decode("utf-8")
        response_text = _read_blob(args.response_file).decode("utf-8")
        obs.add_evidence(prompt=prompt_text, response=response_text)
        if args.artifact:
            obs.add_artifact(
                args.artifact,
                gateway_url=args.gateway_url,
                api_key=args.api_key,
            )
        if args.tee_tier and args.tee_evidence:
            ev = _read_blob(args.tee_evidence)
            obs.attest_tee(tier=args.tee_tier, evidence=ev)
    except ObservationError as e:
        print(f"error: invalid observation: {e}", file=sys.stderr)
        return 2

    try:
        receipt = obs.submit(
            wallet=kp,
            network=args.network,
            gateway_url=args.gateway_url,
            api_key=args.api_key,
            timeout_seconds=args.timeout_seconds,
        )
    except SubmitError as e:
        print(f"error: submit failed: {e}", file=sys.stderr)
        return 3
    except GatewayError as e:
        print(
            f"error: gateway rejected the observation: HTTP {e.status} {e.message}",
            file=sys.stderr,
        )
        return 3

    # Optionally poll for the materios_tx + cardano_anchor_tx to land.
    if args.wait_for_anchor:
        deadline = time.time() + args.wait_for_anchor
        while time.time() < deadline:
            receipt.refresh(
                gateway_url=args.gateway_url
                or f"https://materios.fluxpointstudios.com/{args.network}-blobs",
                api_key=args.api_key,
            )
            if receipt.materios_tx and receipt.cardano_anchor_tx:
                break
            time.sleep(5.0)

    print(
        json.dumps(
            {
                "content_hash": receipt.content_hash,
                "observer_ss58": receipt.observer_ss58,
                "gateway_status": receipt.gateway_status,
                "materios_tx": receipt.materios_tx,
                "cardano_anchor_tx": receipt.cardano_anchor_tx,
                "accepted_at": receipt.accepted_at,
            },
            indent=2,
        )
    )
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="orynq-observe",
        description="Publish attested AI model capability observations.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    pk = sub.add_parser("keygen", help="generate an sr25519 observer keyfile")
    pk.add_argument("--out", required=True, help="output keyfile path")
    pk.add_argument(
        "--seed",
        default=None,
        help="optional 32-byte hex seed (deterministic; tests only)",
    )

    ps = sub.add_parser("submit", help="submit an AI capability observation")
    ps.add_argument("--model", required=True, help="model name")
    ps.add_argument("--model-version", required=True, help="model version string")
    ps.add_argument("--model-hash", default=None, help="optional 32-byte hex")
    ps.add_argument("--taxonomy", required=True, help="capability taxonomy id")
    ps.add_argument(
        "--severity", required=True,
        choices=("low", "medium", "high", "critical"),
    )
    ps.add_argument(
        "--observer-context", required=True,
        help="free-form attribution string",
    )
    ps.add_argument("--prompt-file", required=True, help="path to prompt bytes")
    ps.add_argument(
        "--response-file", required=True, help="path to response bytes",
    )
    ps.add_argument(
        "--artifact", default=None,
        help="optional artifact path (uploaded to gateway) or opaque ref",
    )
    ps.add_argument(
        "--tee-tier", default=None,
        help="TEE attestation tier (Acurast / AMD_SEV_SNP / Intel_TDX / ...)",
    )
    ps.add_argument(
        "--tee-evidence", default=None,
        help="path to TEE evidence binary (paired with --tee-tier)",
    )
    ps.add_argument(
        "--wallet", required=True, help="path to observer JSON keyfile",
    )
    ps.add_argument(
        "--network", default="preprod", choices=("preprod", "mainnet"),
    )
    ps.add_argument(
        "--gateway-url", default=None,
        help="override the default gateway URL for the network",
    )
    ps.add_argument(
        "--api-key", required=True, help="Bearer token issued by gateway",
    )
    ps.add_argument(
        "--timeout-seconds", type=float, default=15.0,
        help="per-request HTTP timeout",
    )
    ps.add_argument(
        "--wait-for-anchor", type=float, default=0.0,
        help="poll the gateway up to N seconds for materios_tx + "
             "cardano_anchor_tx to land (default 0 = return immediately)",
    )

    args = parser.parse_args(argv)
    if args.cmd == "keygen":
        return _cmd_keygen(args)
    if args.cmd == "submit":
        return _cmd_submit(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
