"""
Tests for poi_sdk.invoice_cache module.

Tests invoice payment caching to prevent double-payments and
support idempotency key lookups.
"""

import pytest

from poi_sdk.invoice_cache import MemoryInvoiceCache
from poi_sdk.types import PaymentProof


class TestMemoryInvoiceCache:
    """Tests for MemoryInvoiceCache class."""

    @pytest.fixture
    def cache(self):
        """Create a fresh MemoryInvoiceCache for each test."""
        return MemoryInvoiceCache()

    @pytest.fixture
    def cardano_proof(self):
        """Sample Cardano payment proof."""
        return PaymentProof(
            kind="cardano-txhash",
            tx_hash="abc123def456789012345678901234567890123456789012345678901234"
        )

    @pytest.fixture
    def evm_proof(self):
        """Sample EVM payment proof."""
        return PaymentProof(
            kind="evm-txhash",
            tx_hash="0x123abc456def789012345678901234567890123456789012345678901234abcd"
        )

    async def test_returns_none_for_unpaid(self, cache):
        """Test that get_paid returns None for unknown invoices."""
        result = await cache.get_paid("inv_unknown")
        assert result is None

    async def test_stores_and_retrieves_proof(self, cache, cardano_proof):
        """Test storing and retrieving a payment proof."""
        await cache.set_paid("inv_123", cardano_proof)
        result = await cache.get_paid("inv_123")

        assert result is not None
        assert result.kind == "cardano-txhash"
        assert result.tx_hash == cardano_proof.tx_hash

    async def test_multiple_invoices(self, cache, cardano_proof, evm_proof):
        """Test storing multiple different invoices."""
        await cache.set_paid("inv_cardano", cardano_proof)
        await cache.set_paid("inv_evm", evm_proof)

        cardano_result = await cache.get_paid("inv_cardano")
        evm_result = await cache.get_paid("inv_evm")

        assert cardano_result.kind == "cardano-txhash"
        assert evm_result.kind == "evm-txhash"

    async def test_overwrites_existing_invoice(self, cache, cardano_proof, evm_proof):
        """Test that setting a paid invoice again overwrites the proof."""
        await cache.set_paid("inv_123", cardano_proof)
        await cache.set_paid("inv_123", evm_proof)

        result = await cache.get_paid("inv_123")
        assert result.kind == "evm-txhash"

    async def test_idempotency_key_lookup(self, cache, cardano_proof):
        """Test looking up payment by idempotency key."""
        await cache.set_paid("inv_123", cardano_proof, idempotency_key="key_abc")
        result = await cache.get_by_idempotency_key("key_abc")

        assert result is not None
        assert result.tx_hash == cardano_proof.tx_hash

    async def test_idempotency_key_not_found(self, cache):
        """Test that unknown idempotency keys return None."""
        result = await cache.get_by_idempotency_key("unknown_key")
        assert result is None

    async def test_idempotency_key_without_invoice(self, cache, cardano_proof):
        """Test that proofs stored without idempotency key are not found by key."""
        await cache.set_paid("inv_123", cardano_proof)  # No idempotency key

        result = await cache.get_by_idempotency_key("any_key")
        assert result is None

    async def test_multiple_idempotency_keys(self, cache, cardano_proof, evm_proof):
        """Test storing multiple idempotency keys."""
        await cache.set_paid("inv_1", cardano_proof, idempotency_key="key_1")
        await cache.set_paid("inv_2", evm_proof, idempotency_key="key_2")

        result_1 = await cache.get_by_idempotency_key("key_1")
        result_2 = await cache.get_by_idempotency_key("key_2")

        assert result_1.kind == "cardano-txhash"
        assert result_2.kind == "evm-txhash"

    async def test_same_proof_different_keys(self, cache, cardano_proof):
        """Test storing the same proof with different invoice/idempotency keys."""
        await cache.set_paid("inv_1", cardano_proof, idempotency_key="key_1")
        await cache.set_paid("inv_2", cardano_proof, idempotency_key="key_2")

        # Both should return the same proof
        result_inv_1 = await cache.get_paid("inv_1")
        result_inv_2 = await cache.get_paid("inv_2")
        result_key_1 = await cache.get_by_idempotency_key("key_1")
        result_key_2 = await cache.get_by_idempotency_key("key_2")

        assert result_inv_1.tx_hash == cardano_proof.tx_hash
        assert result_inv_2.tx_hash == cardano_proof.tx_hash
        assert result_key_1.tx_hash == cardano_proof.tx_hash
        assert result_key_2.tx_hash == cardano_proof.tx_hash

    async def test_clear(self, cache, cardano_proof):
        """Test clearing all cached payments."""
        await cache.set_paid("inv_1", cardano_proof, idempotency_key="key_1")
        await cache.set_paid("inv_2", cardano_proof, idempotency_key="key_2")

        await cache.clear()

        # All should be gone
        assert await cache.get_paid("inv_1") is None
        assert await cache.get_paid("inv_2") is None
        assert await cache.get_by_idempotency_key("key_1") is None
        assert await cache.get_by_idempotency_key("key_2") is None

    async def test_len(self, cache, cardano_proof, evm_proof):
        """Test __len__ returns number of cached invoices."""
        assert len(cache) == 0

        await cache.set_paid("inv_1", cardano_proof)
        assert len(cache) == 1

        await cache.set_paid("inv_2", evm_proof)
        assert len(cache) == 2

        await cache.clear()
        assert len(cache) == 0

    async def test_len_counts_invoices_not_keys(self, cache, cardano_proof):
        """Test that len counts invoices, not idempotency keys."""
        await cache.set_paid("inv_1", cardano_proof, idempotency_key="key_1")

        # Only 1 invoice, even though there's also an idempotency key
        assert len(cache) == 1


class TestInvoiceCacheEdgeCases:
    """Test edge cases and boundary conditions."""

    @pytest.fixture
    def cache(self):
        """Create a fresh cache for each test."""
        return MemoryInvoiceCache()

    async def test_empty_invoice_id(self, cache):
        """Test handling empty invoice ID."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        await cache.set_paid("", proof)

        result = await cache.get_paid("")
        assert result is not None
        assert result.tx_hash == "abc123"

    async def test_empty_idempotency_key(self, cache):
        """Test handling empty idempotency key (treated as falsy, so not stored)."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        # Empty string is falsy in Python, so it won't be stored as idempotency key
        await cache.set_paid("inv_1", proof, idempotency_key="")

        # Empty string won't be found because it wasn't stored (empty is falsy)
        result = await cache.get_by_idempotency_key("")
        # The implementation checks `if idempotency_key:` which is falsy for ""
        assert result is None

        # But the invoice itself should still be stored
        invoice_result = await cache.get_paid("inv_1")
        assert invoice_result is not None

    async def test_special_characters_in_invoice_id(self, cache):
        """Test handling special characters in invoice ID."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        special_id = "inv_!@#$%^&*()_+-=[]{}|;':\",./<>?"

        await cache.set_paid(special_id, proof)
        result = await cache.get_paid(special_id)

        assert result is not None
        assert result.tx_hash == "abc123"

    async def test_unicode_in_invoice_id(self, cache):
        """Test handling unicode characters in invoice ID."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        unicode_id = "inv_emoji_test"

        await cache.set_paid(unicode_id, proof)
        result = await cache.get_paid(unicode_id)

        assert result is not None

    async def test_very_long_invoice_id(self, cache):
        """Test handling very long invoice ID."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        long_id = "inv_" + "x" * 10000

        await cache.set_paid(long_id, proof)
        result = await cache.get_paid(long_id)

        assert result is not None

    async def test_proof_with_cbor_hex(self, cache):
        """Test caching proof with CBOR hex instead of tx hash."""
        proof = PaymentProof(kind="cardano-signed-cbor", cbor_hex="84a4...")

        await cache.set_paid("inv_cbor", proof)
        result = await cache.get_paid("inv_cbor")

        assert result is not None
        assert result.kind == "cardano-signed-cbor"
        assert result.cbor_hex == "84a4..."

    async def test_concurrent_operations(self, cache):
        """Test that concurrent operations work correctly."""
        import asyncio

        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")

        # Simulate concurrent writes
        async def write_invoice(i):
            await cache.set_paid(f"inv_{i}", proof, idempotency_key=f"key_{i}")

        await asyncio.gather(*[write_invoice(i) for i in range(100)])

        # All should be stored
        for i in range(100):
            result = await cache.get_paid(f"inv_{i}")
            assert result is not None
            key_result = await cache.get_by_idempotency_key(f"key_{i}")
            assert key_result is not None

        assert len(cache) == 100


class TestInvoiceCacheProtocol:
    """Tests to verify the cache conforms to the InvoiceCache protocol."""

    def test_has_get_paid_method(self):
        """Test that MemoryInvoiceCache has get_paid method."""
        cache = MemoryInvoiceCache()
        assert hasattr(cache, "get_paid")
        assert callable(cache.get_paid)

    def test_has_set_paid_method(self):
        """Test that MemoryInvoiceCache has set_paid method."""
        cache = MemoryInvoiceCache()
        assert hasattr(cache, "set_paid")
        assert callable(cache.set_paid)

    def test_has_get_by_idempotency_key_method(self):
        """Test that MemoryInvoiceCache has get_by_idempotency_key method."""
        cache = MemoryInvoiceCache()
        assert hasattr(cache, "get_by_idempotency_key")
        assert callable(cache.get_by_idempotency_key)
