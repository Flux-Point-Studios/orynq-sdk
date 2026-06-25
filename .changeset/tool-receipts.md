---
"@fluxpointstudios/orynq-sdk-tool-receipts": minor
"@fluxpointstudios/orynq-sdk-process-trace": minor
"@fluxpointstudios/orynq-mcp": minor
---

Add verifiable tool-call receipts (#60) so a trace can prove "the tool actually
returned this response", not just "the agent says it did".

- New `tool-receipt` event kind in process-trace.
- New package `@fluxpointstudios/orynq-sdk-tool-receipts` with verifiers for RFC
  9421 HTTP Message Signatures, Stripe/GitHub webhook signatures, and generic JWS;
  `verifyToolReceipts()` + a `verifyTrace()` wrapper that folds receipt checks into
  `verifyBundle()` (`checks.toolReceiptsValid`).
- `addToolReceipt()` / `hashToolPayload()` recording helpers.
- `createSigningProxy()` — the "anti-lie" pattern for wrapping tools that don't
  sign their responses natively (see `docs/anti-lie-tool-receipts.md`).
- The `trace_summary` MCP tool surfaces tool receipts distinctly.

Additive — existing API is unchanged.
