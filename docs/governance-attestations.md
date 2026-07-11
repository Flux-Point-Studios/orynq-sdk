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

// Auditor side — governance provenance. The attestor identity rides in the
// untrusted trace, so you MUST allow-list the authorized signer(s): a valid
// self-signed attestation from an arbitrary key is not a real sign-off. With no
// allow-list, verification fails closed (never folds into a passing verdict).
const summary = await verifyGovernanceAttestations(bundle, {
  authorizedAttestors: [releaseAuthority.address],
  // or scope by role: authorizedAttestorsByRole: { "release-authority": [...] }
});
// [{ role: "release-authority", attestor: "5...", scheme: "sr25519", verified: true, authorized: true }]
```

## Authorized attestors (allow-list)

Governance verification is **fail-closed**. Because the `attestor.address` is
recorded by the (untrusted) wrapper, a cryptographically valid signature only
proves *that key* signed — not that the key is a real release-authority. The
caller supplies the trust anchor:

- `authorizedAttestors: string[]` — flat allow-list (SS58 / `0x`-address,
  case-insensitive).
- `authorizedAttestorsByRole: Record<string, string[]>` — per-role allow-list;
  a `data-steward` key cannot pass off a `release-authority` sign-off.

An attestation whose signer is not allow-listed is `authorized: false` /
`verified: false` and does **not** count toward a passing bundle verdict. With
neither list configured, every attestation fails closed.

## Verification during trace verification

`verifyBundle()` runs governance verification when asked. Pass the allow-list
through the `governance` option (bare `true` fails closed with no signers):

```ts
const result = await verifyBundle(bundle, {
  governance: { authorizedAttestors: [releaseAuthority.address] },
});
result.checks.governanceValid; // false fails the whole bundle
```

For `eip712`, inject a viem verifier. The schema pins
(`expectedDomain`/`expectedPrimaryType`/`expectedTypes`) are **mandatory** — an
unpinned verifier would accept an empty attacker-signed struct that smuggles the
claim fields as untyped extras, and the pinned type must declare `role`,
`policyRef`, `decisionRef`, and `runId` so the signature commits to them:

```ts
import { verifyTypedData } from "viem";
import { createEip712GovernanceVerifier } from "@fluxpointstudios/orynq-sdk-process-trace";

await verifyGovernanceAttestations(bundle, {
  verifiers: {
    eip712: createEip712GovernanceVerifier({
      verifyTypedData,
      expectedDomain: { name: "Orynq", version: "1" },
      expectedPrimaryType: "Attestation",
      expectedTypes: {
        Attestation: [
          { name: "role", type: "string" },
          { name: "policyRef", type: "string" },
          { name: "decisionRef", type: "string" },
          { name: "runId", type: "string" },
        ],
      },
    }),
  },
  authorizedAttestors: ["0x<release-authority>"],
});
```

## Inspecting governance events

The `trace_summary` MCP tool surfaces governance attestations (and tool receipts +
the model manifest) distinctly — see `packages/orynq-mcp`.
