---
"@fluxpointstudios/orynq-sdk-midnight-prover": patch
---

The repository's conduct measurement tool, `bench/conduct/measure.mjs`, which
the package does not ship, keys and proves circuits up to k=17. It still
refuses a circuit whose parameters are absent, any k above 17, an `--out`
inside the repository, a parameter source that could download and a parameter
file that differs from the installer's pin, and it records the reason each
circuit it leaves out is unmeasured.

`circuits/conduct/README.md` records the first keys and natively verified
proofs of `check_verdict` (k=10), `m_step` (k=15), the bench circuit
`b_allowlist_d4` (k=15) and the nine step circuits at k=17 (`st_pa`, `st_pd1`
to `st_pd4`, `st_ea`, `st_ed1`, `st_ed2` and `st_ed6`), each on a synthetic
in-class witness: three proofs verified, and four bit flips and a zeroed proof
refused. The sizes and timings are evidence of one host, not pins, and no key
or proof ships. `st_pa_max_d8` (k=18) and every other circuit at k=18 or 19
still have no key or proof. A verified proof shows that the proof system
accepts the statement for that witness; the circuits stay undeployed
prototypes without a frozen ABI, and every assumption and non-claim the README
lists stands, among them the stated prior spend, chain continuity, the
authenticity of inputs and roots, and any cumulative claim.
