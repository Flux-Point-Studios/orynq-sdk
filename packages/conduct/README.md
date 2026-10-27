# @fluxpointstudios/orynq-sdk-conduct

Canonical agent mandates, a predicate compiler and a deterministic runtime guard. Requires Node.js 20 or newer. ESM and CommonJS exports are supported.

```sh
npm install @fluxpointstudios/orynq-sdk-conduct @fluxpointstudios/orynq-sdk-process-trace
```

```ts
import { randomUUID } from "node:crypto";
import { computeEventHash, type CustomEvent } from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  buildAllowlistRoot, MandateGuard, toProcessTraceEvent, type MandateV1,
} from "@fluxpointstudios/orynq-sdk-conduct";

const counterparties = ["supplier"];
const mandate: MandateV1 = {
  schemaVersion: 1n,
  mandateId: new Uint8Array(16).fill(1), // Use a fresh principal-chosen ID in production.
  principalDid: "did:key:z123456789",
  agentDid: "did:key:z987654321",
  didFormatVersion: 0n,
  spendCap: { asset: "lovelace", amount: 10_000_000n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(counterparties),
  egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32),
  validityWindow: { notBefore: 1_790_000_000n, notAfter: 1_800_000_000n },
  disclosurePolicy: { committeeId: "example", threshold: 2n, committeeSize: 3n },
};
const events: CustomEvent[] = [];
const guard = new MandateGuard({
  mandate,
  counterpartyAllowlist: counterparties,
  onEvent(event) {
    events.push(toProcessTraceEvent(event, {
      id: randomUUID(),
      seq: events.length,
      timestamp: "2026-10-27T12:00:00.000Z",
      visibility: "private",
    }));
  },
});
const decision = guard.enforce({
  kind: "payment", asset: "lovelace", amount: 6_000_000n,
  counterparty: "supplier", timestamp: 1_793_100_000n,
});
// Execute the payment only when decision.allowed is true.
console.log(decision.allowed, await computeEventHash(events[0]!));
```

The example DIDs satisfy the schema pattern; they are not verified identities. The zero measurement root makes no hardware-attestation claim.

## Mandates and commitments

`encodeMandate` and `decodeMandate` implement the [v1 CDDL](docs/mandate-v1.cddl). Integers are unsigned 64-bit `bigint` values. The strict deterministic CBOR subset uses shortest encodings, definite lengths and bytewise sorted unique map keys. Noncanonical bytes, malformed UTF-8, unknown keys, floats, tags, negatives, null and trailing bytes reject. A leading Unicode BOM is text data and is preserved.

`mandateCommitment` returns SHA-256 of `orynq:conduct:mandate:v1|` followed by canonical CBOR; `mandateCommitmentHex` returns lowercase hex. Both validate the mandate, including when passed encoded bytes. These functions do not sign mandates, verify principal authority or authenticate DID keys.

`buildAllowlistRoot` hashes UTF-8 members encoded as canonical CBOR using `orynq:conduct:allowlist:leaf:v1|`, deduplicates and sorts their hashes, then combines pairs under `orynq:conduct:allowlist:node:v1|`. Odd nodes are promoted unchanged; the empty root is zero. Both guard and compiler verify supplied allowlists against the mandate roots.

## Runtime guard and trace integration

`evaluate(action)` returns a decision without changing spend or emitting an event. `enforce(action)` validates the action, reserves allowed payment spend and emits one `GuardEvent` for either authorization or denial. Invalid action shapes throw before changing state. Caller-owned mandate and action mutation cannot change the guard's policy or earlier event payloads. Callbacks are synchronous; a callback error propagates and reserved spend remains consumed. A denial consumes no spend.

Windows are **fixed, epoch-aligned tumbling windows**: `floor(action.timestamp / windowSeconds)`. Validity is `[notBefore, notAfter)`, and exactly reaching the spend cap is allowed. Verdict precedence is validity, asset, counterparty, cap for payments; validity, deny-all, destination membership for egress. State is per guard instance and in memory; reconstructing it resets spend. Actions may arrive out of timestamp order, and each window retains its own total.

`toProcessTraceEvent` returns the real process-trace `CustomEvent` with `kind: "custom"` and `eventType: "orynq.conduct.guard.v1"`. The caller supplies the containing trace's ID, numeric sequence, ISO timestamp and visibility. Guard sequence, action time and amounts are lossless decimal strings inside `data`, so JSON serialization and existing `computeEventHash`/rolling hashes accept them. Action time is independent of the informational trace timestamp. The payload type is `orynq.conduct.guard.action.v1` or `orynq.conduct.guard.denial.v1`; action digests use `orynq:conduct:guard:action:v1|`.

Route every outbound action through the guard and persist its events before executing authorized effects. An authorization is not evidence that an effect executed. The guard cannot observe bypassed traffic, authenticate caller timestamps, persist spend across restarts or establish trace completeness. Applications must supply those controls.

## Predicate compiler

`compileMandatePredicate(mandate, allowlists).buildArgs(action, priorSpent)` emits the ordered 12-slot `PREDICATE_LAYOUT`. `VERDICT` / `VERDICT_NAME` pin the eight verdict codes. `assetTag` uses the low 31 bytes of SHA-256, fitting below 2^248. The committed guard and predicate fixtures preserve boundary cases and precedence for future circuit parity checks.

The compiler produces inputs; it does not prove compliance. Membership flags and prior spend remain witness inputs until a circuit binds them to authenticated state and exact committed event bytes. No circuit, checkpoint attestation, keeper, dispute or insurance settlement is included in this package.

## Development and provenance

From the workspace root: `pnpm exec vitest run packages/conduct/tests`. Build dependencies before `pnpm --filter @fluxpointstudios/orynq-sdk-conduct typecheck`. Golden mandate bytes, hashes, guard verdicts and predicate tuples are reviewed compatibility artifacts; update them only for a deliberate format change.

Adapted from the Apache-2.0 mandate and guard packages in Flux Point Studios' proof-of-agent-conduct. This distribution modifies their namespace, schema version, trace integration and input/state handling. The package remains [Apache-2.0](LICENSE).
