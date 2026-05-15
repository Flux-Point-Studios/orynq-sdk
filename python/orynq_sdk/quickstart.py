"""
orynq_sdk.quickstart — solo-developer DX entrypoints for Python.

Mirrors the TypeScript `@fluxpointstudios/orynq-sdk-quickstart` package:

  - `load_or_create_identity()`  — generate / reload an sr25519 keypair on
    disk. Pure-local, no network.
  - `request_faucet()`           — POST /blobs/faucet/drip on the Materios
    preprod gateway. Returns a discriminated dict (`kind: success | ...`).
  - `first_trace_bundle()`       — build a one-event, one-span trace using
    `orynq_sdk.trace`. Returns the `TraceBundle`.
  - `build_explorer_urls()`      — compose the gateway / polkadot.js.org
    URLs a fresh dev needs to *see* their trace after submission.

The full chain-submission path (`bootstrap_and_trace`) requires the
optional `materios` extra (`pip install orynq-sdk[materios]`) so the
default install stays slim. When the extra is present this module
also exposes a `bootstrap_and_trace()` async function.

CLI: `python -m orynq_sdk.quickstart {init,trace,whoami,status}`. The
parity with `npx orynq` is deliberate; the CLI's exit codes + env vars
match across languages.
"""
from __future__ import annotations

import json
import os
import re
import stat
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, Optional


DEFAULT_RPC_URL = "wss://materios.fluxpointstudios.com/rpc"
DEFAULT_GATEWAY_URL = "https://materios.fluxpointstudios.com/blobs"
DEFAULT_AGENT_ID = "orynq-quickstart-py"


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

@dataclass
class OrynqIdentity:
    mnemonic: str
    address: str
    generated_at: str
    config_path: str
    freshly_generated: bool
    warnings: list[str]


def default_config_path() -> str:
    """Return `~/.orynq/config.json`."""
    return os.path.join(os.path.expanduser("~"), ".orynq", "config.json")


def _normalise_ss58_address(public_key: bytes, ss58_format: int = 42) -> str:
    """SS58 encode an sr25519 public key (32 bytes) using substrate-interface
    if available, else a small in-house encoder. We always prefer the
    upstream lib when present so the encoded address matches what
    `polkadot/keyring` produces in the TS SDK."""
    try:
        from substrateinterface.utils.ss58 import ss58_encode
        return ss58_encode(public_key, ss58_format=ss58_format)
    except Exception as e:
        raise RuntimeError(
            "ss58 encoding requires substrate-interface — install with "
            "`pip install orynq-sdk[materios]`."
        ) from e


def _derive_address_from_mnemonic(mnemonic: str, ss58_format: int = 42) -> str:
    """Derive the sr25519 SS58 address that corresponds to `mnemonic`."""
    try:
        from substrateinterface import Keypair, KeypairType
        kp = Keypair.create_from_mnemonic(
            mnemonic, ss58_format=ss58_format, crypto_type=KeypairType.SR25519
        )
        return kp.ss58_address
    except ImportError as e:
        raise RuntimeError(
            "deriving an address requires substrate-interface — install with "
            "`pip install orynq-sdk[materios]`."
        ) from e


def load_or_create_identity(
    config_path: Optional[str] = None,
    ss58_format: int = 42,
) -> OrynqIdentity:
    """
    Load an existing identity from `config_path`, or generate + persist a
    new one if the file does not exist. Mirrors the TS function of the
    same name; same JSON shape on disk so both languages can read each
    other's config.
    """
    path = Path(config_path or default_config_path())
    warnings: list[str] = []

    if path.exists():
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            raise RuntimeError(
                f"orynq identity config at {path} is corrupt: {e}. "
                f"Inspect the file by hand — do NOT delete it without first "
                f"checking whether the mnemonic inside is still recoverable. "
                f"To regenerate, move the file aside (e.g. mv {path} {path}.broken) and rerun."
            ) from e
        if (
            not isinstance(parsed, dict)
            or not isinstance(parsed.get("mnemonic"), str)
            or not isinstance(parsed.get("address"), str)
        ):
            raise RuntimeError(
                f"orynq identity config at {path} is missing required fields "
                f"(mnemonic, address). Move it aside and rerun."
            )
        derived = _derive_address_from_mnemonic(parsed["mnemonic"], ss58_format)
        if derived != parsed["address"]:
            warnings.append(
                f"address re-encoded under ss58_format={ss58_format} "
                f"(config had {parsed['address']})"
            )
        return OrynqIdentity(
            mnemonic=parsed["mnemonic"],
            address=derived,
            generated_at=parsed.get("generated_at") or parsed.get("generatedAt") or "",
            config_path=str(path),
            freshly_generated=False,
            warnings=warnings,
        )

    # Generate fresh
    try:
        from substrateinterface import Keypair, KeypairType
        mnemonic = Keypair.generate_mnemonic()
        kp = Keypair.create_from_mnemonic(
            mnemonic, ss58_format=ss58_format, crypto_type=KeypairType.SR25519
        )
        address = kp.ss58_address
    except ImportError as e:
        raise RuntimeError(
            "generating an identity requires substrate-interface — install with "
            "`pip install orynq-sdk[materios]`."
        ) from e

    from datetime import datetime, timezone
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = {
        "version": 1,
        "mnemonic": mnemonic,
        "address": address,
        "generatedAt": generated_at,
    }
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    if os.name == "posix":
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 0o600

    return OrynqIdentity(
        mnemonic=mnemonic,
        address=address,
        generated_at=generated_at,
        config_path=str(path),
        freshly_generated=True,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Faucet
# ---------------------------------------------------------------------------

def _normalise_gateway_base(base: str) -> tuple[str, str]:
    """Return (blobs_base, root_base) — see TS `normaliseGatewayBase()`."""
    s = base.strip()
    if s.endswith("/"):
        s = s[:-1]
    if s.endswith("/blobs"):
        return s, s[: -len("/blobs")]
    return s, s


async def request_faucet(
    address: str,
    gateway_base_url: str = DEFAULT_GATEWAY_URL,
    *,
    timeout_s: float = 30.0,
) -> Dict[str, Any]:
    """
    Hit `POST {gateway}/blobs/faucet/drip`. Returns a dict with `kind` in
    {"success", "already-funded", "cooldown", "error"} mirroring the TS
    discriminated union.

    Uses httpx because that's already a dependency of orynq-sdk (Flux
    transport). Async to match the rest of the Python SDK.
    """
    import httpx

    # The faucet route is mounted on the express root (`/faucet/drip`),
    # NOT on the `/blobs` router. The nginx reverse-proxy strips the
    # `/blobs` prefix so the publicly-reachable URL is
    #   {root_base}/blobs/faucet/drip
    # i.e. the `/blobs` prefix appears exactly once. The bare /faucet/drip
    # path also works but enforces an IP-level 5-min cooldown, so we
    # explicitly use the per-address-ledger /blobs/-prefixed path.
    _blobs_base, root_base = _normalise_gateway_base(gateway_base_url)
    url = f"{root_base}/blobs/faucet/drip"

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        try:
            r = await client.post(url, json={"address": address})
        except httpx.HTTPError as e:
            return {"kind": "error", "status": 0, "message": str(e)}

    try:
        body = r.json()
    except Exception:
        return {"kind": "error", "status": r.status_code, "message": r.text[:256]}

    if r.is_success and body.get("success") is True:
        return {
            "kind": "success",
            "tx_hash": body.get("tx_hash", ""),
            "amount": str(body.get("amount", "")),
            "message": body.get("message", "MATRA dripped"),
        }
    if r.status_code == 409 and isinstance(body.get("dripped_at"), (int, float)):
        return {"kind": "already-funded", "dripped_at_ms": int(body["dripped_at"])}
    if r.status_code == 429 or re.search(r"cooldown", str(body.get("error", "")), re.I):
        retry_ms = 0
        if isinstance(body.get("cooldown_ms"), (int, float)):
            retry_ms = int(body["cooldown_ms"])
        elif isinstance(body.get("retry_after_seconds"), (int, float)):
            retry_ms = int(body["retry_after_seconds"]) * 1000
        return {
            "kind": "cooldown",
            "retry_after_ms": retry_ms,
            "message": str(body.get("error", "Faucet cooldown active")),
        }
    return {
        "kind": "error",
        "status": r.status_code,
        "message": str(body.get("error", r.text[:256] or "unknown faucet error")),
    }


# ---------------------------------------------------------------------------
# First-trace helper + explorer URLs
# ---------------------------------------------------------------------------

@dataclass
class TraceBundleLite:
    run_id: str
    agent_id: str
    root_hash: str
    merkle_root: str
    manifest_hash: str
    content: str


def first_trace_bundle(*, agent_id: str, summary: str) -> TraceBundleLite:
    """
    Build, finalise, and serialise a one-event, one-span trace bundle —
    Python equivalent of `firstTraceBundle()` in the TS SDK.
    """
    from .trace import (
        create_trace,
        add_span,
        add_event,
        close_span,
        finalize_trace,
    )

    run = create_trace(agent_id=agent_id)
    span = add_span(run, name="first-trace", visibility="public")
    add_event(
        run, span.id,
        kind="observation",
        observation=summary,
        visibility="public",
    )
    close_span(run, span.id)
    bundle = finalize_trace(run)

    return TraceBundleLite(
        run_id=bundle.public_view["runId"],
        agent_id=bundle.public_view["agentId"],
        root_hash=bundle.root_hash,
        merkle_root=bundle.merkle_root,
        manifest_hash=bundle.manifest_hash,
        content=bundle.content,
    )


def _strip0x(hex_str: str) -> str:
    return hex_str[2:] if hex_str.startswith(("0x", "0X")) else hex_str


def build_explorer_urls(
    *,
    content_hash: str,
    block_hash: str,
    gateway_base_url: str = DEFAULT_GATEWAY_URL,
    rpc_url: str = DEFAULT_RPC_URL,
) -> Dict[str, str]:
    """
    Compose the four user-facing URLs that close the loop on "first
    trace". See the TS `buildExplorerUrls()` for shape rationale.
    """
    from urllib.parse import quote

    ch = _strip0x(content_hash)
    bh = _strip0x(block_hash)
    blobs_base, root_base = _normalise_gateway_base(gateway_base_url)
    encoded_rpc = quote(rpc_url, safe="")
    explorer = (
        f"https://polkadot.js.org/apps/?rpc={encoded_rpc}"
        f"#/explorer/query/0x{bh}"
    )
    return {
        "blob_status": f"{blobs_base}/blobs/{ch}/status",
        "explorer": explorer,
        "chain_info": f"{root_base}/chain-info",
        "gateway_health": f"{root_base}/health",
    }


__all__ = [
    # Identity
    "OrynqIdentity",
    "default_config_path",
    "load_or_create_identity",
    # Faucet
    "request_faucet",
    # Trace + URLs
    "TraceBundleLite",
    "first_trace_bundle",
    "build_explorer_urls",
    # Constants
    "DEFAULT_RPC_URL",
    "DEFAULT_GATEWAY_URL",
    "DEFAULT_AGENT_ID",
]
