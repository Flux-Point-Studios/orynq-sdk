---
"@fluxpointstudios/orynq-sdk-conduct": minor
---

Add canonical v1 agent mandates, predicate compilation and runtime payment/egress guards with process-trace events. Guards require explicit accounting history (`"fresh"` or replay that must end at the event log's head) and an event sink for payments. A sink appends only if the log's head still equals the expected previous head and returns the new head, which the guard verifies before authorizing. The package ships that contract with its `MemoryGuardLog` reference, the guard log head (`nextGuardLogHead`) and a process-trace sink adapter (`processTraceSink`).
