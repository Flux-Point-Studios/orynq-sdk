#!/usr/bin/env python3
"""
Verify Python implementation matches test vectors.
Run with: python scripts/verify-hash-vectors.py

This script validates that the Python canonical JSON and SHA256
implementations produce outputs that match the test vectors.

IMPORTANT: This is a RELEASE GATE requirement. This script must pass
before any release.
"""
import json
import hashlib
import sys
from pathlib import Path
from typing import Any, Dict, List, Union


def sort_keys_recursive(obj: Any) -> Any:
    """
    Recursively sort dictionary keys and remove null values.

    This matches the TypeScript canonicalize() function behavior:
    - Sort object keys lexicographically
    - Remove null values from objects
    - Preserve array order
    - Recursively process nested structures

    Args:
        obj: Any JSON-compatible value

    Returns:
        Normalized value with sorted keys and nulls removed
    """
    if isinstance(obj, dict):
        return {
            k: sort_keys_recursive(v)
            for k, v in sorted(obj.items())
            if v is not None
        }
    elif isinstance(obj, list):
        return [sort_keys_recursive(item) for item in obj]
    else:
        return obj


def canonical_json(obj: Any) -> str:
    """
    RFC 8785 (JCS) canonicalization with null removal.

    This produces a deterministic JSON string that matches the TypeScript
    implementation:
    - Sort keys lexicographically
    - Remove null values
    - No extra whitespace
    - UTF-8 encoding (ensure_ascii=False)

    Args:
        obj: Any JSON-compatible value

    Returns:
        Canonical JSON string
    """
    sorted_obj = sort_keys_recursive(obj)
    return json.dumps(sorted_obj, separators=(',', ':'), ensure_ascii=False)


def sha256_hash(data: str) -> str:
    """
    SHA256 hash of string, returns hex.

    Args:
        data: String to hash (will be UTF-8 encoded)

    Returns:
        Lowercase hex string of the SHA256 hash
    """
    return hashlib.sha256(data.encode('utf-8')).hexdigest()


def main() -> int:
    """
    Main verification function.

    Returns:
        0 if all vectors pass, 1 if any fail
    """
    fixtures_path = Path(__file__).parent.parent / 'fixtures' / 'hash-vectors.json'

    if not fixtures_path.exists():
        print(f'ERROR: Fixtures file not found at {fixtures_path}')
        print('Run "npx tsx scripts/generate-hash-vectors.ts" first.')
        return 1

    with open(fixtures_path, encoding='utf-8') as f:
        data = json.load(f)

    passed = 0
    failed = 0

    print('Verifying Python implementation against test vectors...\n')

    for vector in data['vectors']:
        name = vector['name']
        input_obj = vector['input']
        expected_canonical = vector['canonical']
        expected_hash = vector['sha256']

        actual_canonical = canonical_json(input_obj)
        actual_hash = sha256_hash(actual_canonical)

        canonical_match = actual_canonical == expected_canonical
        hash_match = actual_hash == expected_hash

        if canonical_match and hash_match:
            print(f'[PASS] {name}')
            passed += 1
        else:
            print(f'[FAIL] {name}')
            if not canonical_match:
                print(f'   Canonical mismatch:')
                print(f'     Expected: {expected_canonical}')
                print(f'     Actual:   {actual_canonical}')
            if not hash_match:
                print(f'   Hash mismatch:')
                print(f'     Expected: {expected_hash}')
                print(f'     Actual:   {actual_hash}')
            failed += 1

    print(f'\n{"=" * 50}')
    print(f'Results: {passed} passed, {failed} failed')

    if failed > 0:
        print('\nVERIFICATION FAILED - Release gate not passed!')
        return 1

    print('\nVERIFICATION PASSED - Python implementation is correct.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
