# @fluxpointstudios/orynq-openclaw

## 0.3.0

### Minor Changes

- 2efef73: The OpenClaw recorder anchors each bundle once and reports the outcome truthfully.

  `@fluxpointstudios/orynq-sdk-recorder-openclaw`:

  - Dedup keys on the content that is anchored, so an unchanged bundle is never re-posted. 0.2.0 re-posted every bundle on every cycle.
  - A receipt reads `anchored: true` only after the anchor is confirmed. An accepted request is `submitted` and is polled by its requestId, never re-posted on a timer. Only the server's own `anchor_request_not_found` justifies a re-post.
  - Failures retry with jittered exponential backoff capped at 24 hours.
  - Network calls have deadlines that cover the response body, the anchor schedule survives restarts, and one bundle's failure no longer stops the others. A torn spool line costs only that line.

  `@fluxpointstudios/orynq-openclaw`: depends on the fixed recorder with a caret range.

  `@fluxpointstudios/orynq-sdk-process-trace`: the version floor moves to 0.2.0 because npm already holds a 0.2.0 built in February, so this release publishes as 0.3.0 instead of colliding with it.

### Patch Changes

- Updated dependencies [2efef73]
  - @fluxpointstudios/orynq-sdk-recorder-openclaw@0.3.0

## 0.2.0

### Minor Changes

- a571e71: Add a local-first OpenClaw recorder that emits Orynq process-trace bundles/manifests and optionally anchors manifests via Orynq, plus a zero-friction installer CLI with daemon setup.

### Patch Changes

- Updated dependencies [a571e71]
  - @fluxpointstudios/orynq-sdk-recorder-openclaw@0.2.0
