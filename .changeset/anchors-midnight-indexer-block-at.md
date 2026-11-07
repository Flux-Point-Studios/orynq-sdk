---
"@fluxpointstudios/orynq-sdk-anchors-midnight": minor
---

`midnightSource`'s indexer reads its block at a given height (`blockAt`), or
null where it holds none. It refuses an answer for another height and a hash
that is not 32 bytes of lowercase hex.
