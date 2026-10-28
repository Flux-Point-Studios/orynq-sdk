---
"@fluxpointstudios/orynq-sdk-conduct": minor
---

Add canonical v1 agent mandates, predicate compilation and runtime payment/egress guards with process-trace events. Guards require explicit accounting history (`"fresh"` or replay that must end at the event log's head) and an event sink for payments. The package ships the conditional-append sink contract with its `MemoryGuardLog` reference, the guard log head (`nextGuardLogHead`) and a process-trace sink adapter (`processTraceSink`).
