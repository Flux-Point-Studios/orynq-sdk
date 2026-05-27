"""Tests for the orynq-observe CLI shim."""
from __future__ import annotations

import json
from io import StringIO
from unittest.mock import patch

import pytest

from orynq_observe.cli import main


def test_cli_keygen_writes_file(tmp_path, capsys) -> None:
    p = tmp_path / "obs.json"
    rc = main([
        "keygen", "--out", str(p),
        "--seed", "0x" + "ab" * 32,
    ])
    assert rc == 0
    blob = json.loads(p.read_text())
    assert blob["scheme"] == "sr25519-observer"
    assert len(blob["secret"]) == 128
    assert len(blob["public"]) == 64
    # Stdout includes the generated public + ss58.
    captured = capsys.readouterr()
    assert blob["public"] in captured.out
    assert "ss58_address" in captured.out


def test_cli_submit_requires_wallet(tmp_path, capsys) -> None:
    # Missing wallet flag should raise SystemExit (argparse) — invalid arg.
    with pytest.raises(SystemExit):
        main([
            "submit",
            "--model", "m",
            "--model-version", "v",
            "--taxonomy", "t",
            "--severity", "high",
            "--observer-context", "x",
            "--prompt-file", "/tmp/_nope",
            "--response-file", "/tmp/_nope2",
            "--api-key", "matra_test",
        ])
    err = capsys.readouterr().err
    # argparse complains about missing --wallet (or other required arg).
    assert "wallet" in err.lower() or "required" in err.lower()


def test_cli_keygen_seed_is_deterministic(tmp_path) -> None:
    p1 = tmp_path / "a.json"
    p2 = tmp_path / "b.json"
    seed = "0x" + "11" * 32
    main(["keygen", "--out", str(p1), "--seed", seed])
    main(["keygen", "--out", str(p2), "--seed", seed])
    assert json.loads(p1.read_text())["public"] == json.loads(p2.read_text())["public"]
