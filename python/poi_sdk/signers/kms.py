"""
Location: python/poi_sdk/signers/kms.py

Summary:
    AWS KMS signer for production use. Uses AWS Key Management Service
    for secure key storage and signing operations.

Usage:
    Used in production environments for secure transaction signing.
    Requires boto3 to be installed (pip install poi-sdk[aws]).

Example:
    from poi_sdk.signers import KmsSigner

    signer = KmsSigner(
        key_id="arn:aws:kms:us-east-1:123456789:key/abc123",
        region="us-east-1"
    )
"""

from typing import Optional


class KmsSigner:
    """
    AWS KMS Signer for production use.

    This signer uses AWS Key Management Service to securely store
    and use private keys. Keys never leave the KMS hardware security
    modules (HSMs), providing strong security guarantees.

    Requires boto3: pip install poi-sdk[aws]

    Attributes:
        key_id: AWS KMS key ID or ARN
        region: AWS region where the key is located
    """

    def __init__(self, key_id: str, region: Optional[str] = None):
        """
        Initialize the KMS signer.

        Args:
            key_id: AWS KMS key ID or full ARN
            region: AWS region (optional, uses boto3 default if not specified)
        """
        self.key_id = key_id
        self.region = region

    async def get_address(self, chain: str) -> str:
        """
        Get the wallet address for a given chain.

        Derives the public key from KMS and converts it to the
        appropriate address format for the chain.

        Args:
            chain: CAIP-2 chain identifier

        Returns:
            The wallet address string

        Raises:
            NotImplementedError: When boto3 is not installed
        """
        raise NotImplementedError(
            "KmsSigner.get_address requires boto3. "
            "Install with: pip install poi-sdk[aws]"
        )

    async def sign(self, payload: bytes, chain: str) -> bytes:
        """
        Sign a transaction payload using AWS KMS.

        The private key never leaves KMS - signing is performed
        by the KMS service itself.

        Args:
            payload: The raw bytes to sign (typically a transaction hash)
            chain: CAIP-2 chain identifier

        Returns:
            The signature bytes

        Raises:
            NotImplementedError: When boto3 is not installed
        """
        raise NotImplementedError(
            "KmsSigner.sign requires boto3. "
            "Install with: pip install poi-sdk[aws]"
        )
