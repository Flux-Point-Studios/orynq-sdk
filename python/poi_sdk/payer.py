"""
Location: python/poi_sdk/payer.py

Summary:
    Defines the Payer and Signer protocols (interfaces) for payment handling.
    Also provides BasePayer abstract class for implementing custom payers.

Usage:
    Used by client.py to process payments. Implement the Payer protocol
    or extend BasePayer to create chain-specific payment implementations.

Example:
    from poi_sdk.payer import BasePayer, PaymentRequest, PaymentProof

    class CardanoPayer(BasePayer):
        supported_chains = ["cardano:mainnet", "cardano:preprod"]

        async def pay(self, request: PaymentRequest) -> PaymentProof:
            # Implementation here
            pass
"""

from abc import ABC, abstractmethod
from typing import Protocol, runtime_checkable

from .types import PaymentRequest, PaymentProof


@runtime_checkable
class Signer(Protocol):
    """
    Protocol for signing transaction payloads.

    Signers are responsible for:
    - Deriving addresses from keys
    - Signing transaction payloads

    Implementations include MemorySigner (dev) and KmsSigner (prod).
    """

    async def get_address(self, chain: str) -> str:
        """
        Get the wallet address for a given chain.

        Args:
            chain: CAIP-2 chain identifier

        Returns:
            The wallet address string
        """
        ...

    async def sign(self, payload: bytes, chain: str) -> bytes:
        """
        Sign a transaction payload.

        Args:
            payload: The raw bytes to sign
            chain: CAIP-2 chain identifier

        Returns:
            The signature bytes
        """
        ...


@runtime_checkable
class Payer(Protocol):
    """
    Protocol for executing payments.

    Payers handle the full payment flow:
    - Check if they support a payment request
    - Get wallet addresses
    - Execute payments and return proofs
    - Query balances
    """

    supported_chains: list[str]

    def supports(self, request: PaymentRequest) -> bool:
        """
        Check if this payer supports the given payment request.

        Args:
            request: The payment request to check

        Returns:
            True if this payer can handle the request
        """
        ...

    async def get_address(self, chain: str) -> str:
        """
        Get the wallet address for a given chain.

        Args:
            chain: CAIP-2 chain identifier

        Returns:
            The wallet address string
        """
        ...

    async def pay(self, request: PaymentRequest) -> PaymentProof:
        """
        Execute a payment and return proof.

        Args:
            request: The payment request to fulfill

        Returns:
            PaymentProof with transaction hash or signed CBOR

        Raises:
            PaymentError: If payment fails
        """
        ...

    async def get_balance(self, chain: str, asset: str) -> int:
        """
        Get the current balance for an asset.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier (e.g., "ADA", "USDC")

        Returns:
            Balance in smallest units as integer
        """
        ...


class BasePayer(ABC):
    """
    Abstract base class for payer implementations.

    Provides a default implementation of supports() based on
    the supported_chains list. Subclasses must implement
    get_address(), pay(), and get_balance().
    """

    supported_chains: list[str] = []

    def supports(self, request: PaymentRequest) -> bool:
        """
        Check if this payer supports the given payment request.

        Default implementation checks if request.chain is in supported_chains.

        Args:
            request: The payment request to check

        Returns:
            True if request.chain is in supported_chains
        """
        return request.chain in self.supported_chains

    @abstractmethod
    async def get_address(self, chain: str) -> str:
        """
        Get the wallet address for a given chain.

        Args:
            chain: CAIP-2 chain identifier

        Returns:
            The wallet address string
        """
        raise NotImplementedError

    @abstractmethod
    async def pay(self, request: PaymentRequest) -> PaymentProof:
        """
        Execute a payment and return proof.

        Args:
            request: The payment request to fulfill

        Returns:
            PaymentProof with transaction hash or signed CBOR
        """
        raise NotImplementedError

    @abstractmethod
    async def get_balance(self, chain: str, asset: str) -> int:
        """
        Get the current balance for an asset.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier (e.g., "ADA", "USDC")

        Returns:
            Balance in smallest units as integer
        """
        raise NotImplementedError


class PaymentError(Exception):
    """Exception raised when a payment fails."""
    pass


class UnsupportedChainError(PaymentError):
    """Exception raised when a chain is not supported by the payer."""
    pass


class InsufficientBalanceError(PaymentError):
    """Exception raised when wallet has insufficient balance."""
    pass
