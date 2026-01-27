"""
Location: python/poi_sdk/budget.py

Summary:
    Budget tracking and enforcement for payments. Provides rate limiting
    based on per-request and daily spending limits.

Usage:
    Used by client.py to enforce spending limits before approving payments.
    Implements both the BudgetStore protocol and a memory-based store.

Example:
    from poi_sdk.budget import BudgetTracker, MemoryBudgetStore
    from poi_sdk.types import BudgetConfig

    config = BudgetConfig(max_per_request="1000000", max_per_day="10000000")
    tracker = BudgetTracker(config, MemoryBudgetStore())

    await tracker.check_budget("cardano:mainnet", "ADA", 500000)
"""

from datetime import datetime, timedelta, timezone
from typing import Optional, Protocol

from .types import BudgetConfig


class BudgetStore(Protocol):
    """
    Protocol for budget data persistence.

    Implementations store and retrieve spending data.
    The default MemoryBudgetStore is suitable for development,
    while production deployments should use a persistent store
    (Redis, database, etc.).
    """

    async def get_spent(self, chain: str, asset: str, day: str) -> int:
        """
        Get the total amount spent for a chain/asset on a specific day.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier
            day: Day key in YYYY-MM-DD format

        Returns:
            Total spent in smallest units
        """
        ...

    async def record_spend(self, chain: str, asset: str, amount: int) -> None:
        """
        Record a spending transaction.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier
            amount: Amount spent in smallest units
        """
        ...

    async def reset(self, chain: str, asset: str) -> None:
        """
        Reset spending for a chain/asset (for current day).

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier
        """
        ...


class MemoryBudgetStore:
    """
    In-memory budget store for development and testing.

    WARNING: Data is lost when the process restarts.
    Use a persistent store for production.
    """

    def __init__(self):
        """Initialize an empty spending record."""
        self._spent: dict[str, int] = {}

    async def get_spent(self, chain: str, asset: str, day: str) -> int:
        """
        Get the total amount spent for a chain/asset on a specific day.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier
            day: Day key in YYYY-MM-DD format

        Returns:
            Total spent in smallest units, 0 if no record
        """
        key = f"{chain}:{asset}:{day}"
        return self._spent.get(key, 0)

    async def record_spend(self, chain: str, asset: str, amount: int) -> None:
        """
        Record a spending transaction.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier
            amount: Amount spent in smallest units
        """
        day = self._get_today()
        key = f"{chain}:{asset}:{day}"
        self._spent[key] = self._spent.get(key, 0) + amount

    async def reset(self, chain: str, asset: str) -> None:
        """
        Reset spending for a chain/asset (for current day).

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier
        """
        day = self._get_today()
        key = f"{chain}:{asset}:{day}"
        self._spent.pop(key, None)

    def _get_today(self) -> str:
        """Get today's date key in YYYY-MM-DD format."""
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class BudgetTracker:
    """
    Budget enforcement for payments.

    Tracks spending against configured limits and raises
    BudgetExceededError when limits would be exceeded.

    Attributes:
        config: Budget configuration with limits
        store: Persistent storage for spending data
    """

    def __init__(self, config: BudgetConfig, store: BudgetStore):
        """
        Initialize the budget tracker.

        Args:
            config: BudgetConfig with spending limits
            store: BudgetStore implementation for persistence
        """
        self.config = config
        self.store = store

    async def check_budget(self, chain: str, asset: str, amount: int) -> None:
        """
        Check if a payment is within budget limits.

        Validates against both per-request and daily limits.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier
            amount: Proposed spending amount in smallest units

        Raises:
            BudgetExceededError: If the payment would exceed limits
        """
        # Check per-request limit
        if self.config.max_per_request:
            max_per_req = int(self.config.max_per_request)
            if amount > max_per_req:
                raise BudgetExceededError(
                    f"Amount {amount} exceeds per-request limit {max_per_req}"
                )

        # Check daily limit
        if self.config.max_per_day:
            max_per_day = int(self.config.max_per_day)
            day = self._get_day_key()
            spent = await self.store.get_spent(chain, asset, day)
            if spent + amount > max_per_day:
                raise BudgetExceededError(
                    f"Would exceed daily limit. Spent: {spent}, Request: {amount}, Limit: {max_per_day}"
                )

    async def record_spend(self, chain: str, asset: str, amount: int) -> None:
        """
        Record a completed payment.

        Call this after a successful payment to update spending totals.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier
            amount: Amount spent in smallest units
        """
        await self.store.record_spend(chain, asset, amount)

    async def get_remaining_budget(self, chain: str, asset: str) -> Optional[int]:
        """
        Get remaining daily budget for a chain/asset.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier

        Returns:
            Remaining budget in smallest units, or None if no daily limit
        """
        if not self.config.max_per_day:
            return None

        max_per_day = int(self.config.max_per_day)
        day = self._get_day_key()
        spent = await self.store.get_spent(chain, asset, day)
        return max(0, max_per_day - spent)

    def _get_day_key(self) -> str:
        """
        Get the day key for budget tracking.

        Respects the daily_reset_hour configuration - if the current
        hour is before the reset hour, uses the previous day's key.

        Returns:
            Day key in YYYY-MM-DD format
        """
        now = datetime.now(timezone.utc)
        if now.hour < self.config.daily_reset_hour:
            # Use previous day if before reset hour
            now = now - timedelta(days=1)
        return now.strftime("%Y-%m-%d")


class BudgetExceededError(Exception):
    """
    Exception raised when a payment would exceed budget limits.

    Attributes:
        message: Description of which limit was exceeded
    """
    pass
