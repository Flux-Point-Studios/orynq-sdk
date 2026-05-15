"""
Tests for `orynq_sdk.quickstart` — Python parity with the TS quickstart.
Network-bound tests (faucet, on-chain submit) are gated by
ORYNQ_RUN_LIVE_TESTS=1; the offline-safe slice runs in standard CI.
"""
from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path

import pytest

from orynq_sdk.quickstart import (
    build_explorer_urls,
    default_config_path,
    first_trace_bundle,
    load_or_create_identity,
    DEFAULT_GATEWAY_URL,
    DEFAULT_RPC_URL,
)


# Skip identity/faucet tests if substrate-interface isn't available.
substrate_interface = pytest.importorskip("substrateinterface")


def test_default_config_path_under_home() -> None:
    p = default_config_path()
    assert p.endswith(os.path.join(".orynq", "config.json"))
    assert os.path.expanduser("~") in p


def test_load_or_create_identity_round_trips() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cfg = os.path.join(tmp, "config.json")
        id1 = load_or_create_identity(config_path=cfg)
        assert id1.address.startswith("5") or id1.address.startswith("1")
        assert len(id1.mnemonic.split()) >= 12
        assert id1.freshly_generated is True
        assert os.path.exists(cfg)

        id2 = load_or_create_identity(config_path=cfg)
        assert id2.address == id1.address
        assert id2.mnemonic == id1.mnemonic
        assert id2.freshly_generated is False


@pytest.mark.skipif(os.name != "posix", reason="chmod is no-op on Windows")
def test_load_or_create_identity_writes_0600() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cfg = os.path.join(tmp, "config.json")
        load_or_create_identity(config_path=cfg)
        mode = stat.S_IMODE(os.stat(cfg).st_mode)
        assert mode == 0o600


def test_load_or_create_identity_rejects_malformed_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cfg = os.path.join(tmp, "config.json")
        Path(cfg).write_text("not-json-at-all")
        with pytest.raises(RuntimeError, match="identity"):
            load_or_create_identity(config_path=cfg)


def test_first_trace_bundle_returns_hex_hashes() -> None:
    bundle = first_trace_bundle(agent_id="py-quickstart-test", summary="hello")
    assert len(bundle.root_hash) == 64
    assert all(c in "0123456789abcdef" for c in bundle.root_hash)
    assert len(bundle.merkle_root) == 64
    assert len(bundle.manifest_hash) == 64
    assert bundle.content  # canonical JSON payload


def test_build_explorer_urls_matches_ts_contract() -> None:
    urls = build_explorer_urls(
        content_hash="0x" + "ab" * 32,
        block_hash="0x" + "cd" * 32,
        gateway_base_url="https://materios.fluxpointstudios.com/blobs",
        rpc_url="wss://materios.fluxpointstudios.com/rpc",
    )
    assert (
        urls["blob_status"]
        == "https://materios.fluxpointstudios.com/blobs/blobs/" + "ab" * 32 + "/status"
    )
    assert "polkadot.js.org/apps" in urls["explorer"]
    assert "/explorer/query/0x" + "cd" * 32 in urls["explorer"]
    assert urls["chain_info"] == "https://materios.fluxpointstudios.com/chain-info"
    assert urls["gateway_health"] == "https://materios.fluxpointstudios.com/health"


def test_build_explorer_urls_no_blobs_suffix() -> None:
    urls = build_explorer_urls(
        content_hash="ab" * 32,
        block_hash="cd" * 32,
        gateway_base_url="https://my-gateway.example.com",
        rpc_url="wss://my-rpc.example.com",
    )
    assert (
        urls["blob_status"]
        == "https://my-gateway.example.com/blobs/" + "ab" * 32 + "/status"
    )
    assert urls["chain_info"] == "https://my-gateway.example.com/chain-info"


@pytest.mark.skipif(
    os.getenv("ORYNQ_RUN_LIVE_TESTS") != "1",
    reason="live faucet test gated by ORYNQ_RUN_LIVE_TESTS=1",
)
async def test_request_faucet_live() -> None:
    """Hits the real preprod faucet. One-shot per address; expect either
    success or already-funded."""
    from orynq_sdk.quickstart import request_faucet

    with tempfile.TemporaryDirectory() as tmp:
        cfg = os.path.join(tmp, "config.json")
        identity = load_or_create_identity(config_path=cfg)
        result = await request_faucet(identity.address, DEFAULT_GATEWAY_URL)
        assert result["kind"] in {"success", "already-funded"}
