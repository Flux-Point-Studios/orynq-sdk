---
"@fluxpointstudios/orynq-sdk-midnight-prover": patch
---

The prototype conduct circuits under `circuits/conduct` gain a `steps` unit:
`steps.generated.compact`, generated like the openings from the guard-event
template and `classes.json`, holds one `st_*` circuit per step class. For one
guard event a step shows that the decision the guard recorded is the conduct
verdict over the event's own opened action, the mandate atoms under the
commitment K it discloses, an allowlist path computed in the circuit and a
stated prior spend, with the action digest recomputed from the action bytes.
A denial for a party on no list has no class and is refused, never proven.
`gadgets.compact` gains the path, window and byte-hex gadgets the steps read;
the opening circuits' pinned ZKIR is unchanged. `scripts/compile-conduct.mjs`
builds and pins the new unit, and `scripts/conduct/bench.mjs` writes the
measurement circuits of the repository's `bench/conduct`, which the package
does not ship. The circuits stay undeployed, unexported from the package entry
and without a frozen ABI; prior spend, chain continuity and the authenticity
of any root remain stated assumptions of a step.
