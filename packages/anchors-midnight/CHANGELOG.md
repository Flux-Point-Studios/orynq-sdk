# @fluxpointstudios/orynq-sdk-anchors-midnight

## 0.4.0

### Minor Changes

- 3e5a8ba: Expose bounded, independently replayable GRANDPA checkpoint advancement transcripts and history verification. Hosted follower maintenance retains its original trust scope and every accounting/history row while consuming verified descendants. Standing startup uses a distance-sized bounded allowance and recoverable retry holds; ordinary catch-up limits are unchanged.
- 2556602: Verify portable receipt batch proofs through certificate reconstruction, shape-bound Merkle paths, canonical census manifests and kind-3 Midnight commitments. Require a known batch author inside its window even when a caller pins its key. Identify finality checkpoints, enforce append-only checkpoint history across signed author documents, and expose lookup-only author revalidation.
- f0422aa: Add an immutable proof-presentation contract with current-state gas estimates, bounded transcript-refusal retries (JSON-RPC 1010/custom 104, including gas exhaustion) and headroom for concurrent insertions, local proving and wallet-supplied submission, and verification of its exact deployment and calls through authenticated execution and GRANDPA finality. Export the shared finalized-transaction verifier and identify the legacy ProofPublisher as a simulator. Preprod deployment and both circuits are rehearsed; the immutable mainnet deployment and both synthetic presentations were recorded on 2026-10-27 with independent fresh-consumer consensus-verified verdicts. Export the shared typed/legacy node-refusal decoder and retain numeric refusal codes in redacted source errors. Bind posted-proof trust roots to an allowlisted network genesis and both transactions’ encoded network ids and reject malformed private digests with value-free errors.
- 54d8bd9: Discover a portable Midnight receipt proof from retained gateway hints and an explicit node URL. Bind the requested receipt ID, content and certificate before independently proving execution, runtime and finality under the caller's current author policy. Bound all candidate and RPC traffic with one shared budget and resume forward progress separately from damaged-object repairs.
- dc99b03: Add explicit public RPC-only verification with transaction block hints and authenticated runtime, execution and timestamp witnesses after GRANDPA finality. Cache verified batch sets by source and trust policy while checking current batch-author roles and windows on every hit.
- 95e1f75: Reject duplicate policy JSON members, bind signing to an explicit parsed review, and require authenticated predecessor evidence for appended checkpoints. Label discovery as indexer-reported with author-window status, bound verifier diagnostics, suppress malformed source fields/RPC error bodies, and reject credential-bearing source URLs. CLI bundle errors no longer quote file contents; MCP author trust comes exclusively from the server policy.

### Patch Changes

- a8372ea: Keep posted-proof expectations and trusted finality checkpoints fixed throughout asynchronous verification, so caller mutations cannot relabel a verified transaction or change its deployment and trust configuration.
- 8ab961d: Ship the signed mainnet author policy and original finality checkpoint. Recognize the historical relay window and the hosted batch author, while preserving strict verification and isolating explicitly selected trust domains.
- 4448fd9: Require bounded finalized-node evidence before freeing an anchor claim, retain canonical scan progress and orphan provenance, validate contract-state roots, and typecheck journal regressions. Preserve ambiguous legacy attempts and document the configured-node trust boundary.
- Updated dependencies [ffa932e]
  - @fluxpointstudios/orynq-sdk-core@0.3.2
