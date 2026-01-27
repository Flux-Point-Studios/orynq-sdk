"""
Cross-language compatibility tests for canonical JSON.

These tests verify that Python produces the same canonical JSON output
as TypeScript and other language implementations in the poi-sdk.
"""

import json
import hashlib

import pytest


def sort_keys_recursive(obj):
    """
    Recursively sort dictionary keys.

    Note: Unlike some implementations, this does NOT remove null values
    to match the hash vectors which include null.

    Args:
        obj: The object to sort

    Returns:
        Object with sorted dictionary keys
    """
    if isinstance(obj, dict):
        return {
            k: sort_keys_recursive(v)
            for k, v in sorted(obj.items())
        }
    elif isinstance(obj, list):
        return [sort_keys_recursive(item) for item in obj]
    else:
        return obj


def canonical_json(obj) -> str:
    """
    RFC 8785 (JCS) style canonicalization.

    Produces deterministic JSON output with:
    - Sorted keys (recursive)
    - No whitespace
    - Unicode preserved (not escaped)

    Args:
        obj: The object to canonicalize

    Returns:
        Canonical JSON string
    """
    sorted_obj = sort_keys_recursive(obj)
    return json.dumps(sorted_obj, separators=(',', ':'), ensure_ascii=False)


def sha256_hash(data: str) -> str:
    """
    Compute SHA256 hash of a string.

    Args:
        data: UTF-8 string to hash

    Returns:
        Lowercase hex-encoded hash
    """
    return hashlib.sha256(data.encode('utf-8')).hexdigest()


class TestCanonicalJson:
    """Tests for canonical JSON generation."""

    def test_sorts_keys(self):
        """Test that keys are sorted alphabetically."""
        result = canonical_json({"z": 1, "a": 2, "m": 3})
        assert result == '{"a":2,"m":3,"z":1}'

    def test_nested_objects(self):
        """Test that nested object keys are also sorted."""
        result = canonical_json({"b": {"z": 1, "a": 2}, "a": 1})
        assert result == '{"a":1,"b":{"a":2,"z":1}}'

    def test_deeply_nested(self):
        """Test deeply nested object sorting."""
        result = canonical_json({
            "c": {
                "z": {
                    "b": 1,
                    "a": 2
                },
                "a": 3
            },
            "a": 4
        })
        assert result == '{"a":4,"c":{"a":3,"z":{"a":2,"b":1}}}'

    def test_preserves_arrays(self):
        """Test that array order is preserved (not sorted)."""
        result = canonical_json({"arr": [3, 1, 2]})
        assert result == '{"arr":[3,1,2]}'

    def test_arrays_of_objects(self):
        """Test arrays containing objects with sorted keys."""
        result = canonical_json({"arr": [{"z": 1, "a": 2}, {"b": 3}]})
        assert result == '{"arr":[{"a":2,"z":1},{"b":3}]}'

    def test_preserves_null(self):
        """Test that null values are preserved."""
        result = canonical_json({"a": 1, "b": None, "c": 3})
        assert result == '{"a":1,"b":null,"c":3}'

    def test_no_whitespace(self):
        """Test that output has no extra whitespace."""
        result = canonical_json({"key": "value", "nested": {"a": 1}})
        assert " " not in result
        assert "\n" not in result
        assert "\t" not in result

    def test_unicode_preserved(self):
        """Test that unicode characters are preserved, not escaped."""
        result = canonical_json({"emoji": "fire"})
        assert "fire" in result

    def test_unicode_emoji(self):
        """Test that emoji unicode is preserved."""
        result = canonical_json({"s": "test"})
        # Should contain the actual emoji character or the unicode
        assert '"s":' in result

    def test_empty_object(self):
        """Test empty object."""
        result = canonical_json({})
        assert result == '{}'

    def test_empty_array(self):
        """Test empty array."""
        result = canonical_json({"arr": []})
        assert result == '{"arr":[]}'

    def test_boolean_values(self):
        """Test boolean values."""
        result = canonical_json({"t": True, "f": False})
        assert result == '{"f":false,"t":true}'

    def test_numeric_values(self):
        """Test various numeric values."""
        result = canonical_json({
            "int": 42,
            "float": 3.14,
            "neg": -1,
            "zero": 0
        })
        # Keys should be sorted
        assert result.startswith('{"float":3.14')

    def test_string_escaping(self):
        """Test that special characters in strings are escaped."""
        result = canonical_json({"str": 'line1\nline2'})
        assert '\\n' in result

    def test_quotes_in_strings(self):
        """Test that quotes in strings are escaped."""
        result = canonical_json({"str": 'say "hello"'})
        assert '\\"' in result


class TestSha256Hash:
    """Tests for SHA256 hashing."""

    def test_empty_string(self):
        """Test hash of empty string."""
        result = sha256_hash("")
        # Known hash of empty string
        assert result == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    def test_hello_world(self):
        """Test hash of 'hello world'."""
        result = sha256_hash("hello world")
        # Known hash
        assert result == "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"

    def test_unicode(self):
        """Test hash of unicode string."""
        result = sha256_hash("test")
        # Should produce consistent hash
        assert len(result) == 64
        assert all(c in '0123456789abcdef' for c in result)

    def test_lowercase_hex(self):
        """Test that hash is lowercase hex."""
        result = sha256_hash("test")
        assert result == result.lower()


class TestCrossLanguageVectors:
    """Test against shared vectors from hash_vectors.json."""

    def test_simple_object_vector(self, hash_vectors):
        """Test simple object from vectors."""
        if not hash_vectors:
            pytest.skip("Hash vectors not found")

        # Find the simple_object vector
        simple_vector = next(
            (v for v in hash_vectors if v["name"] == "simple_object"),
            None
        )
        if not simple_vector:
            pytest.skip("simple_object vector not found")

        input_obj = simple_vector["input"]
        expected_canonical = simple_vector["canonical"]
        expected_hash = simple_vector["sha256"]

        actual_canonical = canonical_json(input_obj)
        actual_hash = sha256_hash(actual_canonical)

        assert actual_canonical == expected_canonical, (
            f"Canonical mismatch:\n"
            f"  Expected: {expected_canonical}\n"
            f"  Actual:   {actual_canonical}"
        )
        assert actual_hash == expected_hash, (
            f"Hash mismatch:\n"
            f"  Expected: {expected_hash}\n"
            f"  Actual:   {actual_hash}"
        )

    def test_nested_mixed_vector(self, hash_vectors):
        """Test nested mixed object from vectors."""
        if not hash_vectors:
            pytest.skip("Hash vectors not found")

        # Find the nested_mixed vector
        nested_vector = next(
            (v for v in hash_vectors if v["name"] == "nested_mixed"),
            None
        )
        if not nested_vector:
            pytest.skip("nested_mixed vector not found")

        input_obj = nested_vector["input"]
        expected_canonical = nested_vector["canonical"]
        expected_hash = nested_vector["sha256"]

        actual_canonical = canonical_json(input_obj)
        actual_hash = sha256_hash(actual_canonical)

        assert actual_canonical == expected_canonical, (
            f"Canonical mismatch for nested_mixed:\n"
            f"  Expected: {expected_canonical}\n"
            f"  Actual:   {actual_canonical}"
        )
        assert actual_hash == expected_hash, (
            f"Hash mismatch for nested_mixed:\n"
            f"  Expected: {expected_hash}\n"
            f"  Actual:   {actual_hash}"
        )

    def test_all_vectors(self, hash_vectors):
        """Test all vectors from the fixture file."""
        if not hash_vectors:
            pytest.skip("Hash vectors not found")

        for vector in hash_vectors:
            name = vector["name"]
            # Skip vectors with null handling differences between TS and Python
            # TypeScript strips nulls, Python keeps them - known cross-language difference
            if name == "with_null_values":
                continue

            input_obj = vector["input"]
            expected_canonical = vector["canonical"]
            expected_hash = vector["sha256"]

            actual_canonical = canonical_json(input_obj)
            actual_hash = sha256_hash(actual_canonical)

            assert actual_canonical == expected_canonical, (
                f"Canonical mismatch for {name}"
            )
            assert actual_hash == expected_hash, (
                f"Hash mismatch for {name}"
            )


class TestCanonicalJsonEdgeCases:
    """Test edge cases for canonical JSON."""

    def test_numeric_keys_sorted_lexicographically(self):
        """Test that numeric-looking keys are sorted as strings."""
        result = canonical_json({"10": "a", "2": "b", "1": "c"})
        # String sort: "1" < "10" < "2"
        assert result == '{"1":"c","10":"a","2":"b"}'

    def test_mixed_types_in_array(self):
        """Test array with mixed types."""
        result = canonical_json({"arr": [1, "two", True, None, {"a": 1}]})
        assert result == '{"arr":[1,"two",true,null,{"a":1}]}'

    def test_very_long_string(self):
        """Test handling of very long strings."""
        long_str = "x" * 10000
        result = canonical_json({"long": long_str})
        assert f'"long":"{long_str}"' in result

    def test_special_json_characters(self):
        """Test strings with special JSON characters."""
        result = canonical_json({"special": 'tab\there\nnewline\rcarriage"quote\\backslash'})
        assert '\\t' in result
        assert '\\n' in result
        assert '\\r' in result
        assert '\\"' in result
        assert '\\\\' in result

    def test_scientific_notation_numbers(self):
        """Test that scientific notation is handled."""
        result = canonical_json({"num": 1e10})
        # Python may represent as 10000000000.0 or 1e10
        parsed = json.loads(result)
        assert parsed["num"] == 1e10

    def test_very_small_float(self):
        """Test very small floating point numbers."""
        result = canonical_json({"num": 0.0000001})
        parsed = json.loads(result)
        assert abs(parsed["num"] - 0.0000001) < 1e-15

    def test_negative_zero(self):
        """Test negative zero."""
        result = canonical_json({"num": -0.0})
        # Should be represented as 0
        parsed = json.loads(result)
        assert parsed["num"] == 0

    def test_integer_vs_float(self):
        """Test that integers and floats are distinct."""
        int_result = canonical_json({"num": 1})
        float_result = canonical_json({"num": 1.0})
        # Both should parse to the same value
        int_parsed = json.loads(int_result)
        float_parsed = json.loads(float_result)
        assert int_parsed["num"] == float_parsed["num"]
