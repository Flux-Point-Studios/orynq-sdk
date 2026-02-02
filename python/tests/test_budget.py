"""
Tests for poi_sdk.budget module.

Tests budget tracking, spending limits enforcement, and the
MemoryBudgetStore implementation.
"""

import pytest
from datetime import datetime, timezone

from poi_sdk.budget import (
    BudgetTracker,
    MemoryBudgetStore,
    BudgetExceededError,
)
from poi_sdk.types import BudgetConfig


class TestMemoryBudgetStore:
    """Tests for MemoryBudgetStore class."""

    @pytest.fixture
    def store(self):
        """Create a fresh MemoryBudgetStore for each test."""
        return MemoryBudgetStore()

    async def test_initial_spent_is_zero(self, store):
        """Test that initial spent amount is zero."""
        spent = await store.get_spent("cardano:mainnet", "ADA", "2024-01-01")
        assert spent == 0

    async def test_records_spend(self, store):
        """Test recording a single spend."""
        await store.record_spend("cardano:mainnet", "ADA", 1000000)

        # Get today's spend
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        spent = await store.get_spent("cardano:mainnet", "ADA", today)
        assert spent == 1000000

    async def test_accumulates_spends(self, store):
        """Test that multiple spends are accumulated."""
        await store.record_spend("cardano:mainnet", "ADA", 1000000)
        await store.record_spend("cardano:mainnet", "ADA", 2000000)
        await store.record_spend("cardano:mainnet", "ADA", 500000)

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        spent = await store.get_spent("cardano:mainnet", "ADA", today)
        assert spent == 3500000

    async def test_tracks_different_assets(self, store):
        """Test tracking different assets separately."""
        await store.record_spend("cardano:mainnet", "ADA", 1000000)
        await store.record_spend("cardano:mainnet", "USDC", 500)

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        ada_spent = await store.get_spent("cardano:mainnet", "ADA", today)
        usdc_spent = await store.get_spent("cardano:mainnet", "USDC", today)

        assert ada_spent == 1000000
        assert usdc_spent == 500

    async def test_tracks_different_chains(self, store):
        """Test tracking different chains separately."""
        await store.record_spend("cardano:mainnet", "ADA", 1000000)
        await store.record_spend("cardano:preprod", "ADA", 2000000)

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        mainnet_spent = await store.get_spent("cardano:mainnet", "ADA", today)
        preprod_spent = await store.get_spent("cardano:preprod", "ADA", today)

        assert mainnet_spent == 1000000
        assert preprod_spent == 2000000

    async def test_tracks_different_days(self, store):
        """Test that different days are tracked separately."""
        # Manually set spending for different days
        store._spent["cardano:mainnet:ADA:2024-01-01"] = 1000000
        store._spent["cardano:mainnet:ADA:2024-01-02"] = 2000000

        day1_spent = await store.get_spent("cardano:mainnet", "ADA", "2024-01-01")
        day2_spent = await store.get_spent("cardano:mainnet", "ADA", "2024-01-02")

        assert day1_spent == 1000000
        assert day2_spent == 2000000

    async def test_reset(self, store):
        """Test resetting spending for a chain/asset."""
        await store.record_spend("cardano:mainnet", "ADA", 1000000)
        await store.reset("cardano:mainnet", "ADA")

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        spent = await store.get_spent("cardano:mainnet", "ADA", today)
        assert spent == 0

    async def test_reset_does_not_affect_other_assets(self, store):
        """Test that reset only affects the specified chain/asset."""
        await store.record_spend("cardano:mainnet", "ADA", 1000000)
        await store.record_spend("cardano:mainnet", "USDC", 500)

        await store.reset("cardano:mainnet", "ADA")

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        ada_spent = await store.get_spent("cardano:mainnet", "ADA", today)
        usdc_spent = await store.get_spent("cardano:mainnet", "USDC", today)

        assert ada_spent == 0
        assert usdc_spent == 500

    async def test_reset_nonexistent_key(self, store):
        """Test that resetting a nonexistent key doesn't raise an error."""
        # Should not raise
        await store.reset("nonexistent:chain", "UNKNOWN")


class TestBudgetTracker:
    """Tests for BudgetTracker class."""

    @pytest.fixture
    def tracker(self):
        """Create a BudgetTracker with standard limits."""
        config = BudgetConfig(
            max_per_request="2000000",
            max_per_day="10000000",
        )
        store = MemoryBudgetStore()
        return BudgetTracker(config, store)

    @pytest.fixture
    def tracker_per_request_only(self):
        """Create a BudgetTracker with only per-request limit."""
        config = BudgetConfig(max_per_request="2000000")
        store = MemoryBudgetStore()
        return BudgetTracker(config, store)

    @pytest.fixture
    def tracker_per_day_only(self):
        """Create a BudgetTracker with only daily limit."""
        config = BudgetConfig(max_per_day="10000000")
        store = MemoryBudgetStore()
        return BudgetTracker(config, store)

    async def test_allows_within_per_request_limit(self, tracker):
        """Test that amounts within per-request limit are allowed."""
        # Should not raise
        await tracker.check_budget("cardano:mainnet", "ADA", 1000000)
        await tracker.check_budget("cardano:mainnet", "ADA", 2000000)  # exact limit

    async def test_rejects_over_per_request_limit(self, tracker):
        """Test that amounts over per-request limit are rejected."""
        with pytest.raises(BudgetExceededError) as exc:
            await tracker.check_budget("cardano:mainnet", "ADA", 5000000)

        assert "per-request" in str(exc.value).lower()
        assert "5000000" in str(exc.value)
        assert "2000000" in str(exc.value)

    async def test_tracks_daily_spending(self, tracker):
        """Test that daily spending is tracked across multiple payments."""
        # First spend
        await tracker.check_budget("cardano:mainnet", "ADA", 2000000)
        await tracker.record_spend("cardano:mainnet", "ADA", 2000000)

        # Second spend
        await tracker.check_budget("cardano:mainnet", "ADA", 2000000)
        await tracker.record_spend("cardano:mainnet", "ADA", 2000000)

        # Third spend - still under daily limit (6M total)
        await tracker.check_budget("cardano:mainnet", "ADA", 2000000)

    async def test_rejects_over_daily_limit(self, tracker):
        """Test that payments exceeding daily limit are rejected."""
        # Spend up to limit (5 x 2M = 10M)
        for _ in range(5):
            await tracker.record_spend("cardano:mainnet", "ADA", 2000000)

        # Next spend should fail
        with pytest.raises(BudgetExceededError) as exc:
            await tracker.check_budget("cardano:mainnet", "ADA", 1000000)

        assert "daily" in str(exc.value).lower()

    async def test_daily_limit_check_includes_proposed_amount(self, tracker):
        """Test that daily limit check considers proposed amount."""
        # Spend 9M (leaving 1M remaining)
        await tracker.record_spend("cardano:mainnet", "ADA", 9000000)

        # 1M should be allowed
        await tracker.check_budget("cardano:mainnet", "ADA", 1000000)

        # 2M should be rejected (would total 11M)
        with pytest.raises(BudgetExceededError):
            await tracker.check_budget("cardano:mainnet", "ADA", 2000000)

    async def test_per_request_only_no_daily_limit(self, tracker_per_request_only):
        """Test tracker with only per-request limit."""
        # Should allow many requests as long as each is under per-request limit
        for _ in range(100):
            await tracker_per_request_only.record_spend("cardano:mainnet", "ADA", 1000000)

        # Should still be able to check (no daily limit)
        await tracker_per_request_only.check_budget("cardano:mainnet", "ADA", 1000000)

    async def test_per_day_only_no_per_request_limit(self, tracker_per_day_only):
        """Test tracker with only daily limit."""
        # Large single payment should be allowed if under daily limit
        await tracker_per_day_only.check_budget("cardano:mainnet", "ADA", 9000000)

    async def test_get_remaining_budget(self, tracker):
        """Test getting remaining daily budget."""
        remaining = await tracker.get_remaining_budget("cardano:mainnet", "ADA")
        assert remaining == 10000000

        await tracker.record_spend("cardano:mainnet", "ADA", 3000000)

        remaining = await tracker.get_remaining_budget("cardano:mainnet", "ADA")
        assert remaining == 7000000

    async def test_get_remaining_budget_no_daily_limit(self, tracker_per_request_only):
        """Test that get_remaining_budget returns None when no daily limit."""
        remaining = await tracker_per_request_only.get_remaining_budget(
            "cardano:mainnet", "ADA"
        )
        assert remaining is None

    async def test_remaining_budget_never_negative(self, tracker):
        """Test that remaining budget is never negative."""
        # Spend exactly the limit
        await tracker.record_spend("cardano:mainnet", "ADA", 10000000)

        remaining = await tracker.get_remaining_budget("cardano:mainnet", "ADA")
        assert remaining == 0

        # Over-spend (shouldn't happen in practice, but test the edge case)
        await tracker.record_spend("cardano:mainnet", "ADA", 1000000)

        remaining = await tracker.get_remaining_budget("cardano:mainnet", "ADA")
        assert remaining == 0  # Should be 0, not negative

    async def test_different_assets_tracked_separately(self, tracker):
        """Test that budget is tracked separately for different assets."""
        # Spend ADA
        await tracker.record_spend("cardano:mainnet", "ADA", 8000000)

        # USDC should still have full budget
        remaining_ada = await tracker.get_remaining_budget("cardano:mainnet", "ADA")
        remaining_usdc = await tracker.get_remaining_budget("cardano:mainnet", "USDC")

        assert remaining_ada == 2000000
        assert remaining_usdc == 10000000

    async def test_different_chains_tracked_separately(self, tracker):
        """Test that budget is tracked separately for different chains."""
        # Spend on mainnet
        await tracker.record_spend("cardano:mainnet", "ADA", 8000000)

        # Preprod should still have full budget
        remaining_mainnet = await tracker.get_remaining_budget("cardano:mainnet", "ADA")
        remaining_preprod = await tracker.get_remaining_budget("cardano:preprod", "ADA")

        assert remaining_mainnet == 2000000
        assert remaining_preprod == 10000000


class TestBudgetExceededError:
    """Tests for BudgetExceededError exception."""

    def test_is_exception(self):
        """Test that BudgetExceededError is an Exception."""
        assert issubclass(BudgetExceededError, Exception)

    def test_has_message(self):
        """Test that the error has a message."""
        error = BudgetExceededError("Budget exceeded")
        assert str(error) == "Budget exceeded"

    def test_can_be_raised_and_caught(self):
        """Test that the error can be raised and caught."""
        with pytest.raises(BudgetExceededError) as exc:
            raise BudgetExceededError("Test error message")

        assert "Test error message" in str(exc.value)


class TestBudgetEdgeCases:
    """Test edge cases and boundary conditions."""

    async def test_exact_per_request_limit(self):
        """Test payment exactly at per-request limit."""
        config = BudgetConfig(max_per_request="1000000")
        tracker = BudgetTracker(config, MemoryBudgetStore())

        # Exact limit should be allowed
        await tracker.check_budget("cardano:mainnet", "ADA", 1000000)

    async def test_one_over_per_request_limit(self):
        """Test payment one unit over per-request limit."""
        config = BudgetConfig(max_per_request="1000000")
        tracker = BudgetTracker(config, MemoryBudgetStore())

        # One over should be rejected
        with pytest.raises(BudgetExceededError):
            await tracker.check_budget("cardano:mainnet", "ADA", 1000001)

    async def test_exact_daily_limit(self):
        """Test spending exactly at daily limit."""
        config = BudgetConfig(max_per_day="5000000")
        tracker = BudgetTracker(config, MemoryBudgetStore())

        await tracker.record_spend("cardano:mainnet", "ADA", 3000000)

        # Spending exact remaining should be allowed
        await tracker.check_budget("cardano:mainnet", "ADA", 2000000)

    async def test_one_over_daily_limit(self):
        """Test spending one unit over daily limit."""
        config = BudgetConfig(max_per_day="5000000")
        tracker = BudgetTracker(config, MemoryBudgetStore())

        await tracker.record_spend("cardano:mainnet", "ADA", 3000000)

        # One over should be rejected
        with pytest.raises(BudgetExceededError):
            await tracker.check_budget("cardano:mainnet", "ADA", 2000001)

    async def test_zero_amount(self):
        """Test checking budget for zero amount."""
        config = BudgetConfig(max_per_request="1000000", max_per_day="5000000")
        tracker = BudgetTracker(config, MemoryBudgetStore())

        # Zero should always be allowed
        await tracker.check_budget("cardano:mainnet", "ADA", 0)

    async def test_no_limits_configured(self):
        """Test that no limits means all amounts are allowed."""
        config = BudgetConfig()  # No limits
        tracker = BudgetTracker(config, MemoryBudgetStore())

        # Any amount should be allowed
        await tracker.check_budget("cardano:mainnet", "ADA", 999999999999999)

    async def test_large_amounts(self):
        """Test handling of very large amounts."""
        config = BudgetConfig(
            max_per_request="999999999999999",
            max_per_day="9999999999999999",
        )
        tracker = BudgetTracker(config, MemoryBudgetStore())

        # Large amount under limit
        await tracker.check_budget("cardano:mainnet", "ADA", 999999999999998)

        # One over
        with pytest.raises(BudgetExceededError):
            await tracker.check_budget("cardano:mainnet", "ADA", 9999999999999999)
