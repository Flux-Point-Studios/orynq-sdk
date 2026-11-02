---
"@fluxpointstudios/orynq-sdk-core": minor
"@fluxpointstudios/orynq-sdk-anchors-midnight": patch
---

`parseStrictJson(text, maxBytes)` moves from anchors-midnight into core (root
and `/utils` entries) so every package decodes signed or hashed JSON the same
way. Besides oversized text, invalid JSON and duplicate decoded keys (escaped
spellings included), it now refuses lone surrogates, any value enclosed by
more than 32 containers (the top-level value is enclosed by none), integers
beyond ±2^53 and integers spelled with a fraction, exponent or minus zero.
Nesting is judged before `JSON.parse` runs, so a deeply nested text is refused
without being built and reports `JSON_DEPTH` even when it is also malformed.
Refusals throw `StrictJsonError` with a `code` and a fixed message that never
quotes the input.

anchors-midnight parses known-authors policy text with it, so a policy that
spells an integer as `100.0` or `1e0`, carries a lone surrogate or encloses a
value in more than 32 containers is refused, and an unparsable document now
reports `Document is not valid JSON`.
