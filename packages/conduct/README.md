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
      timestamp: new Date().toISOString(),
      visibility: "private",
    }));
  },
});
const decision = guard.enforce({
  kind: "payment", asset: "lovelace", amount: 6_000_000n,
  counterparty: "supplier", timestamp: BigInt(Math.floor(Date.now() / 1000)),
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

`evaluate(action)` uses the supplied action time, returns a decision and changes no state. It is the explicit-time path for previews and circuit parity. It is not an authorization to execute an effect.

`enforce(action)` uses a guard-owned Unix-seconds clock (`now: () => bigint`, defaulting to the system clock). Action timestamps must fall in the clock's current fixed, epoch-aligned window, `floor(now() / windowSeconds)`, and cannot precede the last enforced action timestamp. The clock cannot move backward. Both action time and clock time must satisfy mandate validity `[notBefore, notAfter)` for authorization. Inject clocks only from trusted host code; never derive them from agent input.

Actions contain exactly their typed fields. Payment amounts must be at least one base unit. Asset identifiers are bounded to 128 UTF-8 bytes; counterparties, egress destinations and allowlist members to 256 bytes. Committee IDs are bounded to 128 UTF-8 bytes. Denial rules use fixed text; caller-supplied values occur only in typed action fields. The action digest commits every recorded action field. Invalid shapes and timestamps throw before changing spend, sequence or events.

The guard builds and canonicalizes the complete trace-safe event before reserving allowed payment spend. It freezes the event and action, reserves spend, then calls `onEvent`. The synchronous method rejects any returned promise or thenable with an error directing callers to `enforceAsync`. `enforceAsync` requires a sink and returns a decision only after that sink resolves; overlapping enforcement rejects while it is pending. Async sinks must return their promise. Detached work (`void addEvent(...)`) cannot be observed by the guard and must not be used as a durability sink.

A synchronous throw or async rejection propagates, leaves the reservation consumed and makes the instance refuse further enforcement. Reconstruct from the complete durable event log after resolving the sink failure. Denials reserve no spend. Exactly reaching the cap is allowed. Verdict precedence is validity, asset, counterparty, cap for payments; validity, deny-all, destination membership for egress.

Pass `recordedEvents: readonly GuardEvent[]` at construction to restore spend, sequence and monotonic timestamps without re-emitting events. Replay requires the complete ordered log from sequence zero for this exact mandate; it checks each digest, commitment, time, decision and denial rule. The caller must authenticate the log, ensure completeness and serialize access across processes. A guard constructed without restored events has **fresh window accounting**, including when restarted during an already-spent window. In-memory state alone cannot prevent spending the cap again after a restart. This package provides replay, not a shared durable store.

`toProcessTraceEvent` returns the real process-trace `CustomEvent` with `kind: "custom"` and `eventType: "orynq.conduct.guard.v1"`. The caller supplies the containing trace's ID, numeric sequence, ISO timestamp and visibility. Guard sequence, action time, guard clock time (`enforcedAt`) and amounts are lossless decimal strings inside `data`. The adapter checks event fields and action digests before producing JSON-safe data accepted by existing `computeEventHash` and rolling hashes. Action time and guard clock time are independent of the informational trace timestamp. Payload types are `orynq.conduct.guard.action.v1` and `orynq.conduct.guard.denial.v1`; action digests use `orynq:conduct:guard:action:v1|`.

The example above stores events in memory for demonstration. For durable authorization, have `onEvent` append and flush the guard event to your durable log before returning, or return its persistence promise and await `guard.enforceAsync(action)`. `process-trace.addEvent` updates an in-memory trace; persistence still belongs to the host. Execute effects only after a successful allowed return. An authorization records reserved spend, not proof that the effect executed. A crash after logging but before execution conservatively consumes that reservation.

The guard does not enforce `agentDid`, `approvedMeasurementSetRoot` or `disclosurePolicy`. It does not authenticate the agent or principal, verify hardware measurements, execute disclosure thresholds, observe bypassed traffic, establish trace completeness or coordinate concurrent guard instances. Route all outbound effects through one serialized authority with a trusted clock and complete durable evidence.

## Predicate compiler

`compileMandatePredicate(mandate, allowlists).buildArgs(action, priorSpent)` emits the ordered 12-slot `PREDICATE_LAYOUT`. `VERDICT` / `VERDICT_NAME` pin the eight verdict codes. `assetTag` uses the low 31 bytes of SHA-256, fitting below 2^248. The committed guard and predicate fixtures preserve boundary cases and precedence for future circuit parity checks.

The compiler produces inputs; it does not prove compliance. Membership flags and prior spend remain witness inputs until a circuit binds them to authenticated state and exact committed event bytes. No circuit, checkpoint attestation, keeper, dispute or insurance settlement is included in this package.

## Development and provenance

From the workspace root: `pnpm exec vitest run packages/conduct/tests`. Build dependencies before `pnpm --filter @fluxpointstudios/orynq-sdk-conduct typecheck`. `pnpm --filter @fluxpointstudios/orynq-sdk-conduct test:mutations` runs the 16 review mutants only after the unmutated suite passes in the same isolated layout. Set `TMPDIR` to choose its evidence directory. Golden mandate bytes, action digests, guard verdicts and predicate tuples are reviewed compatibility artifacts; update them only for a deliberate format change.

Adapted from the Apache-2.0 mandate and guard packages in Flux Point Studios' proof-of-agent-conduct. This distribution modifies their namespace, schema version, trace integration and input/state handling. The package remains [Apache-2.0](LICENSE).
