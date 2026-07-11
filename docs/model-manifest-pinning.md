# Pre-execution model-manifest pinning (issue #59)

Orynq can now prove **"neither the data nor the model was altered over the run"**
by pinning a *model manifest* — a fingerprint of the model/data state — **before**
execution begins, and freezing its hash at trace creation.

This is distinct from the off-chain *storage* manifest (`TraceManifest` in
`manifest.ts`). The model manifest lives on `TraceRun` / `TraceBundle` as
`modelManifest` + `modelManifestHash`.

## Quickstart

```ts
import {
  createTrace,
  finalizeTrace,
  manifestFromHuggingFace,
} from "@fluxpointstudios/orynq-sdk-process-trace";

const manifest = await manifestFromHuggingFace({
  modelId: "meta-llama/Llama-3.1-8B",
  revision: "0e9e39f249a16976918f6564b8830bc894c89659", // commit sha → immutable pin
});

const run = await createTrace({ agentId: "agent-1", manifest, strict: true });
// ... record spans/events ...
const bundle = await finalizeTrace(run);

bundle.modelManifestHash; // sha256 commitment, place this in your anchor metadata
```

### Framework builders

All builders are deterministic — two traces of "the same model" produce the same
`modelManifestHash`:

| Builder | Use |
| --- | --- |
| `manifestFromHuggingFace({ modelId, revision })` | HF repos (pass a commit sha) |
| `manifestFromOpenAI({ model, snapshotId })` | OpenAI (pass a dated snapshot) |
| `manifestFromAnthropic({ model, snapshotId })` | Anthropic (pass a dated snapshot) |
| `manifestFromCheckpoint(filepath)` | local checkpoint (hashes file bytes) |

You can also pass a raw `systemPrompt` (hashed into `systemPromptHash`),
`tokenizerHash`, and `trainingDataManifest`.

## Guarantees

1. **Pinned before execution.** The hash is computed in `createTrace()` before any
   event is recorded — operators can't retroactively pin a *different* model.
2. **Immutable.** The manifest object is deep-frozen; mutating it after creation
   throws.
3. **Enforced at finalize (strict mode).** `finalizeTrace()` refuses to finalize a
   strict run that has no manifest.

## Modes

- **`strict: false` (default, v0.x — warn-only):** `finalizeTrace()` logs a warning
  if no manifest was pinned, but still produces a bundle. This is the migration
  path.
- **`strict: true`:** `createTrace()` requires a `manifest`; `finalizeTrace()`
  throws if none is pinned.

## Migration guide (existing traces)

Existing code keeps working unchanged — `manifest`/`strict` are optional and the
default is warn-only:

1. **Today (no change required):** your traces finalize as before. You'll see a
   one-line warning recommending a manifest.
2. **Add a manifest (recommended):** pass `manifest` to `createTrace()` using the
   builder that matches your model provider. Anchor `bundle.modelManifestHash`
   alongside `rootHash` so model drift becomes cryptographically detectable.
3. **Opt into enforcement:** once your pipelines always pin a manifest, set
   `strict: true` to turn the warning into a hard error.

## ⚠️ Breaking change planned for v1.0

`strict` will default to **`true`** in v1.0. Traces finalized without a pinned
model manifest will throw instead of warning. To prepare:

- Start pinning manifests now (warn-only surfaces every call site that needs one).
- Treat the `[orynq] finalizeTrace: no model manifest was pinned` warning as a
  pre-v1.0 to-do list.
- When ready, flip `strict: true` per-trace to validate before the default flips.
