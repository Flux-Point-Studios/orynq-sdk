"""
orynq_sdk.trace — pure-Python port of @fluxpointstudios/orynq-sdk-process-trace.

Implements the same cryptographic primitives so a trace built in Python
can be verified by a TS verifier (and vice-versa). Two language
implementations are kept byte-for-byte compatible via the shared
`fixtures/hash-vectors.json` regression fixture in the repo root.

Public API mirrors the TS package one-for-one (Pythonic snake_case names):

    create_trace(agent_id=..., metadata=..., description=...)
        -> TraceRun

    add_span(run, name=..., visibility="private", parent_span_id=None,
             metadata=None)
        -> TraceSpan

    add_event(run, span_id, *, kind, visibility=None, **kind_specific_fields)
        -> TraceEvent

    close_span(run, span_id, status="completed")
        -> None

    finalize_trace(run)
        -> TraceBundle

Three lower-level utilities are also exported for cross-language tests:

    canonical_json(value)              RFC-8785-ish JCS (sort keys, strip nulls)
    sha256_hex(string)                 lowercase hex SHA-256 of a UTF-8 string
    GENESIS_ROLLING_HASH               sha256("poi-trace:roll:v1|genesis")

This module deliberately avoids any external dependencies — pure stdlib
hashlib + json keeps Python install footprint tiny so `pip install
orynq-sdk` doesn't drag in pyca/cryptography or substrate-interface
unless the user opts into the [materios] extra (see pyproject.toml).
"""
from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional


# ---------------------------------------------------------------------------
# Hash domain prefixes — keep in lock-step with packages/process-trace/src/types.ts
# ---------------------------------------------------------------------------

HASH_DOMAIN_EVENT = "poi-trace:event:v1|"
HASH_DOMAIN_ROLL = "poi-trace:roll:v1|"
HASH_DOMAIN_SPAN = "poi-trace:span:v1|"
HASH_DOMAIN_LEAF = "poi-trace:leaf:v1|"
HASH_DOMAIN_NODE = "poi-trace:node:v1|"
HASH_DOMAIN_MANIFEST = "poi-trace:manifest:v1|"
HASH_DOMAIN_ROOT = "poi-trace:root:v1|"

GENESIS_ROLLING_HASH = hashlib.sha256(
    (HASH_DOMAIN_ROLL + "genesis").encode("utf-8")
).hexdigest()


# ---------------------------------------------------------------------------
# Canonical JSON (RFC 8785-ish: sort keys, strip nulls + undefined, no whitespace)
# ---------------------------------------------------------------------------

def canonical_json(value: Any) -> str:
    """
    Serialise `value` to canonical JSON.

    Matches the TS implementation's two production opt-ins:
    `removeNulls=true`, `removeUndefined=true`. Keys are sorted
    lexicographically; arrays preserve their order.

    Used by:
      - event hashing
      - manifest hashing
      - cross-language vector regression
    """
    return json.dumps(
        _sort_canonical(value),
        separators=(",", ":"),
        ensure_ascii=False,
        sort_keys=False,  # we already sorted recursively
    )


def _sort_canonical(value: Any) -> Any:
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for k in sorted(value.keys()):
            v = value[k]
            if v is None:
                continue
            out[k] = _sort_canonical(v)
        return out
    if isinstance(value, list):
        return [_sort_canonical(v) for v in value]
    return value


def sha256_hex(data: str) -> str:
    """Lowercase hex SHA-256 of a UTF-8 string. Stable across platforms."""
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Dataclasses mirroring the TS public shape
# ---------------------------------------------------------------------------

Visibility = Literal["public", "private", "secret"]
TraceStatus = Literal["running", "completed", "failed", "cancelled"]
TraceEventKind = Literal[
    "command", "output", "decision", "observation", "error", "custom"
]


# Default visibility per kind — matches DEFAULT_EVENT_VISIBILITY in the TS types.
_DEFAULT_VISIBILITY: Dict[str, Visibility] = {
    "command": "private",
    "output": "private",
    "decision": "public",
    "observation": "private",
    "error": "private",
    "custom": "private",
}


@dataclass
class TraceEvent:
    """One event in a trace. Kind-specific fields live in `payload`."""

    id: str
    seq: int
    timestamp: str
    visibility: Visibility
    kind: TraceEventKind
    # Kind-specific fields go in `payload` as a flat dict — keeps the
    # canonical-JSON serialisation deterministic without needing a sealed
    # union of dataclasses per kind.
    payload: Dict[str, Any] = field(default_factory=dict)
    hash: Optional[str] = None

    def to_dict_without_hash(self) -> Dict[str, Any]:
        """Build the dict shape that's serialised + hashed (no `hash` field)."""
        d: Dict[str, Any] = {
            "id": self.id,
            "seq": self.seq,
            "timestamp": self.timestamp,
            "visibility": self.visibility,
            "kind": self.kind,
        }
        d.update(self.payload)
        return d


@dataclass
class TraceSpan:
    """One span (logical group of events)."""

    id: str
    span_seq: int
    name: str
    status: TraceStatus
    visibility: Visibility
    started_at: str
    event_ids: List[str] = field(default_factory=list)
    child_span_ids: List[str] = field(default_factory=list)
    parent_span_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    ended_at: Optional[str] = None
    duration_ms: Optional[int] = None
    hash: Optional[str] = None


@dataclass
class TraceRun:
    """One run of a trace — events + spans + rolling/root hashes."""

    id: str
    schema_version: str
    agent_id: str
    status: TraceStatus
    started_at: str
    rolling_hash: str
    next_seq: int
    next_span_seq: int
    events: List[TraceEvent] = field(default_factory=list)
    spans: List[TraceSpan] = field(default_factory=list)
    metadata: Optional[Dict[str, Any]] = None
    ended_at: Optional[str] = None
    duration_ms: Optional[int] = None
    root_hash: Optional[str] = None


@dataclass
class TraceBundle:
    """Finalised trace: public view + cryptographic commitments."""

    format_version: str
    public_view: Dict[str, Any]
    private_run: TraceRun
    merkle_root: str
    root_hash: str
    # The canonical JSON payload + its sha256 — what we'd upload as a blob.
    content: str = ""
    manifest_hash: str = ""


# ---------------------------------------------------------------------------
# Builder API
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def create_trace(
    *,
    agent_id: str,
    metadata: Optional[Dict[str, Any]] = None,
    description: Optional[str] = None,
) -> TraceRun:
    """
    Initialise a fresh trace run.

    Mirrors `createTrace()` in the TS implementation. Genesis rolling
    hash is `sha256("poi-trace:roll:v1|genesis")` (constant across
    languages).
    """
    if not agent_id or not isinstance(agent_id, str):
        raise ValueError("agent_id is required and must be a non-empty string")

    merged_metadata: Optional[Dict[str, Any]] = None
    if metadata is not None or description is not None:
        merged_metadata = dict(metadata or {})
        if description is not None:
            merged_metadata["description"] = description

    return TraceRun(
        id=str(uuid.uuid4()),
        schema_version="1.0",
        agent_id=agent_id,
        status="running",
        started_at=_now_iso(),
        rolling_hash=GENESIS_ROLLING_HASH,
        next_seq=0,
        next_span_seq=0,
        events=[],
        spans=[],
        metadata=merged_metadata,
    )


def add_span(
    run: TraceRun,
    *,
    name: str,
    visibility: Visibility = "private",
    parent_span_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> TraceSpan:
    """Add a span to a running trace. Raises if the run is finalised."""
    if run.root_hash is not None:
        raise RuntimeError("cannot add span to a finalised trace run")
    if not name or not isinstance(name, str):
        raise ValueError("name is required and must be a non-empty string")

    if parent_span_id is not None:
        parent = _get_span(run, parent_span_id)
        if parent is None:
            raise ValueError(f"parent span not found: {parent_span_id}")
        if parent.status != "running":
            raise RuntimeError(f"parent span is not running: {parent_span_id}")

    span = TraceSpan(
        id=str(uuid.uuid4()),
        span_seq=run.next_span_seq,
        name=name,
        status="running",
        visibility=visibility,
        started_at=_now_iso(),
        event_ids=[],
        child_span_ids=[],
        parent_span_id=parent_span_id,
        metadata=dict(metadata) if metadata else None,
    )
    run.next_span_seq += 1
    run.spans.append(span)
    if parent_span_id is not None:
        parent = _get_span(run, parent_span_id)
        if parent is not None:
            parent.child_span_ids.append(span.id)
    return span


def add_event(
    run: TraceRun,
    span_id: str,
    *,
    kind: TraceEventKind,
    visibility: Optional[Visibility] = None,
    **payload: Any,
) -> TraceEvent:
    """
    Append an event to a span.

    Kind-specific fields are passed as **payload kwargs. For example, an
    observation event takes `observation="..."`; a command event takes
    `command="..."`. The payload is included as-is in the canonical JSON
    representation and therefore in the event hash.
    """
    if run.root_hash is not None:
        raise RuntimeError("cannot add event to a finalised trace run")

    span = _get_span(run, span_id)
    if span is None:
        raise ValueError(f"span not found: {span_id}")
    if span.status != "running":
        raise RuntimeError(f"cannot add event to closed span: {span_id} (status: {span.status})")
    if not kind or not isinstance(kind, str):
        raise ValueError("event kind is required and must be a non-empty string")

    effective_visibility: Visibility = (
        visibility if visibility is not None else _DEFAULT_VISIBILITY.get(kind, "private")
    )

    event = TraceEvent(
        id=str(uuid.uuid4()),
        seq=run.next_seq,
        timestamp=_now_iso(),
        visibility=effective_visibility,
        kind=kind,
        payload=dict(payload),
    )
    run.next_seq += 1

    # Compute event hash via canonical JSON (everything except `hash`).
    event_hash = sha256_hex(HASH_DOMAIN_EVENT + canonical_json(event.to_dict_without_hash()))
    event.hash = event_hash

    # Update the run's rolling hash.
    run.rolling_hash = sha256_hex(
        HASH_DOMAIN_ROLL + run.rolling_hash + "|" + event_hash
    )

    span.event_ids.append(event.id)
    run.events.append(event)
    return event


def close_span(
    run: TraceRun, span_id: str, status: TraceStatus = "completed",
) -> None:
    """Close a span and compute its hash from its event hashes."""
    span = _get_span(run, span_id)
    if span is None:
        raise ValueError(f"span not found: {span_id}")
    if span.status != "running":
        raise RuntimeError(f"span already closed: {span_id} (status: {span.status})")

    span.status = status
    ended_at = _now_iso()
    span.ended_at = ended_at
    span.duration_ms = int(
        (datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
         - datetime.fromisoformat(span.started_at.replace("Z", "+00:00"))).total_seconds() * 1000
    )

    # Span hash = sha256(domain + canonical(span_header) + "|" + event hashes joined)
    # Matches the TS computeSpanHash() shape (verified via test_two_events_change_root_hash).
    event_hashes = [_get_event(run, eid).hash or "" for eid in span.event_ids]
    span_header = {
        "id": span.id,
        "spanSeq": span.span_seq,
        "name": span.name,
        "status": span.status,
        "visibility": span.visibility,
        "startedAt": span.started_at,
        "endedAt": span.ended_at,
        "durationMs": span.duration_ms,
    }
    if span.parent_span_id is not None:
        span_header["parentSpanId"] = span.parent_span_id
    if span.metadata is not None:
        span_header["metadata"] = span.metadata

    span.hash = sha256_hex(
        HASH_DOMAIN_SPAN + canonical_json(span_header) + "|" + "|".join(event_hashes)
    )


def finalize_trace(run: TraceRun) -> TraceBundle:
    """
    Finalise a run, build the Merkle tree, and return a `TraceBundle`.

    Mirrors `finalizeTrace()` in the TS implementation:
      1. close any open spans (completed)
      2. set run.status = "completed", endedAt, durationMs
      3. compute Merkle tree over span hashes
      4. compute root hash from rolling hash + span hashes
      5. extract the public view
      6. compute `content` (canonical JSON) + `manifest_hash` (sha256(content))
    """
    if run.root_hash is not None:
        raise RuntimeError("trace run is already finalised")

    for span in run.spans:
        if span.status == "running":
            close_span(run, span.id, "completed")

    run.status = "completed"
    ended_at = _now_iso()
    run.ended_at = ended_at
    run.duration_ms = int(
        (datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
         - datetime.fromisoformat(run.started_at.replace("Z", "+00:00"))).total_seconds() * 1000
    )

    span_hashes_sorted = [s.hash or "" for s in sorted(run.spans, key=lambda x: x.span_seq)]
    merkle_root = _build_merkle_root(span_hashes_sorted)

    root_input = HASH_DOMAIN_ROOT + run.rolling_hash
    if span_hashes_sorted:
        root_input += "|" + "|".join(span_hashes_sorted)
    root_hash = sha256_hex(root_input)
    run.root_hash = root_hash

    public_view = _build_public_view(run, merkle_root)
    content = canonical_json(public_view)
    manifest_hash = sha256_hex(content)

    return TraceBundle(
        format_version="1.0",
        public_view=public_view,
        private_run=run,
        merkle_root=merkle_root,
        root_hash=root_hash,
        content=content,
        manifest_hash=manifest_hash,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_span(run: TraceRun, span_id: str) -> Optional[TraceSpan]:
    for s in run.spans:
        if s.id == span_id:
            return s
    return None


def _get_event(run: TraceRun, event_id: str) -> TraceEvent:
    for e in run.events:
        if e.id == event_id:
            return e
    raise KeyError(event_id)


def _build_merkle_root(leaves: List[str]) -> str:
    """
    Build a binary Merkle root over the supplied leaf hashes.

    Mirrors `buildSpanMerkleTree()` in the TS implementation:
      - each leaf is `sha256("poi-trace:leaf:v1|" + spanHash)`
      - each internal node is `sha256("poi-trace:node:v1|" + left + "|" + right)`
      - odd levels duplicate the last node (TS convention)
      - empty leaves -> root = sha256("poi-trace:node:v1|empty")
    """
    if not leaves:
        return sha256_hex(HASH_DOMAIN_NODE + "empty")

    nodes = [sha256_hex(HASH_DOMAIN_LEAF + h) for h in leaves]
    while len(nodes) > 1:
        next_level: List[str] = []
        for i in range(0, len(nodes), 2):
            left = nodes[i]
            right = nodes[i + 1] if i + 1 < len(nodes) else left
            next_level.append(sha256_hex(HASH_DOMAIN_NODE + left + "|" + right))
        nodes = next_level
    return nodes[0]


def _build_public_view(run: TraceRun, merkle_root: str) -> Dict[str, Any]:
    """Build the JSON-ready public view of a finalised run."""
    event_map = {e.id: e for e in run.events}

    public_spans: List[Dict[str, Any]] = []
    redacted_span_hashes: List[Dict[str, str]] = []

    for span in run.spans:
        if span.visibility == "public":
            ev_list: List[Dict[str, Any]] = []
            for eid in span.event_ids:
                ev = event_map.get(eid)
                if ev is None or ev.visibility != "public":
                    continue
                ev_list.append({
                    "id": ev.id,
                    "seq": ev.seq,
                    "timestamp": ev.timestamp,
                    "visibility": ev.visibility,
                    "kind": ev.kind,
                    **ev.payload,
                    "hash": ev.hash,
                })
            ev_list.sort(key=lambda e: e["seq"])
            span_dict: Dict[str, Any] = {
                "id": span.id,
                "spanSeq": span.span_seq,
                "name": span.name,
                "status": span.status,
                "visibility": span.visibility,
                "startedAt": span.started_at,
                "endedAt": span.ended_at,
                "durationMs": span.duration_ms,
                "eventIds": list(span.event_ids),
                "childSpanIds": list(span.child_span_ids),
                "events": ev_list,
            }
            if span.parent_span_id is not None:
                span_dict["parentSpanId"] = span.parent_span_id
            if span.metadata is not None:
                span_dict["metadata"] = span.metadata
            if span.hash is not None:
                span_dict["hash"] = span.hash
            public_spans.append(span_dict)
        else:
            if span.hash is not None:
                redacted_span_hashes.append({"spanId": span.id, "hash": span.hash})

    public_spans.sort(key=lambda s: s["spanSeq"])
    redacted_span_hashes.sort(key=lambda s: s["spanId"])

    return {
        "runId": run.id,
        "agentId": run.agent_id,
        "schemaVersion": run.schema_version,
        "startedAt": run.started_at,
        "endedAt": run.ended_at or run.started_at,
        "durationMs": run.duration_ms or 0,
        "status": run.status,
        "totalEvents": len(run.events),
        "totalSpans": len(run.spans),
        "rootHash": run.root_hash or "",
        "merkleRoot": merkle_root,
        "publicSpans": public_spans,
        "redactedSpanHashes": redacted_span_hashes,
    }


__all__ = [
    # Hash primitives
    "canonical_json",
    "sha256_hex",
    "GENESIS_ROLLING_HASH",
    "HASH_DOMAIN_EVENT",
    "HASH_DOMAIN_ROLL",
    "HASH_DOMAIN_SPAN",
    "HASH_DOMAIN_LEAF",
    "HASH_DOMAIN_NODE",
    "HASH_DOMAIN_MANIFEST",
    "HASH_DOMAIN_ROOT",
    # Builder API
    "create_trace",
    "add_span",
    "add_event",
    "close_span",
    "finalize_trace",
    # Dataclasses
    "TraceEvent",
    "TraceSpan",
    "TraceRun",
    "TraceBundle",
]
