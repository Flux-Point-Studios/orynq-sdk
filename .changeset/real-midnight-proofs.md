---
"@fluxpointstudios/orynq-sdk-midnight-prover": minor
"@fluxpointstudios/orynq-mcp": patch
---

Add genuine Compact capability and rolling-digest proofs with a pinned native ledger verifier. Verification binds public outputs to the expected statement and refuses untrusted keys, malformed transactions and simulations. Existing mock APIs require explicit simulation mode and cannot provide production proof or publication claims.

Require an MCP SDK version containing the OAuth credential handling fix.
