"""Shared fixtures for the orynq-observe test suite."""
from __future__ import annotations

import pytest

from orynq_observe import ObserverKeypair


# Deterministic seed so cross-language vectors stay reproducible.
_OBSERVER_SEED = "0x" + "a1" * 32


@pytest.fixture
def observer_keypair() -> ObserverKeypair:
    return ObserverKeypair.from_seed_hex(_OBSERVER_SEED)
