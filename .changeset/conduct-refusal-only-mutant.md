---
"@fluxpointstudios/orynq-sdk-midnight-prover": patch
---

The prototype conduct circuits' mutant registry (`circuits/conduct/mutants.json`,
shipped with the tests under `tests/conduct`) gains
`r8_rewire_kind_mode_conditions`, which swaps the conditions of the action-kind
and egress-mode asserts, under a new refusal-only category: the compiled
constraints must find no differing case in a stratified sample. `pins.json`
carries the new hash of `mutants.json`. The circuits and their pinned ZKIR are
unchanged.
