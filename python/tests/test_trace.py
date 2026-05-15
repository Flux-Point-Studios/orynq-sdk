"""
Tests for orynq_sdk.trace — the Python port of @fluxpointstudios/orynq-sdk-process-trace.

Pins the same hash chain shape as the TypeScript implementation so a
trace built in Python can be verified by a TS verifier and vice-versa.
Cross-language fixture vectors live in `fixtures/hash-vectors.json` at
the repo root and are exercised by scripts/verify-hash-vectors.py;
this test file covers the higher-level builder API.
"""
from __future__ import annotations

import hashlib
import re

import pytest

from orynq_sdk.trace import (
    create_trace,
    add_span,
    add_event,
    close_span,
    finalize_trace,
    canonical_json,
    sha256_hex,
    GENESIS_ROLLING_HASH,
)


def test_create_trace_sets_required_fields() -> None:
    run = create_trace(agent_id="py-agent-1")
    assert run.agent_id == "py-agent-1"
    assert run.status == "running"
    assert run.rolling_hash == GENESIS_ROLLING_HASH
    assert run.events == []
    assert run.spans == []
    assert run.next_seq == 0
    assert run.next_span_seq == 0


def test_create_trace_rejects_empty_agent_id() -> None:
    with pytest.raises(ValueError, match="agent_id"):
        create_trace(agent_id="")


def test_add_span_adds_to_run() -> None:
    run = create_trace(agent_id="a")
    span = add_span(run, name="my-span")
    assert span.name == "my-span"
    assert span.status == "running"
    assert span.span_seq == 0
    assert run.next_span_seq == 1
    assert span in run.spans


def test_full_trace_lifecycle_produces_64_char_hex_hashes() -> None:
    run = create_trace(agent_id="a")
    span = add_span(run, name="s", visibility="public")
    add_event(run, span.id, kind="observation", observation="hello", visibility="public")
    close_span(run, span.id)
    bundle = finalize_trace(run)

    assert re.fullmatch(r"[0-9a-f]{64}", bundle.root_hash)
    assert re.fullmatch(r"[0-9a-f]{64}", bundle.merkle_root)
    assert bundle.public_view["totalEvents"] == 1
    assert bundle.public_view["totalSpans"] == 1


def test_genesis_rolling_hash_matches_ts_constant() -> None:
    # The TS implementation seeds with `sha256("poi-trace:roll:v1|genesis")`.
    # Python and TS MUST agree on this byte-for-byte or downstream
    # verifiers will reject our bundles.
    expected = hashlib.sha256(b"poi-trace:roll:v1|genesis").hexdigest()
    assert GENESIS_ROLLING_HASH == expected


def test_canonical_json_sorts_keys_strips_nulls() -> None:
    out = canonical_json({"b": 1, "a": 2, "c": None})
    assert out == '{"a":2,"b":1}'


def test_canonical_json_array_ordering_preserved() -> None:
    assert canonical_json([3, 1, 2]) == "[3,1,2]"


def test_sha256_hex_lowercase() -> None:
    h = sha256_hex("hello")
    assert h == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"


def test_two_events_change_root_hash() -> None:
    """Two distinct event payloads must produce different root hashes."""
    run1 = create_trace(agent_id="a")
    s1 = add_span(run1, name="s")
    add_event(run1, s1.id, kind="observation", observation="alpha", visibility="public")
    close_span(run1, s1.id)
    b1 = finalize_trace(run1)

    run2 = create_trace(agent_id="a")
    s2 = add_span(run2, name="s")
    add_event(run2, s2.id, kind="observation", observation="beta", visibility="public")
    close_span(run2, s2.id)
    b2 = finalize_trace(run2)

    assert b1.root_hash != b2.root_hash
