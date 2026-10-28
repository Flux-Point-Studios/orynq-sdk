---
"@fluxpointstudios/orynq-sdk-conduct": patch
---

`MandateGuard.head` reports the head the event sink last confirmed, so a sink cannot read the head it is expected to return. The documentation states that the guard trusts the host's log to perform the append and compare-and-swap it reports.
