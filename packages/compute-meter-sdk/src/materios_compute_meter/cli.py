"""Command-line interface for materios_compute_meter.

Two subcommands:

  * `submit`     — sign + POST a v1 (`compute_metering_v1`) record.
  * `submit-v2`  — sign + POST a v2 (`compute_metering_v2`) record with a
                   mandatory hardware_spec and optional observer co-sig.

Examples:

    # v1 (existing behaviour, unchanged):
    python3 -m materios_compute_meter.cli submit \\
        --gateway https://materios.fluxpointstudios.com/preprod-blobs \\
        --bearer matra_xxx \\
        --worker-id worker-001 \\
        --tenant-id tenant-acme \\
        --period-start-ms 1700000000000 \\
        --period-end-ms 1700000060000 \\
        --cpu-seconds 60 \\
        --worker-key /var/lib/materios/worker-key.json

    # v2 (new):
    python3 -m materios_compute_meter.cli submit-v2 \\
        --gateway https://materios.fluxpointstudios.com/preprod-blobs \\
        --bearer matra_xxx \\
        --hardware-spec /etc/materios/hardware.json \\
        --worker-key /var/lib/materios/worker-key.json \\
        --worker-id worker-001 \\
        --tenant-id tenant-acme \\
        --period-start-ms 1700000000000 \\
        --period-end-ms 1700000060000 \\
        --cpu-seconds 60 \\
        --ram-gb-hours 0.25 \\
        --disk-gb-hours 0 \\
        --net-bytes-in 1024 \\
        --net-bytes-out 512 \\
        --gpu-seconds 0 \\
        --observer-key /var/lib/materios/observer-key.json   # optional

Exit codes:

  0 = success
  1 = configuration error (missing arg, file not found, etc.)
  2 = validation / canonical error (bad metric, bad hardware spec, etc.)
  3 = network / gateway error
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from typing import List, Optional, Sequence

from .exceptions import (
    ComputeMeterError,
    GatewayError,
    InvalidHardwareSpecError,
    InvalidV2RecordError,
    ReplayRejectedError,
    SubmitError,
)
from .hardware_spec import HardwareSpec
from .keypair import ObserverKeypair, WorkerKeypair
from .record import (
    MeteringRecord,
    attach_observer_signature_v2,
    build_record_v2,
    sign_record_v2,
)
from .submit import submit, submit_v2

_LOG = logging.getLogger("materios_compute_meter.cli")


# ---------------------------------------------------------------------------
# v1 submit (kept for backward compat at the CLI level)
# ---------------------------------------------------------------------------


def _build_v1_parser(p: argparse.ArgumentParser) -> None:
    p.add_argument("--gateway", required=True, help="Gateway base URL")
    p.add_argument(
        "--bearer",
        "--api-key",
        dest="bearer",
        required=True,
        help="Bearer token (matra_*)",
    )
    p.add_argument("--worker-key", required=True, help="Path to worker keyfile")
    p.add_argument("--worker-id", required=True)
    p.add_argument("--tenant-id", required=True)
    p.add_argument("--period-start-ms", type=int, required=True)
    p.add_argument("--period-end-ms", type=int, required=True)
    p.add_argument("--cpu-seconds", type=float, required=True)
    p.add_argument("--ram-gb-hours", type=float, default=0.0)
    p.add_argument("--disk-gb-hours", type=float, default=0.0)
    p.add_argument("--net-bytes-in", type=int, default=0)
    p.add_argument("--net-bytes-out", type=int, default=0)
    p.add_argument("--gpu-seconds", type=float, default=0.0)


def _run_v1_submit(args: argparse.Namespace) -> int:
    kp = WorkerKeypair.load(args.worker_key)
    rec = MeteringRecord(
        worker_id=args.worker_id,
        tenant_id=args.tenant_id,
        period_start_ms=args.period_start_ms,
        period_end_ms=args.period_end_ms,
        cpu_seconds=args.cpu_seconds,
        ram_gb_hours=args.ram_gb_hours,
        disk_gb_hours=args.disk_gb_hours,
        net_bytes_in=args.net_bytes_in,
        net_bytes_out=args.net_bytes_out,
        gpu_seconds=args.gpu_seconds,
    )
    res = submit(
        kp,
        rec,
        gateway_url=args.gateway,
        api_key=args.bearer,
    )
    print(json.dumps(res, indent=2, sort_keys=True))
    return 0


# ---------------------------------------------------------------------------
# v2 submit
# ---------------------------------------------------------------------------


def _build_v2_parser(p: argparse.ArgumentParser) -> None:
    p.add_argument("--gateway", required=True, help="Gateway base URL")
    p.add_argument(
        "--bearer",
        "--api-key",
        dest="bearer",
        required=True,
        help="Bearer token (matra_*)",
    )
    p.add_argument(
        "--hardware-spec",
        required=True,
        help="Path to fleet-operator-signed hardware spec JSON",
    )
    p.add_argument("--worker-key", required=True, help="Path to worker keyfile")
    p.add_argument(
        "--observer-key",
        default=None,
        help="OPTIONAL: path to observer keyfile to attach a co-signature",
    )
    p.add_argument("--worker-id", required=True)
    p.add_argument("--tenant-id", required=True)
    p.add_argument(
        "--period-start-ms",
        type=int,
        default=None,
        help="UNIX-epoch ms; defaults to now-60_000 if omitted",
    )
    p.add_argument(
        "--period-end-ms",
        type=int,
        default=None,
        help="UNIX-epoch ms; defaults to now if omitted",
    )
    p.add_argument("--cpu-seconds", type=int, required=True)
    p.add_argument("--ram-gb-hours", type=float, default=0.0)
    p.add_argument("--disk-gb-hours", type=float, default=0.0)
    p.add_argument("--net-bytes-in", type=int, default=0)
    p.add_argument("--net-bytes-out", type=int, default=0)
    p.add_argument("--gpu-seconds", type=int, default=0)
    p.add_argument(
        "--skip-spec-verify",
        action="store_true",
        help="Skip the local fleet-operator-sig verify (default: verify on; "
        "rejects an unverifiable spec before sending the record).",
    )


def _run_v2_submit(args: argparse.Namespace) -> int:
    spec = HardwareSpec.load(args.hardware_spec)
    if not args.skip_spec_verify:
        if not spec.verify(args.worker_id):
            print(
                f"ERROR: hardware_spec at {args.hardware_spec} does not "
                f"verify against worker_id={args.worker_id!r}. Re-issue the "
                "spec or pass --skip-spec-verify if you know what you're doing.",
                file=sys.stderr,
            )
            return 2

    worker_kp = WorkerKeypair.load(args.worker_key)

    now_ms = int(time.time() * 1000)
    period_start_ms = (
        args.period_start_ms if args.period_start_ms is not None else now_ms - 60_000
    )
    period_end_ms = (
        args.period_end_ms if args.period_end_ms is not None else now_ms
    )

    body = build_record_v2(
        worker_id=args.worker_id,
        tenant_id=args.tenant_id,
        period_start_ms=period_start_ms,
        period_end_ms=period_end_ms,
        metrics={
            "cpu_seconds": args.cpu_seconds,
            "ram_gb_hours": args.ram_gb_hours,
            "disk_gb_hours": args.disk_gb_hours,
            "net_bytes_in": args.net_bytes_in,
            "net_bytes_out": args.net_bytes_out,
            "gpu_seconds": args.gpu_seconds,
        },
        hardware_spec=spec,
    )
    sealed = sign_record_v2(body, worker_kp)
    if args.observer_key:
        observer_kp = ObserverKeypair.load(args.observer_key)
        sealed = attach_observer_signature_v2(sealed, observer_kp)

    result = submit_v2(
        sealed,
        gateway_url=args.gateway,
        bearer=args.bearer,
    )
    print(
        json.dumps(
            {
                "status_code": result.status_code,
                "receipt_id": result.receipt_id,
                "content_hash": result.content_hash,
                "accepted_at": result.accepted_at,
                "observer_attached": "observer" in sealed,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="materios_compute_meter.cli",
        description=(
            "CLI for the Materios verifiable-compute-metering SDK. Signs and "
            "submits compute_metering_v1 / v2 records to a Materios blob gateway."
        ),
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable INFO-level logging.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    _build_v1_parser(sub.add_parser("submit", help="Submit a v1 record"))
    _build_v2_parser(sub.add_parser("submit-v2", help="Submit a v2 record"))
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    try:
        if args.cmd == "submit":
            return _run_v1_submit(args)
        if args.cmd == "submit-v2":
            return _run_v2_submit(args)
        parser.error(f"unknown command: {args.cmd!r}")
        return 1  # pragma: no cover
    except (InvalidHardwareSpecError, InvalidV2RecordError) as e:
        print(f"ERROR (validation): {e}", file=sys.stderr)
        return 2
    except ReplayRejectedError as e:
        print(f"ERROR (replay): {e}", file=sys.stderr)
        return 2
    except (GatewayError, SubmitError) as e:
        print(f"ERROR (network/gateway): {e}", file=sys.stderr)
        return 3
    except ComputeMeterError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
