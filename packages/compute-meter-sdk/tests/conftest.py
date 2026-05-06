"""Shared pytest fixtures for materios-compute-meter tests.

Resets the per-process replay cache between unit tests so reused worker_ids
across test functions don't leak state. Integration tests get a fresh
cache too — they use unique time-based worker_ids anyway, but the reset
is cheap insurance.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset_replay_cache() -> None:
    """Clear the per-process replay cache before every test."""
    from materios_compute_meter.submit import _reset_replay_cache_for_tests

    _reset_replay_cache_for_tests()
    yield
    _reset_replay_cache_for_tests()
