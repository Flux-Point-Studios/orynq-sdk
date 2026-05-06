"""materios_compute_meter — worker signing identity SDK for Materios verifiable
compute metering.

Public API (v1, unchanged):

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

Public API (v2, new — Wave 1+2):

    from materios_compute_meter import (
        # v1 above stays valid; v2 adds:
        ObserverKeypair,
        HardwareSpec,
        sign_hardware_spec,
        build_record_v2,
        sign_record_v2,
        attach_observer_signature_v2,
        verify_record_v2,
        next_period_start_ms,
        submit_v2,
        SubmissionResult,
        SCHEMA_VERSION_V2,
        SCHEMA_HASH_V2_HEX,
        canonical_cbor_for_fleet_op_sig,
        canonical_cbor_for_worker_sig,
        canonical_cbor_for_observer_sig,
        canonical_content_hash_v2,
    )

    # Load fleet-operator-signed hardware attestation:
    spec = HardwareSpec.load("/etc/materios/hardware.json")
    assert spec.verify("worker-001")

    # Build + seal a v2 envelope:
    body = build_record_v2(
        worker_id="worker-001",
        tenant_id="tenant-acme",
        period_start_ms=1700000000000,
        period_end_ms=1700000060000,
        metrics={
            "cpu_seconds": 60, "ram_gb_hours": 0.25, "disk_gb_hours": 0.0,
            "net_bytes_in": 1024, "net_bytes_out": 512, "gpu_seconds": 0,
        },
        hardware_spec=spec,
    )
    sealed = sign_record_v2(body, worker_kp)

    # Optional: attach an observer co-signature (Wave 2):
    sealed = attach_observer_signature_v2(sealed, observer_kp)

    # Submit:
    res = submit_v2(sealed, gateway_url="...", bearer="matra_...")
    print(res.receipt_id, res.content_hash)
"""
from __future__ import annotations

from .canonical import (
    SCHEMA_HASH_V2_HEX,
    SCHEMA_VERSION_V2,
    canonical_cbor_for_fleet_op_sig,
    canonical_cbor_for_observer_sig,
    canonical_cbor_for_worker_sig,
    canonical_content_hash_v2,
)
from .exceptions import (
    ComputeMeterError,
    GatewayError,
    InvalidHardwareSpecError,
    InvalidKeyfileError,
    InvalidRecordError,
    InvalidSeedError,
    InvalidV2RecordError,
    ReplayRejectedError,
    SubmitError,
)
from .hardware_spec import HardwareSpec, SUPPORTED_GPU_TYPES, sign_hardware_spec
from .keypair import ObserverKeypair, WorkerKeypair
from .record import (
    MeteringRecord,
    Signed,
    attach_observer_signature_v2,
    build_record_v2,
    next_period_start_ms,
    sign_record_v2,
    verify_record_v2,
)
from .submit import SubmissionResult, submit, submit_v2

__all__ = [
    # v1
    "WorkerKeypair",
    "MeteringRecord",
    "Signed",
    "submit",
    # v2 keys
    "ObserverKeypair",
    # v2 hardware spec
    "HardwareSpec",
    "SUPPORTED_GPU_TYPES",
    "sign_hardware_spec",
    # v2 record
    "build_record_v2",
    "sign_record_v2",
    "attach_observer_signature_v2",
    "verify_record_v2",
    "next_period_start_ms",
    # v2 submit
    "submit_v2",
    "SubmissionResult",
    # v2 canonical helpers (re-exported for advanced verifiers)
    "SCHEMA_VERSION_V2",
    "SCHEMA_HASH_V2_HEX",
    "canonical_cbor_for_fleet_op_sig",
    "canonical_cbor_for_worker_sig",
    "canonical_cbor_for_observer_sig",
    "canonical_content_hash_v2",
    # Exceptions
    "ComputeMeterError",
    "GatewayError",
    "InvalidKeyfileError",
    "InvalidRecordError",
    "InvalidSeedError",
    "InvalidHardwareSpecError",
    "InvalidV2RecordError",
    "ReplayRejectedError",
    "SubmitError",
]

__version__ = "0.2.0-rc1"
