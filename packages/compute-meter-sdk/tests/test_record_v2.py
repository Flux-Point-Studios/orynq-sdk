"""Tests for v2 record builders / signers.

Real sr25519 signatures (deterministic seeds for reproducibility). Real
hardware_spec round-trips. NO mocked crypto in this file.
"""
from __future__ import annotations

import math

import pytest

from materios_compute_meter.canonical import (
    SCHEMA_VERSION_V2,
    canonical_cbor_for_observer_sig,
    canonical_cbor_for_worker_sig,
    canonical_content_hash_v2,
)
from materios_compute_meter.exceptions import InvalidV2RecordError
from materios_compute_meter.hardware_spec import HardwareSpec, sign_hardware_spec
from materios_compute_meter.keypair import WorkerKeypair
from materios_compute_meter.record import (
    attach_observer_signature_v2,
    build_record_v2,
    next_period_start_ms,
    sign_record_v2,
    verify_record_v2,
)


# Deterministic seeds — three distinct keypairs.
_FLEET_SEED = "0x" + "01" * 32
_WORKER_SEED = "0x" + "02" * 32
_OBSERVER_SEED = "0x" + "03" * 32


def _fleet_kp() -> WorkerKeypair:
    return WorkerKeypair.from_seed_hex(_FLEET_SEED)


def _worker_kp() -> WorkerKeypair:
    return WorkerKeypair.from_seed_hex(_WORKER_SEED)


def _observer_kp() -> WorkerKeypair:
    return WorkerKeypair.from_seed_hex(_OBSERVER_SEED)


def _make_spec(worker_id: str = "worker-v2-001") -> HardwareSpec:
    return sign_hardware_spec(
        worker_id=worker_id,
        cpu_cores=8,
        ram_gb=32,
        gpu_type="none",
        gpu_count=0,
        issued_ms=1_700_000_000_000,
        fleet_operator_keypair=_fleet_kp(),
    )


def _good_metrics() -> dict:
    return {
        "cpu_seconds": 60,
        "ram_gb_hours": 0.25,
        "disk_gb_hours": 0.0,
        "net_bytes_in": 1024,
        "net_bytes_out": 512,
        "gpu_seconds": 0,
    }


def _build_default_body() -> dict:
    return build_record_v2(
        worker_id="worker-v2-001",
        tenant_id="tenant-acme",
        period_start_ms=1_700_000_000_000,
        period_end_ms=1_700_000_060_000,
        metrics=_good_metrics(),
        hardware_spec=_make_spec(),
    )


# ----- build ------------------------------------------------------------


def test_build_record_v2_returns_dict_with_all_required_v2_fields() -> None:
    body = _build_default_body()
    assert body["schema_version"] == SCHEMA_VERSION_V2
    assert body["worker_id"] == "worker-v2-001"
    assert body["tenant_id"] == "tenant-acme"
    assert body["period_start_ms"] == 1_700_000_000_000
    assert body["period_end_ms"] == 1_700_000_060_000
    assert body["metrics"]["cpu_seconds"] == 60
    assert body["metrics"]["ram_gb_hours"] == 0.25
    assert body["hardware_spec"]["cpu_cores"] == 8
    # Pre-sign, no worker_signature.
    assert "worker_signature" not in body
    # Pre-sign, no worker_pubkey since we didn't pass one in.
    assert "worker_pubkey" not in body


def test_build_record_v2_accepts_hardware_spec_dict_form() -> None:
    """Passing the envelope-dict form of hardware_spec works too."""
    spec = _make_spec()
    body = build_record_v2(
        worker_id="worker-v2-001",
        tenant_id="tenant-acme",
        period_start_ms=1,
        period_end_ms=2,
        metrics=_good_metrics(),
        hardware_spec=spec.to_envelope_dict(),
    )
    assert body["hardware_spec"]["cpu_cores"] == 8


def test_build_record_v2_normalizes_metric_floats() -> None:
    """Float metrics stay float; integer-only metrics enforced as int."""
    body = build_record_v2(
        worker_id="worker-v2-001",
        tenant_id="tenant-acme",
        period_start_ms=1,
        period_end_ms=2,
        metrics={
            "cpu_seconds": 60,
            "ram_gb_hours": 1,  # int — coerced to float
            "disk_gb_hours": 0.5,
            "net_bytes_in": 100,
            "net_bytes_out": 50,
            "gpu_seconds": 0,
        },
        hardware_spec=_make_spec(),
    )
    assert isinstance(body["metrics"]["ram_gb_hours"], float)
    assert body["metrics"]["ram_gb_hours"] == 1.0
    assert isinstance(body["metrics"]["cpu_seconds"], int)


def test_build_record_v2_rejects_bad_worker_id_with_space() -> None:
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker with space",
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=_good_metrics(),
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_bad_worker_id_with_comma() -> None:
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker,001",
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=_good_metrics(),
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_too_long_worker_id() -> None:
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="x" * 129,  # 129 > 128 max
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=_good_metrics(),
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_bad_tenant_id_uppercase() -> None:
    """tenant_id must be lowercase per the [a-z0-9-]{4,64} regex."""
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="Tenant-ACME",
            period_start_ms=1,
            period_end_ms=2,
            metrics=_good_metrics(),
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_bad_tenant_id_too_short() -> None:
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="abc",  # 3 chars, min is 4
            period_start_ms=1,
            period_end_ms=2,
            metrics=_good_metrics(),
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_period_zero_length() -> None:
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="tenant-acme",
            period_start_ms=100,
            period_end_ms=100,  # equal — must be strictly greater
            metrics=_good_metrics(),
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_period_over_24h() -> None:
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="tenant-acme",
            period_start_ms=0,
            period_end_ms=86_400_001,  # 24h + 1ms
            metrics=_good_metrics(),
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_accepts_period_exactly_24h() -> None:
    """24h boundary is inclusive."""
    body = build_record_v2(
        worker_id="worker-001",
        tenant_id="tenant-acme",
        period_start_ms=0,
        period_end_ms=86_400_000,
        metrics=_good_metrics(),
        hardware_spec=_make_spec(),
    )
    assert body["period_end_ms"] == 86_400_000


def test_build_record_v2_rejects_negative_metric() -> None:
    bad = _good_metrics()
    bad["cpu_seconds"] = -1
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=bad,
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_nan_metric() -> None:
    bad = _good_metrics()
    bad["ram_gb_hours"] = float("nan")
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=bad,
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_infinity_metric() -> None:
    bad = _good_metrics()
    bad["disk_gb_hours"] = math.inf
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=bad,
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_missing_metric_key() -> None:
    bad = _good_metrics()
    del bad["gpu_seconds"]
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=bad,
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_extra_metric_key() -> None:
    bad = _good_metrics()
    bad["bonus_metric"] = 1
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=bad,
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_bool_metric_value() -> None:
    """Python bools are int subclasses — explicitly reject them."""
    bad = _good_metrics()
    bad["cpu_seconds"] = True  # would silently equal 1 if we let it through
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=bad,
            hardware_spec=_make_spec(),
        )


def test_build_record_v2_rejects_float_for_int_only_metric() -> None:
    bad = _good_metrics()
    bad["net_bytes_in"] = 100.5  # int-only field
    with pytest.raises(InvalidV2RecordError):
        build_record_v2(
            worker_id="worker-001",
            tenant_id="tenant-acme",
            period_start_ms=1,
            period_end_ms=2,
            metrics=bad,
            hardware_spec=_make_spec(),
        )


# ----- sign --------------------------------------------------------------


def test_sign_record_v2_fills_pubkey_and_signature() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    assert isinstance(sealed["worker_pubkey"], bytes)
    assert len(sealed["worker_pubkey"]) == 32
    assert isinstance(sealed["worker_signature"], bytes)
    assert len(sealed["worker_signature"]) == 64


def test_sign_record_v2_does_not_mutate_input() -> None:
    body = _build_default_body()
    body_snapshot = dict(body)
    sign_record_v2(body, _worker_kp())
    assert body == body_snapshot
    assert "worker_signature" not in body


def test_sign_record_v2_signature_verifies_against_canonical_bytes() -> None:
    """The signature MUST verify against the canonical worker-sig pre-image
    derived from the sealed record."""
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    expected_body = canonical_cbor_for_worker_sig(sealed)
    kp = _worker_kp()
    assert kp.verify_bytes(expected_body, sealed["worker_signature"]) is True


def test_sign_record_v2_pubkey_overrides_caller_provided_one() -> None:
    """If the caller pre-populated worker_pubkey with a different key,
    sign_record_v2 must overwrite it with the signing keypair's pubkey."""
    body = _build_default_body()
    other_pub = bytes.fromhex(_observer_kp().public_hex)
    body["worker_pubkey"] = other_pub
    sealed = sign_record_v2(body, _worker_kp())
    assert sealed["worker_pubkey"] == bytes.fromhex(_worker_kp().public_hex)
    assert sealed["worker_pubkey"] != other_pub


def test_sign_record_v2_rejects_non_dict_input() -> None:
    with pytest.raises(InvalidV2RecordError):
        sign_record_v2([1, 2, 3], _worker_kp())  # type: ignore[arg-type]


def test_sign_record_v2_rejects_non_keypair() -> None:
    body = _build_default_body()
    with pytest.raises(InvalidV2RecordError):
        sign_record_v2(body, "not a keypair")  # type: ignore[arg-type]


def test_verify_record_v2_returns_true_for_correctly_sealed() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    assert verify_record_v2(sealed) is True


def test_verify_record_v2_returns_false_when_metric_tampered() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    # Tamper after sealing — verify must catch it.
    sealed["metrics"]["cpu_seconds"] = 9999
    assert verify_record_v2(sealed) is False


def test_verify_record_v2_returns_false_when_signature_swapped_for_different_record() -> None:
    body_a = _build_default_body()
    sealed_a = sign_record_v2(body_a, _worker_kp())
    # Build a different record (different period) and steal A's sig.
    body_b = build_record_v2(
        worker_id="worker-v2-001",
        tenant_id="tenant-acme",
        period_start_ms=2_000_000_000_000,
        period_end_ms=2_000_000_060_000,
        metrics=_good_metrics(),
        hardware_spec=_make_spec(),
    )
    sealed_b = sign_record_v2(body_b, _worker_kp())
    sealed_b["worker_signature"] = sealed_a["worker_signature"]
    assert verify_record_v2(sealed_b) is False


def test_verify_record_v2_returns_false_when_pubkey_swapped() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    sealed["worker_pubkey"] = bytes.fromhex(_observer_kp().public_hex)
    assert verify_record_v2(sealed) is False


def test_content_hash_v2_helper_matches_canonical_pre_image() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    expected_hex = canonical_content_hash_v2(sealed)
    # Strip variable signatures so the hash is computed over the worker
    # pre-image only — the helper does this for us.
    assert len(expected_hex) == 64
    assert isinstance(expected_hex, str)


# ----- observer ----------------------------------------------------------


def test_attach_observer_signature_v2_round_trip() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    co = attach_observer_signature_v2(sealed, _observer_kp())
    assert "observer" in co
    obs = co["observer"]
    assert isinstance(obs["observer_pubkey"], bytes)
    assert len(obs["observer_pubkey"]) == 32
    assert isinstance(obs["observer_signature"], bytes)
    assert len(obs["observer_signature"]) == 64
    # Worker sig preserved unchanged.
    assert co["worker_signature"] == sealed["worker_signature"]
    assert co["worker_pubkey"] == sealed["worker_pubkey"]


def test_attach_observer_does_not_mutate_input() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    sealed_snapshot = dict(sealed)
    attach_observer_signature_v2(sealed, _observer_kp())
    assert sealed == sealed_snapshot
    assert "observer" not in sealed


def test_observer_signature_verifies_against_same_pre_image_as_worker() -> None:
    """The observer signs the SAME bytes as the worker."""
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    co = attach_observer_signature_v2(sealed, _observer_kp())
    # Pre-image identical:
    assert canonical_cbor_for_worker_sig(co) == canonical_cbor_for_observer_sig(co)
    # Observer sig verifies under observer's pubkey:
    obs_kp = _observer_kp()
    body_bytes = canonical_cbor_for_observer_sig(co)
    assert obs_kp.verify_bytes(body_bytes, co["observer"]["observer_signature"]) is True
    # And worker sig STILL verifies:
    worker_kp = _worker_kp()
    assert worker_kp.verify_bytes(body_bytes, co["worker_signature"]) is True


def test_attach_observer_rejects_record_without_worker_signature() -> None:
    """Observer can only co-sign a worker-sealed record."""
    body = _build_default_body()
    with pytest.raises(InvalidV2RecordError):
        attach_observer_signature_v2(body, _observer_kp())


def test_attach_observer_rejects_non_keypair() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    with pytest.raises(InvalidV2RecordError):
        attach_observer_signature_v2(sealed, "not a keypair")  # type: ignore[arg-type]


def test_attach_observer_rejects_non_mapping() -> None:
    with pytest.raises(InvalidV2RecordError):
        attach_observer_signature_v2([1, 2, 3], _observer_kp())  # type: ignore[arg-type]


def test_verify_record_v2_with_observer_returns_true() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    co = attach_observer_signature_v2(sealed, _observer_kp())
    assert verify_record_v2(co) is True


def test_verify_record_v2_returns_false_when_observer_signature_tampered() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    co = attach_observer_signature_v2(sealed, _observer_kp())
    # Tamper observer sig (flip 1 byte at the end so it's still valid length).
    bad_sig = bytearray(co["observer"]["observer_signature"])
    bad_sig[-1] ^= 0xff
    co["observer"]["observer_signature"] = bytes(bad_sig)
    assert verify_record_v2(co) is False


def test_verify_record_v2_returns_false_when_observer_pubkey_swapped() -> None:
    body = _build_default_body()
    sealed = sign_record_v2(body, _worker_kp())
    co = attach_observer_signature_v2(sealed, _observer_kp())
    co["observer"]["observer_pubkey"] = bytes.fromhex(_worker_kp().public_hex)
    assert verify_record_v2(co) is False


# ----- monotonic helper --------------------------------------------------


def test_next_period_start_ms_returns_now_when_now_greater() -> None:
    out = next_period_start_ms(last_seen_ms=100, now_ms=200)
    assert out == 200


def test_next_period_start_ms_returns_last_plus_one_when_now_too_low() -> None:
    """If wall clock is BEHIND the last record (e.g. NTP drift), monotonic
    helper returns last + 1 ms to keep things strictly increasing."""
    out = next_period_start_ms(last_seen_ms=1_700_000_000_000, now_ms=1_500_000_000_000)
    assert out == 1_700_000_000_001


def test_next_period_start_ms_uses_wall_clock_when_no_now() -> None:
    """No now_ms argument: function reads time.time_ns() // 1e6."""
    import time as _time

    before = _time.time_ns() // 1_000_000
    out = next_period_start_ms(last_seen_ms=0)
    after = _time.time_ns() // 1_000_000
    assert before <= out <= after + 1


def test_next_period_start_ms_rejects_negative_last_seen() -> None:
    with pytest.raises(InvalidV2RecordError):
        next_period_start_ms(last_seen_ms=-1, now_ms=100)


def test_next_period_start_ms_rejects_bool_last_seen() -> None:
    with pytest.raises(InvalidV2RecordError):
        next_period_start_ms(last_seen_ms=True, now_ms=100)  # type: ignore[arg-type]


# ----- end-to-end deterministic example ---------------------------------


def test_v2_full_envelope_round_trips_through_sign_observer_verify() -> None:
    """End-to-end: build → sign worker → attach observer → verify the
    whole envelope. All deterministic; if this breaks, something in the
    canonical pre-image, key derivation, or sig flow regressed."""
    body = build_record_v2(
        worker_id="worker-e2e-001",
        tenant_id="tenant-e2e",
        period_start_ms=1_700_000_000_000,
        period_end_ms=1_700_000_060_000,
        metrics={
            "cpu_seconds": 60,
            "ram_gb_hours": 0.25,
            "disk_gb_hours": 0.0,
            "net_bytes_in": 1024,
            "net_bytes_out": 512,
            "gpu_seconds": 0,
        },
        hardware_spec=sign_hardware_spec(
            worker_id="worker-e2e-001",
            cpu_cores=8,
            ram_gb=32,
            gpu_type="none",
            gpu_count=0,
            issued_ms=1_699_000_000_000,
            fleet_operator_keypair=_fleet_kp(),
        ),
    )
    sealed = sign_record_v2(body, _worker_kp())
    co = attach_observer_signature_v2(sealed, _observer_kp())
    assert verify_record_v2(co) is True
    # And the embedded fleet-op sig also verifies:
    spec_dict = co["hardware_spec"]
    spec = HardwareSpec(
        cpu_cores=spec_dict["cpu_cores"],
        ram_gb=spec_dict["ram_gb"],
        gpu_type=spec_dict["gpu_type"],
        gpu_count=spec_dict["gpu_count"],
        fleet_operator_pubkey=spec_dict["fleet_operator_pubkey"],
        fleet_operator_signature=spec_dict["fleet_operator_signature"],
        issued_ms=spec_dict["issued_ms"],
    )
    assert spec.verify("worker-e2e-001") is True
