# Cross-Language Test Vectors

This directory contains test vectors for verifying that canonical JSON and SHA256
hash implementations match across TypeScript and Python.

## Purpose

The orynq-sdk is a dual-language project (TypeScript + Python). To ensure
consistent behavior, especially for:
- Idempotency key generation
- Request hashing
- Invoice deduplication

We need both implementations to produce identical outputs for identical inputs.

## Files

- `hash-vectors.json` - Test vectors with input, expected canonical JSON, and SHA256 hash

## Vector Structure

Each vector in `hash-vectors.json` contains:

```json
{
  "name": "vector_name",
  "description": "Optional description",
  "input": { ... },
  "canonical": "expected canonical JSON string",
  "sha256": "expected SHA256 hash (hex)"
}
```

## Canonicalization Rules

The canonical JSON implementation follows RFC 8785 (JCS) with these modifications:

1. **Sort keys** - Object keys are sorted lexicographically (UTF-16 code units)
2. **Remove nulls** - Null values in objects are removed (configurable in TS)
3. **No whitespace** - No spaces between tokens
4. **Preserve arrays** - Array element order is preserved
5. **UTF-8 encoding** - Unicode characters are preserved, not escaped

## Verification

### TypeScript

```bash
npx tsx scripts/verify-hash-vectors.ts
```

### Python

```bash
python scripts/verify-hash-vectors.py
```

## Regenerating Vectors

If the canonicalization algorithm changes, regenerate vectors from TypeScript
(the source of truth):

```bash
npx tsx scripts/generate-hash-vectors.ts
```

Then verify Python still passes.

## Release Gate

**IMPORTANT**: Both verification scripts MUST pass before any release.

This is enforced by:
1. CI/CD pipelines running both verifiers
2. The `vectors:verify:all` npm script
3. Pre-release checks

### Running All Verifications

```bash
pnpm vectors:verify:all
```

This runs:
1. TypeScript verification
2. Python verification

Both must pass (exit code 0) for the release gate to be satisfied.

## Adding New Vectors

1. Add the new vector to `fixtures/hash-vectors.json` with placeholder values
2. Run `npx tsx scripts/generate-hash-vectors.ts` to compute actual values
3. Verify both implementations: `pnpm vectors:verify:all`
4. Commit the updated vectors file

## Troubleshooting

### Hash Mismatch

If you see hash mismatches:
1. Check the canonical JSON output first
2. Ensure both implementations handle:
   - Null value removal
   - Recursive key sorting
   - Unicode characters
   - Number representation

### Canonical JSON Mismatch

Common causes:
- Different key sorting algorithms
- Different null handling
- Different number formatting (3.0 vs 3)
- Different escape sequences

### Python Version Issues

Ensure Python 3.8+ is used. The `json` module behavior changed in some versions.
