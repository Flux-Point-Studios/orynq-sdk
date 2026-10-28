# @fluxpointstudios/orynq-sdk-conduct

## 0.1.0

### Minor Changes

- 35dd4da: Add canonical v1 agent mandates, predicate compilation and runtime payment/egress guards with process-trace events. Guards require explicit accounting history (`"fresh"` or replay that must end at the event log's head) and an event sink for payments. A sink appends only if the log's head still equals the expected previous head and returns the new head, which the guard verifies before authorizing. The package ships that contract with its `MemoryGuardLog` reference, the guard log head (`nextGuardLogHead`) and a process-trace sink adapter (`processTraceSink`).

### Patch Changes

- 7c75f0c: `MandateGuard.head` reports the head the event sink last confirmed, so a sink cannot read the head it is expected to return. The documentation states that the guard trusts the host's log to perform the append and compare-and-swap it reports.
- Updated dependencies [14bb540]
- Updated dependencies [14bb540]
- Updated dependencies [ab2e261]
  - @fluxpointstudios/orynq-sdk-core@0.4.0
  - @fluxpointstudios/orynq-sdk-process-trace@0.4.0
