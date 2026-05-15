"""
Location: python/orynq_sdk/__init__.py

Summary:
    Main package initialization for orynq-sdk. Exports all public classes
    and functions for convenient importing.

Usage:
    # Solo-dev quickstart (new in v0.2.0)
    from orynq_sdk import trace, quickstart
    run = trace.create_trace(agent_id="my-agent")
    span = trace.add_span(run, name="hello", visibility="public")
    trace.add_event(run, span.id, kind="observation",
                    observation="hi", visibility="public")
    trace.close_span(run, span.id)
    bundle = trace.finalize_trace(run)
    print(bundle.root_hash, bundle.merkle_root)

    # Payment client (v0.1.x feature, unchanged)
    from orynq_sdk import PoiClient, PaymentRequest, BudgetConfig

Version: 0.2.0 — adds `orynq_sdk.trace` (cryptographic process tracing) and
`orynq_sdk.quickstart` (solo-dev DX helpers + `orynq` CLI).
"""

from .client import PoiClient
from .types import (
    PaymentRequest,
    PaymentProof,
    PaymentStatus,
    BudgetConfig,
    SplitConfig,
    SplitOutput,
)
from .payer import (
    Payer,
    Signer,
    BasePayer,
    PaymentError,
    UnsupportedChainError,
    InsufficientBalanceError,
)
from .budget import BudgetTracker, MemoryBudgetStore, BudgetExceededError
from .invoice_cache import InvoiceCache, MemoryInvoiceCache
from .transport_flux import FLUX_HEADERS, is_flux_402, parse_flux_invoice

# New in 0.2.0 — pure-Python trace primitives. Lazy-importable from
# `orynq_sdk.trace` so the SDK install footprint stays tiny when callers
# only need the payment client. Quickstart helpers (`orynq_sdk.quickstart`)
# also live alongside but are imported on-demand so substrate-interface
# is not pulled in unless someone actually calls into them.
from . import trace  # noqa: F401  (re-export module)

__version__ = "0.2.0"

__all__ = [
    # Main client
    "PoiClient",
    # Types
    "PaymentRequest",
    "PaymentProof",
    "PaymentStatus",
    "BudgetConfig",
    "SplitConfig",
    "SplitOutput",
    # Payer protocol and base class
    "Payer",
    "Signer",
    "BasePayer",
    # Exceptions
    "PaymentError",
    "UnsupportedChainError",
    "InsufficientBalanceError",
    "BudgetExceededError",
    # Budget tracking
    "BudgetTracker",
    "MemoryBudgetStore",
    # Invoice caching
    "InvoiceCache",
    "MemoryInvoiceCache",
    # Transport utilities
    "FLUX_HEADERS",
    "is_flux_402",
    "parse_flux_invoice",
    # New in 0.2.0
    "trace",
]
