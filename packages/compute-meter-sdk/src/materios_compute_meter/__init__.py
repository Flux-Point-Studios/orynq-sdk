"""materios_compute_meter — worker signing identity SDK for Materios verifiable
compute metering.

Public API:

    from materios_compute_meter import (
        WorkerKeypair,
        MeteringRecord,
        Signed,
        submit,
    )

    # Generate / load
    kp = WorkerKeypair.generate()
    kp = WorkerKeypair.from_seed_hex("0x...")
    kp = WorkerKeypair.load("/path/to/worker-key.json")
    kp.save("/path/to/worker-key.json")

    # Sign + submit
    record = MeteringRecord(
        worker_id="worker-001",
        tenant_id="tenant-acme",
        period_start_ms=1733400000000,
        period_end_ms=1733403600000,
        cpu_seconds=120.5,
    )
    signed = kp.sign(record)
    result = submit(signed, gateway_url="...", api_key="matra_...")

    # Or one-shot:
    result = submit(kp, record, gateway_url="...", api_key="matra_...")
"""
from __future__ import annotations

from .exceptions import (
    ComputeMeterError,
    GatewayError,
    InvalidKeyfileError,
    InvalidRecordError,
    InvalidSeedError,
    ReplayRejectedError,
    SubmitError,
)
from .keypair import WorkerKeypair
from .record import MeteringRecord, Signed
from .submit import submit

__all__ = [
    "WorkerKeypair",
    "MeteringRecord",
    "Signed",
    "submit",
    # Exceptions
    "ComputeMeterError",
    "GatewayError",
    "InvalidKeyfileError",
    "InvalidRecordError",
    "InvalidSeedError",
    "ReplayRejectedError",
    "SubmitError",
]

__version__ = "0.1.0"
