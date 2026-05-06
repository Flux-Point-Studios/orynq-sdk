"""Tests for MeteringRecord dataclass and canonicalization."""
from __future__ import annotations

import pytest

from materios_compute_meter.exceptions import InvalidRecordError
from materios_compute_meter.record import MeteringRecord


def _make() -> MeteringRecord:
    return MeteringRecord(
        worker_id="worker-001",
        tenant_id="tenant-acme",
        period_start_ms=1733400000000,
        period_end_ms=1733403600000,
        cpu_seconds=120.5,
        ram_gb_hours=0.42,
        disk_gb_hours=0.0,
        net_bytes_in=1024,
        net_bytes_out=512,
        gpu_seconds=0.0,
    )


def test_record_to_canonical_dict_sorted_keys() -> None:
    rec = _make()
    d = rec.to_canonical_dict()
    keys = list(d.keys())
    assert keys == sorted(keys), "canonical dict must have sorted keys"
    assert d["worker_id"] == "worker-001"


def test_record_canonical_dict_excludes_signature() -> None:
    """The dict that gets canonicalized for signing must NOT contain the signature
    itself — that would be a circular dep."""
    rec = _make()
    d = rec.to_canonical_dict()
    assert "signature" not in d
    assert "content_hash" not in d
    assert "signer_public" not in d


def test_record_rejects_negative_period() -> None:
    with pytest.raises(InvalidRecordError):
        MeteringRecord(
            worker_id="w",
            tenant_id="t",
            period_start_ms=200,
            period_end_ms=100,  # < start
            cpu_seconds=1.0,
        )


def test_record_rejects_negative_resource_units() -> None:
    with pytest.raises(InvalidRecordError):
        MeteringRecord(
            worker_id="w",
            tenant_id="t",
            period_start_ms=1,
            period_end_ms=2,
            cpu_seconds=-1.0,
        )

    with pytest.raises(InvalidRecordError):
        MeteringRecord(
            worker_id="w",
            tenant_id="t",
            period_start_ms=1,
            period_end_ms=2,
            cpu_seconds=0.0,
            net_bytes_in=-1,
        )


def test_record_rejects_empty_worker_or_tenant() -> None:
    with pytest.raises(InvalidRecordError):
        MeteringRecord(
            worker_id="",
            tenant_id="t",
            period_start_ms=1,
            period_end_ms=2,
            cpu_seconds=1.0,
        )

    with pytest.raises(InvalidRecordError):
        MeteringRecord(
            worker_id="w",
            tenant_id="",
            period_start_ms=1,
            period_end_ms=2,
            cpu_seconds=1.0,
        )


def test_record_optional_fields_default_to_zero() -> None:
    rec = MeteringRecord(
        worker_id="w",
        tenant_id="t",
        period_start_ms=1,
        period_end_ms=2,
        cpu_seconds=1.0,
    )
    assert rec.ram_gb_hours == 0.0
    assert rec.disk_gb_hours == 0.0
    assert rec.net_bytes_in == 0
    assert rec.net_bytes_out == 0
    assert rec.gpu_seconds == 0.0


def test_records_with_same_logical_content_have_same_canonical_form() -> None:
    a = _make()
    b = _make()
    assert a.to_canonical_dict() == b.to_canonical_dict()
