"""
Location: python/poi_sdk/invoice_cache.py

Summary:
    Invoice caching to prevent double-payment. Stores payment proofs
    by invoice ID and idempotency key for replay protection.

Usage:
    Used by client.py to check if an invoice has already been paid
    before initiating a new payment, preventing accidental double-pay.

Example:
    from poi_sdk.invoice_cache import MemoryInvoiceCache

    cache = MemoryInvoiceCache()

    # Check if already paid
    proof = await cache.get_paid("inv_123")
    if proof:
        # Reuse existing proof
        pass
    else:
        # Make payment and cache
        await cache.set_paid("inv_123", proof, idempotency_key="req_abc")
"""

from typing import Optional, Protocol

from .types import PaymentProof


class InvoiceCache(Protocol):
    """
    Protocol for invoice payment caching.

    Implementations store payment proofs to enable:
    - Checking if an invoice was already paid
    - Retrieving proofs by idempotency key for retries

    The default MemoryInvoiceCache is suitable for single-process
    deployments. Distributed systems should use Redis or similar.
    """

    async def get_paid(self, invoice_id: str) -> Optional[PaymentProof]:
        """
        Get the payment proof for an invoice if it was paid.

        Args:
            invoice_id: The invoice identifier

        Returns:
            PaymentProof if the invoice was paid, None otherwise
        """
        ...

    async def set_paid(self, invoice_id: str, proof: PaymentProof) -> None:
        """
        Record that an invoice was paid.

        Args:
            invoice_id: The invoice identifier
            proof: The payment proof
        """
        ...

    async def get_by_idempotency_key(self, key: str) -> Optional[PaymentProof]:
        """
        Get the payment proof for an idempotency key.

        Args:
            key: The idempotency key

        Returns:
            PaymentProof if a payment was made with this key, None otherwise
        """
        ...


class MemoryInvoiceCache:
    """
    In-memory invoice cache for development and single-process deployments.

    WARNING: Data is lost when the process restarts, and is not shared
    across multiple processes. Use Redis or a database for production
    distributed deployments.

    Attributes:
        _by_invoice: Mapping of invoice_id to PaymentProof
        _by_key: Mapping of idempotency_key to PaymentProof
    """

    def __init__(self):
        """Initialize empty cache dictionaries."""
        self._by_invoice: dict[str, PaymentProof] = {}
        self._by_key: dict[str, PaymentProof] = {}

    async def get_paid(self, invoice_id: str) -> Optional[PaymentProof]:
        """
        Get the payment proof for an invoice if it was paid.

        Args:
            invoice_id: The invoice identifier

        Returns:
            PaymentProof if the invoice was paid, None otherwise
        """
        return self._by_invoice.get(invoice_id)

    async def set_paid(
        self,
        invoice_id: str,
        proof: PaymentProof,
        idempotency_key: Optional[str] = None
    ) -> None:
        """
        Record that an invoice was paid.

        Args:
            invoice_id: The invoice identifier
            proof: The payment proof
            idempotency_key: Optional idempotency key to also index by
        """
        self._by_invoice[invoice_id] = proof
        if idempotency_key:
            self._by_key[idempotency_key] = proof

    async def get_by_idempotency_key(self, key: str) -> Optional[PaymentProof]:
        """
        Get the payment proof for an idempotency key.

        Args:
            key: The idempotency key

        Returns:
            PaymentProof if a payment was made with this key, None otherwise
        """
        return self._by_key.get(key)

    async def clear(self) -> None:
        """
        Clear all cached payments.

        Useful for testing or cache invalidation.
        """
        self._by_invoice.clear()
        self._by_key.clear()

    def __len__(self) -> int:
        """Return the number of cached invoices."""
        return len(self._by_invoice)
