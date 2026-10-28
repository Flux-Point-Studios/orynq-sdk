---
"@fluxpointstudios/orynq-sdk-anchors-cardano": patch
---

`verifyAnchor` with `fetchBundle` recomputes a fetched bundle in linear time:
it hashes each event once and finds each span's events by ID in a map instead of
scanning every event, so a document at the 8 MiB cap verifies in seconds
instead of minutes.
