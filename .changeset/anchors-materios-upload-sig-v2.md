---
"@fluxpointstudios/orynq-sdk-anchors-materios": minor
---

Signed blob uploads (`signerKeypair`) now carry a `materios-upload-v2` signature (`x-upload-sig-v2`) alongside the v1 one, both under one `x-upload-ts`. v2 covers the HTTP method, the request path and the SHA-256 of the exact body bytes, so a captured upload can no longer be resent with a different body. The Materios gateway accepts each signature once, and every request is signed afresh. v1 is still sent so gateways that predate v2 keep accepting uploads. No public API changes.
