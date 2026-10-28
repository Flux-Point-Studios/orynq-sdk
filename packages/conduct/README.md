# @fluxpointstudios/orynq-sdk-conduct

Canonical agent mandates, a predicate compiler and a deterministic runtime guard. Requires Node.js 20 or newer. ESM and CommonJS exports are supported.

```sh
npm install @fluxpointstudios/orynq-sdk-conduct @fluxpointstudios/orynq-sdk-process-trace
```

```ts
import { addSpan, createTrace } from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  buildAllowlistRoot, MandateGuard, MemoryGuardLog, processTraceSink, type MandateV1,
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

const log = new MemoryGuardLog(); // Stand-in for a durable log with the same append contract.
const run = await createTrace({ agentId: "agent-1" });
const span = addSpan(run, { name: "payments" });
const recordTrace = processTraceSink(run, span.id);
let clock = 0n;
const guard = new MandateGuard({
  mandate,
  counterpartyAllowlist: counterparties,
  history: "fresh", // The log is empty. A restarted host passes log.history() instead.
  now: () => clock,
  async onEvent(event) {
    log.append(event); // Refuses unless the log holds exactly event.seq events.
    await recordTrace(event); // Resolves once the process trace holds the event.
  },
});

clock = BigInt(Math.floor(Date.now() / 1000)); // One clock sample stamps and enforces the action.
const decision = await guard.enforceAsync({
  kind: "payment", asset: "lovelace", amount: 6_000_000n, counterparty: "supplier", timestamp: clock,
});
// Execute the payment only when decision.allowed is true.
console.log(decision.allowed, run.events.length, guard.head);
```

The example DIDs satisfy the schema pattern; they are not verified identities. The zero measurement root makes no hardware-attestation claim. `MemoryGuardLog` forgets everything when the process exits, so a production host replaces it with durable storage that implements the [event sink contract](#accounting-state-and-the-event-sink).

## Mandates and commitments

`encodeMandate` and `decodeMandate` implement the [v1 CDDL](docs/mandate-v1.cddl). Integers are unsigned 64-bit `bigint` values. The strict deterministic CBOR subset uses shortest encodings, definite lengths and bytewise sorted unique map keys. Noncanonical bytes, malformed UTF-8, unknown keys, floats, tags, negatives, null and trailing bytes reject. A leading Unicode BOM is text data and is preserved.

`mandateCommitment` returns SHA-256 of `orynq:conduct:mandate:v1|` followed by canonical CBOR; `mandateCommitmentHex` returns lowercase hex. Both validate the mandate, including when passed encoded bytes. These functions do not sign mandates, verify principal authority or authenticate DID keys.

`buildAllowlistRoot` hashes UTF-8 members encoded as canonical CBOR using `orynq:conduct:allowlist:leaf:v1|`, deduplicates and sorts their hashes, then combines pairs under `orynq:conduct:allowlist:node:v1|`. Odd nodes are promoted unchanged; the empty root is zero. Both guard and compiler verify supplied allowlists against the mandate roots.

## Runtime guard

`evaluate(action)` uses the supplied action time, returns a decision and changes no state. It is the explicit-time path for previews and circuit parity. It is not an authorization to execute an effect.

`enforce(action)` uses a guard-owned Unix-seconds clock (`now: () => bigint`, defaulting to the system clock). Action timestamps must fall in the clock's current fixed, epoch-aligned window, `floor(now() / windowSeconds)`, must not be later than the clock and cannot precede the last enforced action timestamp. The clock cannot move backward. Both action time and clock time must satisfy mandate validity `[notBefore, notAfter)` for authorization. Inject clocks only from trusted host code; never derive them from agent input. Stamp each action from the same clock sample the guard reads, as in the example: two separate clock reads can fall on either side of a window boundary, and the guard then throws.

Actions contain exactly their typed fields. Payment amounts must be at least one base unit. Asset identifiers are bounded to 128 UTF-8 bytes; counterparties, egress destinations and allowlist members to 256 bytes. Committee IDs are bounded to 128 UTF-8 bytes. Denial rules use fixed text; caller-supplied values occur only in typed action fields. The action digest commits every recorded action field. Invalid shapes and timestamps throw before changing spend, sequence or events.

The guard builds and canonicalizes the complete trace-safe event and its log head before reserving allowed payment spend. It freezes the event and action, reserves spend, then calls `onEvent`. The synchronous method rejects any returned promise or thenable with an error directing callers to `enforceAsync`. `enforceAsync` requires a sink and returns a decision only after that sink resolves; overlapping enforcement rejects while it is pending. Async sinks must return their promise. Detached work (`void addEvent(...)`) cannot be observed by the guard and must not be used as a sink.

A synchronous throw or async rejection propagates, leaves the reservation consumed and makes the instance refuse further enforcement. Restore a new guard from the event log after resolving the sink failure. Denials reserve no spend. Exactly reaching the cap is allowed. `spentInWindow(timestamp)` reports the spend of the latest window that holds an allowed payment and `0n` for every other window; enforcement never charges an earlier window, so older totals are discarded. Verdict precedence is validity, asset, counterparty, cap for payments; validity, deny-all, destination membership for egress.

Execute effects only after a successful allowed return. An authorization records reserved spend; the guard has no evidence of whether the effect executed. A crash after logging but before execution conservatively consumes that reservation.

## Accounting state and the event sink

`history` is a required constructor field; there is no default accounting state. Pass `"fresh"` only when the mandate's event log is empty. Otherwise pass `{ events, head }` read from the log: the complete ordered events from sequence zero and the head the log reports. Replay checks each event's fields, digest, commitment, times and denial rule, re-derives its decision, and must end exactly at `head`. A truncated log, a renumbered log or a rewritten log of the same length throws `GuardConfigError`.

Payment enforcement requires an event sink. Without `onEvent`, `enforce` throws for payments before reserving anything; egress enforcement and `evaluate` keep working.

The sink contract: `onEvent(event)` appends `event` to the mandate's log at position `event.seq`. The append must succeed only when the log holds exactly `event.seq` events and must otherwise throw or reject without writing. Complete the append before returning, or return its promise and call `enforceAsync`. Every guard appends at the position its history ends, so a second live guard for the same log, or a restart that declares `"fresh"` against a non-empty log, asks for a position that is already taken. Its append fails, it returns no authorization and it refuses further enforcement until restored from the log.

The log head is `{ count, hash }`. `GUARD_LOG_GENESIS` is the empty log: count `0n` and 32 zero bytes. Appending event `n` sets `hash = SHA-256("orynq:conduct:guard:log:v1|" ‖ previous hash bytes ‖ canonical JSON of the event data)`, where the event data is the `data` that `toProcessTraceEvent` emits, so the head can be recomputed from trace events. `nextGuardLogHead(head, event)` returns the next head and throws unless `event.seq` equals `head.count`. `guard.head` is the guard's current head.

`MemoryGuardLog` is the reference implementation the tests use: `append(event)` follows the contract and `history()` returns `{ events, head }`. A durable host keeps the same behavior in storage it controls, for example an insert keyed by mandate commitment and sequence in a transaction that checks and advances a stored head, or one file per sequence created exclusively (`O_EXCL`) with the head in its own file. Keep the head where whoever can rewrite or truncate the events cannot roll it back: a separate store, a signed checkpoint or an anchored commitment. A head stored and rewritten together with the events detects accidental damage only.

The guard trusts the history, head and clock its host supplies. It does not authenticate the log, the head or the storage.

## Process-trace integration

`processTraceSink(run, spanId, visibility = "private")` records each guard event in a process-trace span as a `CustomEvent` and returns the `addEvent` promise, so `enforceAsync` authorizes only after the trace holds the event and refuses when recording fails. Process-trace runs live in memory: compose the trace sink after the durable log append, as in the example, rather than using the trace as the accounting log.

`toProcessTraceEvent` returns the real process-trace `CustomEvent` with `kind: "custom"` and `eventType: "orynq.conduct.guard.v1"`. The caller supplies the containing trace's ID, numeric sequence, ISO timestamp and visibility. Guard sequence, action time, guard clock time (`enforcedAt`) and amounts are lossless decimal strings inside `data`. Both functions check event fields, the denial reason and rule, and action digests before producing JSON-safe data accepted by existing `computeEventHash` and rolling hashes. Action time and guard clock time are independent of the informational trace timestamp. Payload types are `orynq.conduct.guard.action.v1` and `orynq.conduct.guard.denial.v1`; action digests use `orynq:conduct:guard:action:v1|`.

## Scope

The guard does not enforce `agentDid`, `approvedMeasurementSetRoot` or `disclosurePolicy`. It does not authenticate the agent or principal, verify hardware measurements, execute disclosure thresholds, observe bypassed traffic or establish trace completeness. It serializes concurrent guards only through a log that implements the sink contract. Route all outbound effects through guards with a trusted clock and complete durable evidence.

## Predicate compiler

`compileMandatePredicate(mandate, allowlists).buildArgs(action, priorSpent)` emits the ordered 12-slot `PREDICATE_LAYOUT`. `VERDICT` / `VERDICT_NAME` pin the eight verdict codes. `assetTag` uses the low 31 bytes of SHA-256, fitting below 2^248. The committed guard and predicate fixtures preserve boundary cases and precedence for future circuit parity checks.

The compiler produces inputs; it does not prove compliance. Membership flags and prior spend remain witness inputs until a circuit binds them to authenticated state and exact committed event bytes. No circuit, checkpoint attestation, keeper, dispute or insurance settlement is included in this package.

## Development and provenance

From the workspace root, build the workspace dependencies (`pnpm --filter "@fluxpointstudios/orynq-sdk-conduct..." build`), then run `pnpm exec vitest run packages/conduct/tests`; the restart and composition suites run hosts as child processes that load the built dependencies. Build dependencies before `pnpm --filter @fluxpointstudios/orynq-sdk-conduct typecheck`. `pnpm --filter @fluxpointstudios/orynq-sdk-conduct test:mutations` runs every catalogued mutant against every conduct test, including the child-process suites, after the unmutated suite passes in the same isolated layout; pass mutant names to run a subset. Set `TMPDIR` to choose its evidence directory. Golden mandate bytes, action digests, guard verdicts, denial rule texts, log heads and predicate tuples are reviewed compatibility artifacts; update them only for a deliberate format change.

Adapted from the Apache-2.0 mandate and guard packages in Flux Point Studios' proof-of-agent-conduct. This distribution modifies their namespace, schema version, trace integration and input/state handling. The package remains [Apache-2.0](LICENSE).
