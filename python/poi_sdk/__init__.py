"""
Location: python/poi_sdk/__init__.py

Summary:
    Main package initialization for poi-sdk. Exports all public classes
    and functions for convenient importing.

Usage:
    from poi_sdk import PoiClient, PaymentRequest, BudgetConfig

    # Or import specific modules
    from poi_sdk.signers import MemorySigner, KmsSigner
    from poi_sdk.budget import BudgetTracker, MemoryBudgetStore

Version: 0.1.0 (Flux protocol only - v1)
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

__version__ = "0.1.0"

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
]
