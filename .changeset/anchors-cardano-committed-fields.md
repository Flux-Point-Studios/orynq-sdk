---
"@fluxpointstudios/orynq-sdk-anchors-cardano": patch
---

`verifyAnchor` with `fetchBundle` returns each fetched event and span exactly
as its hash commits to it, without span fields outside the hashed header or
null-valued keys, and rejects a fetched bundle that repeats a span or event ID,
in which one ID would name different committed data.
