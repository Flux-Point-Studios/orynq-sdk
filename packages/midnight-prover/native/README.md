# Native Midnight verification

This helper verifies an offchain Compact proof using the official native Midnight ledger at `ledger-8.1.3`, commit `b5d3e965a18e4cac17fac4f38446fc55c524439a`. The dependency explicitly enables `proof-verifying`. No dependency enables `mock-verify`.

The published ledger WASM build disables the ledger's default proof verification feature. Setting its JavaScript `verifyContractProofs` flag cannot enable code omitted from that build. This helper uses the native ledger's verifier and public input derivation.

Build with Rust and the committed dependency lockfile:

```sh
cargo build --release --locked
cargo test --locked
```

Run the binary with a registry controlled by the application:

```sh
./target/release/orynq-midnight-verifier --registry /trusted/artifacts/registry.json
```

The registry has this shape. Relative artifact paths resolve against its directory:

```json
{
  "version": 1,
  "circuits": {
    "rolling-hash-chain-v1": {
      "entryPoint": "proveRolling1",
      "verifierKeyPath": "keys/proveRolling1.verifier",
      "initialContractStatePath": "initial-contract-state.bin"
    }
  }
}
```

Generate the initial ContractState template from the compiled constructor, attach the compiled operation keys, and serialize that ContractState. The template excludes the randomized deployment address. Both the registry and these artifacts are trusted configuration. Keep them outside caller write access. A proof request cannot provide a key path or replace the template.

Send one JSON object on stdin:

```json
{
  "circuitId": "rolling-hash-chain-v1",
  "transactionBase64": "...",
  "referenceStateBase64": "..."
}
```

The transaction must contain exactly one call to the registered entry point. Additional calls, deployment, maintenance, shielded offers, unshielded offers and dust actions are rejected. The selected contract's complete initial state must equal the trusted template, including its operation keys. The selected operation's key must also equal the compiled key in the registry. The reference ledger state must carry the ledger's initial parameters, so a caller cannot widen the TTL bound or change limits.

Responses contain only a validity flag and a stable code:

```json
{"valid":true,"code":"verified"}
```

Rejection codes include `invalid-proof`, `invalid-transaction`, `invalid-time`, `malformed-input`, `unknown-circuit`, `untrusted-state`, `unexpected-transaction` and `configuration-error`. Configuration errors exit with status 2. Other completed checks exit with status 0; callers must require `valid: true` and `code: verified`. Missing output, malformed output, process failures and timeouts must fail closed. Stdin is limited to 4 MiB.

Requests do not accept a caller-selected verification timestamp. Ledger validation uses the verifier's current time. This does not attest when the proof was created. Funding balance enforcement is disabled for this offchain mode; cryptographic proof and signature verification remain enabled. Successful verification does not publish a transaction, provide finality, authenticate an issuer, enforce application lease expiry or revocation, or establish a credential provider's consent. The binding signature does not cover the transaction TTL, so anyone holding a transaction can refresh it without reproducing a contract proof; the TTL is no freshness control. This verifier checks the proof and the transaction's structure, not a statement's own deadline. Orynq's circuits disclose `notAfter` and assert it against the block time, which the ledger evaluates only when it applies the call, so callers must decode and check it, as `RealMidnightProver.verify` does. The caller must independently compare the verified contract's public outputs with the expected statement.

Tests use synthetic serialized proof evidence: the real prover's valid transaction, an interior proof corruption, and an altered public root with a freshly valid binding. Each test refreshes the synthetic transaction's TTL without changing the proof inputs or witness. No credentials or customer data are present in the fixtures.

The two official Orynq circuit IDs additionally enforce the committed verifier-key and initial-state SHA-256 pins compiled into this binary from `artifact-pins.json`. Application-owned circuit IDs retain their explicit trusted registry contract, including the synthetic native test circuit. No proof request can choose a pin or artifact path.

CI builds with the pinned Rust 1.99.0 image, runs pinned cargo-audit 0.22.2 before compilation, and denies advisory warnings. Three documented informational exceptions are upstream-only RUSTSEC-2026-0253 (lru panic-safety warning in upstream caches; no caller-defined key destructors or prover-key initialization are exposed by this verifier), RUSTSEC-2025-0141 (unmaintained bincode) and RUSTSEC-2024-0436 (unmaintained paste). A fourth, narrowly reviewed exception is RUSTSEC-2026-0387 for crypto-bigint in this public-input-only verifier; the boundary guard and the exact deterministic verification call path are documented in `SECURITY.md`. The vulnerable crate remains in the closure, and the exception does not apply to a signer or JS/WASM prover. Rustls and the compatible Tokio/webpki fixes are updated rather than suppressed. Revisit exceptions when Midnight updates its dependency closure.
