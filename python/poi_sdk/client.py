"""
Location: python/poi_sdk/client.py

Summary:
    Main PoiClient class for the poi-sdk. Provides auto-pay functionality
    for HTTP requests that return 402 Payment Required responses.

Usage:
    The primary entry point for using the SDK. Create a PoiClient with
    a payer implementation, then make requests that automatically handle
    payment when needed.

Example:
    from poi_sdk import PoiClient
    from poi_sdk.types import BudgetConfig

    client = PoiClient(
        base_url="https://api.example.com",
        payer=my_cardano_payer,
        partner="my_partner_id",
        budget=BudgetConfig(max_per_request="1000000", max_per_day="10000000")
    )

    # Auto-pay enabled request
    async with client:
        result = await client.request("/v1/inference", body={"prompt": "Hello"})
        print(result)
"""

import hashlib
import json
from typing import Any, AsyncIterator, Optional, TYPE_CHECKING

import httpx

from .types import PaymentRequest, PaymentProof, BudgetConfig
from .transport_flux import is_flux_402, parse_flux_invoice, apply_payment_headers
from .payer import Payer
from .budget import BudgetTracker, MemoryBudgetStore, BudgetExceededError, BudgetStore
from .invoice_cache import InvoiceCache, MemoryInvoiceCache
from .stream import parse_ndjson_stream


class PoiClient:
    """
    Main poi-sdk client with automatic payment handling.

    The PoiClient wraps HTTP requests and automatically handles
    402 Payment Required responses by:
    1. Parsing the payment request from the response
    2. Checking budget limits
    3. Checking invoice cache for already-paid invoices
    4. Executing the payment via the configured Payer
    5. Retrying the request with payment proof headers

    Attributes:
        base_url: Base URL for API requests
        payer: Payer implementation for executing payments
        partner: Optional partner ID for attribution
        timeout: Request timeout in seconds
        default_headers: Headers to include on all requests
    """

    def __init__(
        self,
        base_url: str,
        payer: Payer,
        partner: Optional[str] = None,
        budget: Optional[BudgetConfig] = None,
        budget_store: Optional[BudgetStore] = None,
        invoice_cache: Optional[InvoiceCache] = None,
        timeout: float = 120.0,
        headers: Optional[dict[str, str]] = None,
    ):
        """
        Initialize the PoiClient.

        Args:
            base_url: Base URL for API requests (trailing slash removed)
            payer: Payer implementation for executing payments
            partner: Optional partner identifier for attribution/tracking
            budget: Optional BudgetConfig for spending limits
            budget_store: Optional BudgetStore for persistence (uses memory by default)
            invoice_cache: Optional InvoiceCache for double-pay prevention (uses memory by default)
            timeout: Request timeout in seconds (default 120)
            headers: Optional default headers for all requests
        """
        self.base_url = base_url.rstrip("/")
        self.payer = payer
        self.partner = partner
        self.timeout = timeout
        self.default_headers = headers or {}

        # Initialize invoice cache
        self._invoice_cache = invoice_cache or MemoryInvoiceCache()

        # Initialize budget tracker if budget config provided
        self._budget_tracker: Optional[BudgetTracker] = None
        if budget:
            store = budget_store or MemoryBudgetStore()
            self._budget_tracker = BudgetTracker(budget, store)

        # Initialize HTTP client
        self._http = httpx.AsyncClient(timeout=timeout)

    async def close(self) -> None:
        """
        Close the HTTP client and release resources.

        Should be called when done with the client, or use
        the async context manager pattern.
        """
        await self._http.aclose()

    async def __aenter__(self) -> "PoiClient":
        """Enter async context manager."""
        return self

    async def __aexit__(self, *args) -> None:
        """Exit async context manager and close resources."""
        await self.close()

    async def request(
        self,
        endpoint: str,
        *,
        method: str = "POST",
        body: Optional[dict] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        """
        Make a request with automatic payment handling.

        If the server responds with 402 Payment Required (Flux protocol),
        this method will automatically:
        1. Parse the payment request
        2. Verify budget limits
        3. Execute the payment
        4. Retry the request with payment proof

        Args:
            endpoint: API endpoint path (will be appended to base_url)
            method: HTTP method (default POST)
            body: Optional JSON body for the request
            headers: Optional headers to add to this request

        Returns:
            Parsed JSON response from the server

        Raises:
            BudgetExceededError: If payment would exceed budget limits
            httpx.HTTPStatusError: If request fails after payment
            PaymentError: If payment execution fails
        """
        url = f"{self.base_url}{endpoint}"
        idempotency_key = self._generate_idempotency_key(method, url, body)

        # Check if we have a cached payment for this idempotency key
        cached_proof = await self._invoice_cache.get_by_idempotency_key(idempotency_key)

        # Build request headers
        req_headers = {**self.default_headers, **(headers or {})}
        req_headers["X-Idempotency-Key"] = idempotency_key

        # Make initial request
        response = await self._http.request(
            method,
            url,
            json=body,
            headers=req_headers,
        )

        # Handle 402 Payment Required (Flux protocol)
        if response.status_code == 402 and is_flux_402(response):
            invoice_data = response.json()
            payment_request = parse_flux_invoice(invoice_data)

            # Check if this invoice was already paid
            if payment_request.invoice_id:
                cached = await self._invoice_cache.get_paid(payment_request.invoice_id)
                if cached:
                    # Reuse cached proof
                    return await self._retry_with_payment(
                        method, url, body, req_headers, payment_request, cached
                    )

            # Check budget limits before paying
            if self._budget_tracker:
                amount = int(payment_request.amount_units)
                await self._budget_tracker.check_budget(
                    payment_request.chain,
                    payment_request.asset,
                    amount
                )

            # Execute payment
            proof = await self.payer.pay(payment_request)

            # Cache the payment proof
            if payment_request.invoice_id:
                await self._invoice_cache.set_paid(
                    payment_request.invoice_id,
                    proof,
                    idempotency_key
                )

            # Record spending for budget tracking
            if self._budget_tracker:
                await self._budget_tracker.record_spend(
                    payment_request.chain,
                    payment_request.asset,
                    int(payment_request.amount_units)
                )

            # Retry with payment proof
            return await self._retry_with_payment(
                method, url, body, req_headers, payment_request, proof
            )

        # Non-402 response - check for errors and return
        response.raise_for_status()
        return response.json()

    async def stream(
        self,
        endpoint: str,
        *,
        method: str = "POST",
        body: Optional[dict] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> AsyncIterator[dict]:
        """
        Make a streaming request with automatic payment handling.

        Similar to request(), but returns an async iterator for
        streaming NDJSON responses.

        Args:
            endpoint: API endpoint path
            method: HTTP method (default POST)
            body: Optional JSON body
            headers: Optional headers

        Yields:
            Parsed JSON objects from the NDJSON stream

        Raises:
            BudgetExceededError: If payment would exceed budget limits
            httpx.HTTPStatusError: If request fails
            PaymentError: If payment execution fails
        """
        url = f"{self.base_url}{endpoint}"
        req_headers = {**self.default_headers, **(headers or {})}

        async with self._http.stream(method, url, json=body, headers=req_headers) as response:
            if response.status_code == 402:
                # Read full body for payment info (can't stream a 402)
                body_bytes = await response.aread()
                invoice_data = json.loads(body_bytes)
                payment_request = parse_flux_invoice(invoice_data)

                # Check budget
                if self._budget_tracker:
                    amount = int(payment_request.amount_units)
                    await self._budget_tracker.check_budget(
                        payment_request.chain,
                        payment_request.asset,
                        amount
                    )

                # Execute payment
                proof = await self.payer.pay(payment_request)

                # Cache payment
                if payment_request.invoice_id:
                    await self._invoice_cache.set_paid(
                        payment_request.invoice_id,
                        proof
                    )

                # Record spending
                if self._budget_tracker:
                    await self._budget_tracker.record_spend(
                        payment_request.chain,
                        payment_request.asset,
                        int(payment_request.amount_units)
                    )

                # Apply payment headers and retry
                req_headers = apply_payment_headers(
                    req_headers,
                    payment_request.invoice_id or "",
                    proof,
                    partner=self.partner,
                )

                # Make new streaming request with payment
                async with self._http.stream(method, url, json=body, headers=req_headers) as retry_resp:
                    retry_resp.raise_for_status()
                    async for chunk in parse_ndjson_stream(retry_resp):
                        yield chunk
            else:
                response.raise_for_status()
                async for chunk in parse_ndjson_stream(response):
                    yield chunk

    async def get_wallet_address(self, chain: str) -> str:
        """
        Get the wallet address for a specific chain.

        Convenience method to access the payer's address.

        Args:
            chain: CAIP-2 chain identifier

        Returns:
            Wallet address string
        """
        return await self.payer.get_address(chain)

    async def get_balance(self, chain: str, asset: str) -> int:
        """
        Get the current balance for an asset.

        Convenience method to access the payer's balance.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier

        Returns:
            Balance in smallest units
        """
        return await self.payer.get_balance(chain, asset)

    async def get_remaining_budget(self, chain: str, asset: str) -> Optional[int]:
        """
        Get the remaining daily budget for an asset.

        Args:
            chain: CAIP-2 chain identifier
            asset: Asset identifier

        Returns:
            Remaining budget in smallest units, or None if no budget configured
        """
        if not self._budget_tracker:
            return None
        return await self._budget_tracker.get_remaining_budget(chain, asset)

    async def _retry_with_payment(
        self,
        method: str,
        url: str,
        body: Optional[dict],
        headers: dict[str, str],
        request: PaymentRequest,
        proof: PaymentProof,
    ) -> Any:
        """
        Retry a request with payment proof headers.

        Args:
            method: HTTP method
            url: Full URL
            body: Request body
            headers: Base headers
            request: The payment request that was fulfilled
            proof: Payment proof to include

        Returns:
            Parsed JSON response
        """
        headers = apply_payment_headers(
            headers,
            request.invoice_id or "",
            proof,
            partner=self.partner,
        )

        response = await self._http.request(method, url, json=body, headers=headers)
        response.raise_for_status()
        return response.json()

    def _generate_idempotency_key(
        self,
        method: str,
        url: str,
        body: Optional[dict]
    ) -> str:
        """
        Generate a deterministic idempotency key from request parameters.

        The key is a SHA-256 hash of the method, URL, and body,
        truncated to 32 characters.

        Args:
            method: HTTP method
            url: Full URL
            body: Request body (will be JSON serialized)

        Returns:
            32-character hex string
        """
        data = json.dumps({"method": method, "url": url, "body": body}, sort_keys=True)
        return hashlib.sha256(data.encode()).hexdigest()[:32]


# Re-export BudgetExceededError for convenience
__all__ = ["PoiClient", "BudgetExceededError"]
