"""Tests for the CLI: submit + submit-v2 subcommands.

Mocks httpx (so no real network) but uses REAL keypairs, REAL hardware
specs on disk, and REAL signature flow. Asserts:

  * argparse plumbing works (--gateway, --bearer, --hardware-spec,
    --observer-key, --period-*, --cpu-seconds, ...).
  * The v2 path picks up the on-disk hardware spec and the worker key,
    builds the right envelope, and POSTs it.
  * Observer key is honoured iff --observer-key is given.
  * Hardware-spec verify-on-load fires by default.
  * Exit codes follow the documented contract.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Tuple

import httpx
import pytest

from materios_compute_meter.canonical import canonical_content_hash_v2
from materios_compute_meter.cli import main as cli_main
from materios_compute_meter.hardware_spec import sign_hardware_spec
from materios_compute_meter.keypair import ObserverKeypair, WorkerKeypair


_FLEET_SEED = "0x" + "40" * 32
_WORKER_SEED = "0x" + "50" * 32
_OBSERVER_SEED = "0x" + "60" * 32


def _materialize_keys_and_spec(
    tmp_path: Path, *, worker_id: str = "worker-cli-001"
) -> Tuple[Path, Path, Path]:
    """Persist a fleet-signed hardware spec, a worker keyfile, and an
    observer keyfile to tmp_path. Returns (hw_path, worker_kp_path,
    observer_kp_path)."""
    fleet_kp = WorkerKeypair.from_seed_hex(_FLEET_SEED)
    worker_kp = WorkerKeypair.from_seed_hex(_WORKER_SEED)
    observer_kp = ObserverKeypair.from_seed_hex(_OBSERVER_SEED)

    hw = sign_hardware_spec(
        worker_id=worker_id,
        cpu_cores=8,
        ram_gb=32,
        gpu_type="none",
        gpu_count=0,
        issued_ms=1_700_000_000_000,
        fleet_operator_keypair=fleet_kp,
    )
    hw_path = tmp_path / "hardware.json"
    hw.save(str(hw_path))

    worker_path = tmp_path / "worker.json"
    worker_kp.save(str(worker_path))

    observer_path = tmp_path / "observer.json"
    observer_kp.save(str(observer_path))

    return hw_path, worker_path, observer_path


@pytest.fixture
def patched_httpx(monkeypatch: pytest.MonkeyPatch):
    """Replace httpx.Client with a MockTransport-backed client. Returns
    a dict the test populates with `handler` (a callable taking Request,
    returning Response). The CLI's submit() / submit_v2() paths build
    their own Client(); we monkey-patch the constructor to inject the
    mock transport."""
    state: dict = {}

    real_init = httpx.Client.__init__

    def patched_init(self, *args, **kwargs):
        # Inject a transport pointing at state["handler"]; default to 503.
        def handler(request: httpx.Request) -> httpx.Response:
            h = state.get("handler")
            if h is None:
                return httpx.Response(503)
            return h(request)

        kwargs["transport"] = httpx.MockTransport(handler)
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", patched_init)
    return state


def test_cli_help_lists_both_subcommands(capsys: pytest.CaptureFixture) -> None:
    """The top-level --help should advertise both submit and submit-v2."""
    with pytest.raises(SystemExit) as exc:
        cli_main(["--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "submit" in out
    assert "submit-v2" in out


def test_cli_v2_help_lists_required_v2_flags(capsys: pytest.CaptureFixture) -> None:
    with pytest.raises(SystemExit) as exc:
        cli_main(["submit-v2", "--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    for flag in ("--gateway", "--bearer", "--hardware-spec", "--worker-key", "--observer-key", "--cpu-seconds"):
        assert flag in out


def test_cli_v2_submit_happy_path_no_observer(
    tmp_path: Path,
    patched_httpx: dict,
    capsys: pytest.CaptureFixture,
) -> None:
    hw_path, worker_path, _ = _materialize_keys_and_spec(tmp_path)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["body"] = body
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        # Compute content_hash from the SDK's perspective by reconstructing
        # the v2 record. We can't do that easily here; the gateway in this
        # test is a stand-in. Instead, we hard-code a content_hash that
        # matches what the SDK will compute by reading the SDK's response
        # validator: it MUST match the SDK's local recompute. So we have
        # the test pre-build the same sealed record and use its hash.
        # Easier path: have the handler pre-compute content_hash from the
        # POSTed wire format by reverse-mapping it.
        from materios_compute_meter.canonical import canonical_content_hash_v2

        # Reconstruct the bytes-typed record from the wire format.
        rec = {
            "schema_version": body["schema_version"],
            "worker_id": body["worker_id"],
            "tenant_id": body["tenant_id"],
            "period_start_ms": body["period_start_ms"],
            "period_end_ms": body["period_end_ms"],
            "metrics": body["metrics"],
            "hardware_spec": {
                "cpu_cores": body["hardware_spec"]["cpu_cores"],
                "ram_gb": body["hardware_spec"]["ram_gb"],
                "gpu_type": body["hardware_spec"]["gpu_type"],
                "gpu_count": body["hardware_spec"]["gpu_count"],
                "fleet_operator_pubkey": bytes.fromhex(
                    body["hardware_spec"]["fleet_operator_pubkey"]
                ),
                "fleet_operator_signature": bytes.fromhex(
                    body["hardware_spec"]["fleet_operator_signature"]
                ),
                "issued_ms": body["hardware_spec"]["issued_ms"],
            },
            "worker_pubkey": bytes.fromhex(body["worker_pubkey"]),
            "worker_signature": bytes.fromhex(body["worker_signature"]),
        }
        ch = canonical_content_hash_v2(rec)
        return httpx.Response(
            200,
            json={
                "receipt_id": "0xreceipt_cli_v2",
                "content_hash": ch,
                "accepted_at": 1_700_000_999,
            },
        )

    patched_httpx["handler"] = handler

    rc = cli_main(
        [
            "submit-v2",
            "--gateway",
            "https://example.com/gw",
            "--bearer",
            "matra_cli_test",
            "--hardware-spec",
            str(hw_path),
            "--worker-key",
            str(worker_path),
            "--worker-id",
            "worker-cli-001",
            "--tenant-id",
            "tenant-cli",
            "--period-start-ms",
            "1700000100000",
            "--period-end-ms",
            "1700000160000",
            "--cpu-seconds",
            "60",
            "--ram-gb-hours",
            "0.25",
        ]
    )
    assert rc == 0
    assert captured["url"].endswith("/metering/submit")
    assert captured["headers"]["authorization"] == "Bearer matra_cli_test"
    assert captured["body"]["schema_version"] == "compute_metering_v2"
    # No observer block.
    assert "observer" not in captured["body"]

    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["receipt_id"] == "0xreceipt_cli_v2"
    assert parsed["status_code"] == 200
    assert parsed["observer_attached"] is False


def test_cli_v2_submit_with_observer_attaches_block(
    tmp_path: Path,
    patched_httpx: dict,
    capsys: pytest.CaptureFixture,
) -> None:
    hw_path, worker_path, observer_path = _materialize_keys_and_spec(tmp_path)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["body"] = body
        # Compute content_hash like above.
        from materios_compute_meter.canonical import canonical_content_hash_v2

        rec = {
            "schema_version": body["schema_version"],
            "worker_id": body["worker_id"],
            "tenant_id": body["tenant_id"],
            "period_start_ms": body["period_start_ms"],
            "period_end_ms": body["period_end_ms"],
            "metrics": body["metrics"],
            "hardware_spec": {
                "cpu_cores": body["hardware_spec"]["cpu_cores"],
                "ram_gb": body["hardware_spec"]["ram_gb"],
                "gpu_type": body["hardware_spec"]["gpu_type"],
                "gpu_count": body["hardware_spec"]["gpu_count"],
                "fleet_operator_pubkey": bytes.fromhex(
                    body["hardware_spec"]["fleet_operator_pubkey"]
                ),
                "fleet_operator_signature": bytes.fromhex(
                    body["hardware_spec"]["fleet_operator_signature"]
                ),
                "issued_ms": body["hardware_spec"]["issued_ms"],
            },
            "worker_pubkey": bytes.fromhex(body["worker_pubkey"]),
            "worker_signature": bytes.fromhex(body["worker_signature"]),
        }
        # Observer doesn't change worker pre-image.
        ch = canonical_content_hash_v2(rec)
        return httpx.Response(
            200,
            json={
                "receipt_id": "0xobs",
                "content_hash": ch,
                "accepted_at": 0,
            },
        )

    patched_httpx["handler"] = handler

    rc = cli_main(
        [
            "submit-v2",
            "--gateway",
            "https://example.com/gw",
            "--bearer",
            "matra_obs",
            "--hardware-spec",
            str(hw_path),
            "--worker-key",
            str(worker_path),
            "--observer-key",
            str(observer_path),
            "--worker-id",
            "worker-cli-001",
            "--tenant-id",
            "tenant-cli",
            "--period-start-ms",
            "1700000200000",
            "--period-end-ms",
            "1700000260000",
            "--cpu-seconds",
            "60",
        ]
    )
    assert rc == 0
    body = captured["body"]
    assert "observer" in body
    assert "observer_pubkey" in body["observer"]
    assert "observer_signature" in body["observer"]

    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["observer_attached"] is True


def test_cli_v2_rejects_unverifiable_hardware_spec(
    tmp_path: Path,
    patched_httpx: dict,
    capsys: pytest.CaptureFixture,
) -> None:
    """If the hardware_spec was issued for worker_id A and the CLI is
    called with --worker-id B, the spec verify must fail and the CLI
    must abort with exit code 2 BEFORE any network call."""
    hw_path, worker_path, _ = _materialize_keys_and_spec(
        tmp_path, worker_id="worker-A"
    )
    sent = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        sent["count"] += 1
        return httpx.Response(200, json={})

    patched_httpx["handler"] = handler

    rc = cli_main(
        [
            "submit-v2",
            "--gateway",
            "https://example.com/gw",
            "--bearer",
            "t",
            "--hardware-spec",
            str(hw_path),
            "--worker-key",
            str(worker_path),
            "--worker-id",
            "worker-B",  # mismatch
            "--tenant-id",
            "tenant-cli",
            "--period-start-ms",
            "1700000300000",
            "--period-end-ms",
            "1700000360000",
            "--cpu-seconds",
            "1",
        ]
    )
    assert rc == 2
    assert sent["count"] == 0
    err = capsys.readouterr().err
    assert "does not verify" in err


def test_cli_v2_skip_spec_verify_bypasses_check(
    tmp_path: Path,
    patched_httpx: dict,
    capsys: pytest.CaptureFixture,
) -> None:
    """--skip-spec-verify allows submitting a spec that doesn't verify
    locally (the gateway will still reject it; this is for development /
    debugging only)."""
    hw_path, worker_path, _ = _materialize_keys_and_spec(
        tmp_path, worker_id="worker-A"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        from materios_compute_meter.canonical import canonical_content_hash_v2

        rec = {
            "schema_version": body["schema_version"],
            "worker_id": body["worker_id"],
            "tenant_id": body["tenant_id"],
            "period_start_ms": body["period_start_ms"],
            "period_end_ms": body["period_end_ms"],
            "metrics": body["metrics"],
            "hardware_spec": {
                "cpu_cores": body["hardware_spec"]["cpu_cores"],
                "ram_gb": body["hardware_spec"]["ram_gb"],
                "gpu_type": body["hardware_spec"]["gpu_type"],
                "gpu_count": body["hardware_spec"]["gpu_count"],
                "fleet_operator_pubkey": bytes.fromhex(
                    body["hardware_spec"]["fleet_operator_pubkey"]
                ),
                "fleet_operator_signature": bytes.fromhex(
                    body["hardware_spec"]["fleet_operator_signature"]
                ),
                "issued_ms": body["hardware_spec"]["issued_ms"],
            },
            "worker_pubkey": bytes.fromhex(body["worker_pubkey"]),
            "worker_signature": bytes.fromhex(body["worker_signature"]),
        }
        ch = canonical_content_hash_v2(rec)
        return httpx.Response(
            200,
            json={"receipt_id": "0xskip", "content_hash": ch, "accepted_at": 0},
        )

    patched_httpx["handler"] = handler

    rc = cli_main(
        [
            "submit-v2",
            "--gateway",
            "https://example.com/gw",
            "--bearer",
            "t",
            "--hardware-spec",
            str(hw_path),
            "--worker-key",
            str(worker_path),
            "--worker-id",
            "worker-B",  # mismatch
            "--tenant-id",
            "tenant-cli",
            "--period-start-ms",
            "1700000400000",
            "--period-end-ms",
            "1700000460000",
            "--cpu-seconds",
            "1",
            "--skip-spec-verify",
        ]
    )
    assert rc == 0


def test_cli_v2_returns_exit_3_on_gateway_error(
    tmp_path: Path,
    patched_httpx: dict,
    capsys: pytest.CaptureFixture,
) -> None:
    hw_path, worker_path, _ = _materialize_keys_and_spec(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "fleet_operator unknown"})

    patched_httpx["handler"] = handler

    rc = cli_main(
        [
            "submit-v2",
            "--gateway",
            "https://example.com/gw",
            "--bearer",
            "t",
            "--hardware-spec",
            str(hw_path),
            "--worker-key",
            str(worker_path),
            "--worker-id",
            "worker-cli-001",
            "--tenant-id",
            "tenant-cli",
            "--period-start-ms",
            "1700000500000",
            "--period-end-ms",
            "1700000560000",
            "--cpu-seconds",
            "1",
        ]
    )
    assert rc == 3
    err = capsys.readouterr().err
    assert "fleet_operator unknown" in err.lower()


def test_cli_v2_returns_exit_2_on_validation_error(
    tmp_path: Path,
    capsys: pytest.CaptureFixture,
) -> None:
    """Bad hardware spec file (missing fields) should be exit 2, not 1, not 3."""
    hw_path = tmp_path / "broken.json"
    hw_path.write_text(json.dumps({"cpu_cores": 8}))  # missing fields
    worker_path = tmp_path / "w.json"
    WorkerKeypair.from_seed_hex(_WORKER_SEED).save(str(worker_path))

    rc = cli_main(
        [
            "submit-v2",
            "--gateway",
            "https://example.com/gw",
            "--bearer",
            "t",
            "--hardware-spec",
            str(hw_path),
            "--worker-key",
            str(worker_path),
            "--worker-id",
            "worker-cli-001",
            "--tenant-id",
            "tenant-cli",
            "--period-start-ms",
            "1",
            "--period-end-ms",
            "2",
            "--cpu-seconds",
            "1",
        ]
    )
    assert rc == 2


def test_cli_v1_submit_still_works(
    tmp_path: Path,
    patched_httpx: dict,
    capsys: pytest.CaptureFixture,
) -> None:
    """v1 backward compat: the original 'submit' subcommand still functions."""
    worker_kp = WorkerKeypair.from_seed_hex(_WORKER_SEED)
    worker_path = tmp_path / "worker.json"
    worker_kp.save(str(worker_path))

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured["body"] = body
        return httpx.Response(
            200,
            json={
                "receipt_id": "0xv1",
                "content_hash": body["content_hash"],
                "accepted_at": 0,
            },
        )

    patched_httpx["handler"] = handler

    rc = cli_main(
        [
            "submit",
            "--gateway",
            "https://example.com/gw",
            "--bearer",
            "matra_v1",
            "--worker-key",
            str(worker_path),
            "--worker-id",
            "worker-001",
            "--tenant-id",
            "tenant-acme",
            "--period-start-ms",
            "1",
            "--period-end-ms",
            "2",
            "--cpu-seconds",
            "1.0",
        ]
    )
    assert rc == 0
    assert captured["body"]["scheme"] == "sr25519"
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["receipt_id"] == "0xv1"
