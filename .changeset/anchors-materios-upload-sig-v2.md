---
"@fluxpointstudios/orynq-sdk-anchors-materios": minor
---

Signed blob uploads (`signerKeypair`) now carry a `materios-upload-v2` signature (`x-upload-sig-v2`) under `x-upload-ts`, in place of the v1 `x-upload-sig`. v2 covers the HTTP method, the request path and the SHA-256 of the exact body bytes, so a captured upload can no longer be resent with a different body. The Materios gateway accepts each signature once, and every request is signed afresh. v1 is no longer sent because it covers only the content hash, so a copy lifted from a request could carry any body. This version needs a gateway that verifies v2; the Materios preprod gateway does. No public API changes.
