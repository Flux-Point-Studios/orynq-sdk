"""
`orynq` console-script entrypoint for Python users.

Mirrors the `npx orynq` CLI in @fluxpointstudios/orynq-sdk-quickstart:

    orynq init       Generate identity + faucet drip.
    orynq trace      Build + submit a chain-anchored first trace.
    orynq whoami     Print the saved SS58 address.
    orynq status     Print gateway + chain health.
    orynq help       Print usage.

Env overrides (parity with TS):
    ORYNQ_CONFIG_PATH   path to identity file
    ORYNQ_RPC_URL       Substrate WS RPC URL
    ORYNQ_GATEWAY_URL   blob-gateway base URL
    ORYNQ_AGENT_ID      agentId stamped on the trace
    ORYNQ_SUMMARY       observation text on the first event
    ORYNQ_SKIP_FAUCET   "1" to skip faucet drip
    ORYNQ_VERBOSE       "1" to dump extra info on whoami

Exit codes: 0 success / 1 user-facing error / 2 unexpected.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Optional


def _tty() -> bool:
    return sys.stdout.isatty()


def _bold(s: str) -> str:
    return f"\x1b[1m{s}\x1b[0m" if _tty() else s


def _dim(s: str) -> str:
    return f"\x1b[2m{s}\x1b[0m" if _tty() else s


def _green(s: str) -> str:
    return f"\x1b[32m{s}\x1b[0m" if _tty() else s


def _yellow(s: str) -> str:
    return f"\x1b[33m{s}\x1b[0m" if _tty() else s


def _cyan(s: str) -> str:
    return f"\x1b[36m{s}\x1b[0m" if _tty() else s


def _red(s: str) -> str:
    return f"\x1b[31m{s}\x1b[0m" if _tty() else s


def _print_usage() -> None:
    sys.stdout.write(
        "\n".join(
            [
                f"{_bold('orynq')} — solo-dev CLI for orynq-sdk Python",
                "",
                "Usage:",
                f"  {_bold('orynq init')}     Generate identity + faucet-drip MATRA.",
                f"                            Idempotent — safe to rerun.",
                f"  {_bold('orynq trace')}    Submit your first trace on Materios.",
                f"                            Combines init + on-chain submit + cert.",
                f"  {_bold('orynq whoami')}   Print the saved SS58 address.",
                f"  {_bold('orynq status')}   Show gateway + chain health.",
                f"  {_bold('orynq help')}     Show this message.",
                "",
                "Env overrides:",
                "  ORYNQ_CONFIG_PATH=<path>   Where to save identity (default: ~/.orynq/config.json)",
                "  ORYNQ_RPC_URL=<wss-url>    Substrate RPC (default: Materios preprod)",
                "  ORYNQ_GATEWAY_URL=<url>    Blob-gateway base URL",
                "  ORYNQ_SKIP_FAUCET=1        Skip the faucet drip step",
                "",
                "Docs: https://github.com/Flux-Point-Studios/orynq-sdk#quickstart",
                "",
            ]
        )
    )


def _cmd_init() -> int:
    from .quickstart import (
        DEFAULT_GATEWAY_URL,
        load_or_create_identity,
        request_faucet,
    )

    identity = load_or_create_identity(config_path=os.environ.get("ORYNQ_CONFIG_PATH"))
    tag = _green("created") if identity.freshly_generated else _dim("(reused)")
    sys.stdout.write(f"{_bold('Identity')} {tag}\n")
    sys.stdout.write(f"  address     {_cyan(identity.address)}\n")
    sys.stdout.write(f"  configPath  {identity.config_path}\n")
    sys.stdout.write(f"  generatedAt {identity.generated_at}\n")
    for w in identity.warnings:
        sys.stdout.write(f"  {_yellow('warning')}     {w}\n")

    if os.environ.get("ORYNQ_SKIP_FAUCET") != "1":
        gateway = os.environ.get("ORYNQ_GATEWAY_URL", DEFAULT_GATEWAY_URL)
        sys.stdout.write(f"\n{_bold('Faucet')} {_dim('(' + gateway + ')')}\n")
        result = asyncio.run(request_faucet(identity.address, gateway))
        kind = result["kind"]
        if kind == "success":
            sys.stdout.write(f"  {_green('dripped')} {result['amount']} units\n")
            sys.stdout.write(f"  txHash      {result['tx_hash']}\n")
            sys.stdout.write(
                f"  {_dim('MOTRA will generate over the next few blocks.')}\n"
            )
        elif kind == "already-funded":
            sys.stdout.write(
                f"  {_dim('(already funded — drip ledger says yes; will reuse existing balance)')}\n"
            )
        elif kind == "cooldown":
            retry_s = int(result.get("retry_after_ms", 0)) // 1000
            sys.stdout.write(
                f"  {_yellow('cooldown')} retry in ~{retry_s}s\n"
            )
        elif kind == "error":
            sys.stdout.write(
                f"  {_red('error')} {result['message']} (HTTP {result.get('status', 0)})\n"
            )
            return 1
    else:
        sys.stdout.write(
            f"\n{_bold('Faucet')} {_dim('(skipped via ORYNQ_SKIP_FAUCET=1)')}\n"
        )

    sys.stdout.write(f"\n{_green('init complete')}. Next:\n")
    sys.stdout.write(f"  {_bold('orynq trace')}    submit your first trace\n")
    return 0


def _cmd_trace() -> int:
    sys.stdout.write(
        f"{_yellow('not yet shipped in Python')}: the chain-submission CLI in Python "
        "is wired by `python -m orynq_sdk.trace_submit_demo` for now. Until the "
        "`substrate-interface`-backed submitter ships in v0.2.x, use the Node "
        "CLI for the chain-submission path:\n\n"
        "  npm install --global @fluxpointstudios/orynq-sdk-quickstart\n"
        "  orynq trace\n\n"
        "The Python SDK already builds the same TraceBundle byte-for-byte\n"
        "(`from orynq_sdk import trace`) — only the on-chain submit step is\n"
        "Node-only today. Tracking: orynq-sdk#176.\n"
    )
    return 1


def _cmd_whoami() -> int:
    from .quickstart import load_or_create_identity

    identity = load_or_create_identity(config_path=os.environ.get("ORYNQ_CONFIG_PATH"))
    sys.stdout.write(identity.address + "\n")
    if os.environ.get("ORYNQ_VERBOSE") == "1":
        sys.stdout.write(_dim(f"config: {identity.config_path}\n"))
        sys.stdout.write(_dim(f"generatedAt: {identity.generated_at}\n"))
    return 0


def _cmd_status() -> int:
    import httpx

    gateway = os.environ.get("ORYNQ_GATEWAY_URL", "https://materios.fluxpointstudios.com/blobs")
    base = gateway.rstrip("/").removesuffix("/blobs").rstrip("/")
    # /status = cluster-wide rollup (gateway + cert-daemon + anchor-worker).
    # /health = gateway-only. Prefer /status so the dev sees finality + L1
    # anchor health at a glance.
    url = f"{base}/status"
    try:
        r = httpx.get(url, timeout=10.0)
    except Exception as e:
        sys.stderr.write(f"{_red('error')} could not reach {url}: {e}\n")
        return 1
    if r.is_error:
        sys.stderr.write(f"{_red('error')} HTTP {r.status_code} from {url}\n{r.text}\n")
        return 1
    try:
        parsed = r.json()
    except Exception:
        sys.stdout.write(r.text)
        return 0
    sys.stdout.write(f"{_bold('Gateway')} {_cyan(base)}\n")
    sys.stdout.write(f"  status        {parsed.get('overall') or parsed.get('status') or 'unknown'}\n")
    gw = parsed.get("components", {}).get("gateway")
    if isinstance(gw, dict):
        up = int((gw.get("uptime") or 0) // 60)
        sys.stdout.write(f"  uptime        {up}m\n")
        sys.stdout.write(f"  totalReceipts {gw.get('storage', {}).get('totalReceipts', '?')}\n")
    cd = parsed.get("components", {}).get("certDaemonAlice")
    if isinstance(cd, dict):
        sys.stdout.write(f"  bestBlock     {cd.get('bestBlock')}\n")
        sys.stdout.write(f"  finalityGap   {cd.get('finalityGap')}\n")
    aw = parsed.get("components", {}).get("anchorWorker")
    if isinstance(aw, dict):
        last = (aw.get("lastTxHash") or "?")[:12]
        sys.stdout.write(f"  anchorCount   {aw.get('anchorCount')}\n")
        sys.stdout.write(f"  cardanoTxs    last={last}...\n")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    cmd = args[0] if args else "help"
    try:
        if cmd == "init":
            return _cmd_init()
        if cmd == "trace":
            return _cmd_trace()
        if cmd == "whoami":
            return _cmd_whoami()
        if cmd == "status":
            return _cmd_status()
        if cmd in {"help", "--help", "-h"}:
            _print_usage()
            return 0
        if cmd in {"--version", "-v"}:
            from . import __version__
            sys.stdout.write(f"orynq-sdk {__version__}\n")
            return 0
        sys.stderr.write(f"{_red('error')} unknown command: {cmd}\n\n")
        _print_usage()
        return 1
    except RuntimeError as e:
        sys.stderr.write(f"{_red('error')} {e}\n")
        return 1
    except Exception as e:
        sys.stderr.write(f"{_red('internal error')} {e}\n")
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
