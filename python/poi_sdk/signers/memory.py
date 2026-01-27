"""
Location: python/poi_sdk/signers/memory.py

Summary:
    Development-only in-memory signer. Stores keys in memory for testing
    and development purposes. NEVER use in production with real funds.

Usage:
    Used during development and testing to sign transactions without
    external key management. Real implementations require pycardano.

Example:
    from poi_sdk.signers import MemorySigner

    # WARNING: Development only!
    signer = MemorySigner("abandon abandon abandon...")
"""

import warnings


class MemorySigner:
    """
    Development-only signer that stores keys in memory.

    WARNING: Never use in production with real funds! This signer
    keeps private keys in memory which is insecure for production.

    For production use, see KmsSigner which uses AWS KMS for
    secure key management.

    Attributes:
        _key: The mnemonic phrase or private key (stored in memory)
    """

    def __init__(self, mnemonic_or_key: str):
        """
        Initialize the memory signer.

        Args:
            mnemonic_or_key: A BIP39 mnemonic phrase or raw private key

        Warns:
            UserWarning: Always warns that this is for development only
        """
        warnings.warn(
            "MemorySigner is for development only. Do not use with real funds!",
            UserWarning,
            stacklevel=2
        )
        self._key = mnemonic_or_key

    async def get_address(self, chain: str) -> str:
        """
        Get the wallet address for a given chain.

        This implementation requires pycardano for Cardano chains.

        Args:
            chain: CAIP-2 chain identifier

        Returns:
            The wallet address string

        Raises:
            NotImplementedError: When pycardano is not installed
        """
        raise NotImplementedError(
            "MemorySigner.get_address requires pycardano. "
            "Install with: pip install poi-sdk[cardano]"
        )

    async def sign(self, payload: bytes, chain: str) -> bytes:
        """
        Sign a transaction payload.

        This implementation requires pycardano for Cardano chains.

        Args:
            payload: The raw bytes to sign
            chain: CAIP-2 chain identifier

        Returns:
            The signature bytes

        Raises:
            NotImplementedError: When pycardano is not installed
        """
        raise NotImplementedError(
            "MemorySigner.sign requires pycardano. "
            "Install with: pip install poi-sdk[cardano]"
        )
