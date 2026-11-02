---
"@fluxpointstudios/orynq-sdk-core": minor
"@fluxpointstudios/orynq-sdk-anchors-midnight": patch
---

`parseStrictJson(text, maxBytes)` moves from anchors-midnight into core (root
and `/utils` entries) so every package decodes signed or hashed JSON the same
way. Besides oversized text, invalid JSON and duplicate decoded keys (escaped
spellings included), it now refuses lone surrogates, nesting deeper than 32
containers, integers beyond ±2^53 and integers spelled with a fraction,
exponent or minus zero. Refusals throw `StrictJsonError` with a `code` and a
fixed message that never quotes the input.

anchors-midnight parses known-authors policy text with it, so a policy that
spells an integer as `100.0` or `1e0`, carries a lone surrogate or nests more
than 32 deep is refused, and an unparsable document now reports
`Document is not valid JSON`.
