# Governance attestations (issue #58)

The `governance-attestation` event kind records a verifiable, role-scoped sign-off
inside a trace (compliance review, release approval, data-steward sign-off), so an
auditor can answer **"who governed this decision?"** without trusting the wrapper
that recorded it.

The signature covers a canonical, domain-separated preimage of
`(role || policyRef || decisionRef || signedAt)`, so it is independently verifiable
from the recorded event fields alone.

## Signing schemes

| Scheme | Verified by |
| --- | --- |
| `sr25519` | built-in (`@polkadot/util-crypto`, optional peer dep) |
| `ed25519` | built-in (`@polkadot/util-crypto`, optional peer dep) |
| `eip712` | pluggable verifier (`createEip712GovernanceVerifier`, viem injected) |

> `@polkadot/util-crypto` / `@polkadot/util` are **optional peer dependencies**,
> loaded via dynamic `import()`. Base tracing installs don't pull them; install
> them to use the built-in sr25519/ed25519 signers/verifiers.

## Example: anchor a model-release approval signed by a release-authority wallet

```ts
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  addGovernanceAttestation,
  createSr25519GovernanceSigner,
  verifyGovernanceAttestations,
} from "@fluxpointstudios/orynq-sdk-process-trace";

const run = await createTrace({ agentId: "release-bot" });
const span = addSpan(run, { name: "model-release", visibility: "public" });

const decision = await addEvent(run, span.id, {
  kind: "decision",
  decision: "promote model v2 to production",
  visibility: "public",
});

// The release-authority wallet signs the approval.
const releaseAuthority = await createSr25519GovernanceSigner({
  seed: process.env.RELEASE_AUTHORITY_SEED!, // 0x-hex 32-byte seed (HSM in prod)
});

await addGovernanceAttestation(run, span.id, {
  role: "release-authority",
  policyRef: "sha256:<hash of the model-release policy doc>",
  decisionRef: decision.id,
  signer: releaseAuthority,
});

await closeSpan(run, span.id);
const bundle = await finalizeTrace(run);

// Auditor side — governance provenance for free:
const summary = await verifyGovernanceAttestations(bundle);
// [{ role: "release-authority", attestor: "5...", scheme: "sr25519", verified: true }]
```

## Verification during trace verification

`verifyBundle()` runs governance verification when asked:

```ts
const result = await verifyBundle(bundle, { governance: true });
result.checks.governanceValid; // false fails the whole bundle
```

For `eip712`, inject a viem verifier:

```ts
import { verifyTypedData } from "viem";
import { createEip712GovernanceVerifier } from "@fluxpointstudios/orynq-sdk-process-trace";

await verifyGovernanceAttestations(bundle, {
  verifiers: { eip712: createEip712GovernanceVerifier({ verifyTypedData }) },
});
```

## Inspecting governance events

The `trace_summary` MCP tool surfaces governance attestations (and tool receipts +
the model manifest) distinctly — see `packages/orynq-mcp`.
