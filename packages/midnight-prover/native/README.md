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
  "referenceStateBase64": "...",
  "verificationTimeUnixSeconds": 1791565844
}
```

The transaction must contain exactly one call to the registered entry point. Additional calls, deployment, maintenance, shielded offers, unshielded offers and dust actions are rejected. The selected contract's complete initial state must equal the trusted template, including its operation keys. The selected operation's key must also equal the compiled key in the registry. The reference ledger state must carry the ledger's initial parameters, so a caller cannot widen the TTL bound or change limits.

Responses contain only a validity flag and a stable code:

```json
{"valid":true,"code":"verified"}
```

Rejection codes include `invalid-proof`, `invalid-transaction`, `invalid-time`, `malformed-input`, `unknown-circuit`, `untrusted-state`, `unexpected-transaction` and `configuration-error`. Configuration errors exit with status 2. Other completed checks exit with status 0; callers must require `valid: true` and `code: verified`. Missing output, malformed output, process failures and timeouts must fail closed. Stdin is limited to 4 MiB.

The supplied timestamp must be within 30 seconds of the verifier's clock. Ledger validation uses the verifier's current time. This does not attest when the proof was created. Funding balance enforcement is disabled for this offchain mode; cryptographic proof and signature verification remain enabled. Successful verification does not publish a transaction, provide finality, authenticate an issuer, enforce application lease expiry or revocation, or establish a credential provider's consent. The binding signature does not cover the transaction TTL, so anyone holding a transaction can refresh it without reproducing a contract proof; the TTL is no freshness control. This verifier checks the proof and the transaction's structure, not a statement's own deadline. Orynq's circuits disclose `notAfter` and assert it against the block time, which the ledger evaluates only when it applies the call, so callers must decode and check it, as `RealMidnightProver.verify` does. The caller must independently compare the verified contract's public outputs with the expected statement.

Tests use synthetic serialized proof evidence: the real prover's valid transaction, an interior proof corruption, and an altered public root with a freshly valid binding. Each test refreshes the synthetic transaction's TTL without changing the proof inputs or witness. No credentials or customer data are present in the fixtures.
