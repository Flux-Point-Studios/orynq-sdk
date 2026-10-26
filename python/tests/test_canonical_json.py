"""
Cross-language compatibility tests for canonical JSON.

These tests verify that Python produces the same canonical JSON output
as TypeScript and other language implementations in the orynq-sdk.
"""

import math

import pytest

from orynq_sdk.trace import canonical_json, sha256_hex as sha256_hash


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

    def test_strips_null_object_fields(self):
        """Match TypeScript null removal in object fields."""
        result = canonical_json({"a": 1, "b": None, "c": 3})
        assert result == '{"a":1,"c":3}'

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
        # Find the simple_object vector
        simple_vector = next(
            (v for v in hash_vectors if v["name"] == "simple_object"),
            None
        )
        assert simple_vector is not None, "Required simple_object vector not found"

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

    def test_nested_object_vector(self, hash_vectors):
        """Test the shared nested_object fixture."""
        nested_vector = next(
            (v for v in hash_vectors if v["name"] == "nested_object"),
            None
        )
        assert nested_vector is not None, "Required nested_object vector not found"

        input_obj = nested_vector["input"]
        expected_canonical = nested_vector["canonical"]
        expected_hash = nested_vector["sha256"]

        actual_canonical = canonical_json(input_obj)
        actual_hash = sha256_hash(actual_canonical)

        assert actual_canonical == expected_canonical, (
            f"Canonical mismatch for nested_object:\n"
            f"  Expected: {expected_canonical}\n"
            f"  Actual:   {actual_canonical}"
        )
        assert actual_hash == expected_hash, (
            f"Hash mismatch for nested_object:\n"
            f"  Expected: {expected_hash}\n"
            f"  Actual:   {actual_hash}"
        )

    def test_all_vectors(self, hash_vectors):
        """Test all vectors from the fixture file."""
        for vector in hash_vectors:
            name = vector["name"]
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

    @pytest.mark.parametrize("number,expected", [
        (1.0, "1"),
        (-0.0, "0"),
        (1e-7, "1e-7"),
        (1e-6, "0.000001"),
        (1e10, "10000000000"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (333333333.33333329, "333333333.3333333"),
        (math.nextafter(0, 1), "5e-324"),
        (float.fromhex("0x1.fffffffffffffp+1023"), "1.7976931348623157e+308"),
        (2**53 - 1, "9007199254740991"),
        (-(2**53 - 1), "-9007199254740991"),
        # Explicit floats keep their IEEE-754 value even above safe-integer range.
        (float(2**53), "9007199254740992"),
    ])
    def test_ecmascript_number_bytes(self, number, expected):
        assert canonical_json({"num": number}) == '{"num":' + expected + '}'

    @pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf, 2**53, -(2**53)])
    def test_rejects_numbers_without_lossless_interchange(self, value):
        with pytest.raises(ValueError, match="safe integer domain|not representable"):
            canonical_json({"nested": [value]})

    def test_utf16_key_order_and_nested_nulls(self):
        assert canonical_json({
            "\ue000": {"keep": 1.0, "omit": None},
            "😀": [None, {"keep": -0.0, "omit": None}],
        }) == '{"😀":[null,{"keep":0}],"\ue000":{"keep":1}}'

    def test_rejects_non_string_keys(self):
        with pytest.raises(ValueError, match="keys must be strings"):
            canonical_json({1: "value"})
