/**
 * @summary Minimal trace-bundle factory used by `orynq init` / `orynq trace`.
 *
 * Wraps `@fluxpointstudios/orynq-sdk-process-trace` with a one-call helper
 * that produces a finalised bundle from a single observation event. The
 * heavyweight builder (multi-span, multi-event, custom kinds) lives in
 * the underlying package — quickstart deliberately ships only the
 * "hello world" path so a fresh dev sees a trace land before they're
 * forced to learn span semantics.
 */

import { createHash } from "crypto";
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type { TraceBundle } from "@fluxpointstudios/orynq-sdk-process-trace";

/**
 * Slimmed-down public view of a `TraceBundle` — exposes only the fields
 * `orynq init` / `orynq trace` needs to print + the raw `content` JSON the
 * caller will upload as a blob. The full `bundle` is preserved on the
 * returned object so power-users can still walk events/spans.
 */
export interface TraceBundleLite {
  runId: string;
  agentId: string;
  rootHash: string;
  merkleRoot: string;
  /**
   * SHA-256 of the canonical JSON content payload as a hex string. Set by
   * `firstTraceBundle()` so the same hash that ends up in the on-chain
   * receipt is available without re-canonicalising downstream.
   */
  manifestHash: string;
  /**
   * Canonical JSON serialisation of `bundle.publicView`. This is what we
   * upload to the blob gateway under `contentHash = sha256(content)`.
   */
  content: string;
  /** Original full bundle, in case callers want spans/events. */
  bundle: TraceBundle;
}

/**
 * Optional deterministic-clock + identifier hooks. Used by the
 * documentation tests + recipes that need stable hashes across runs.
 *
 * In normal use (production), callers pass nothing here and let the
 * trace-builder pick wall-clock timestamps + random UUIDs.
 */
export interface DeterministicHooks {
  /** Pin `new Date()`/`Date.now()` for the duration of this call. */
  now?: () => Date;
  /** Pin the run UUID returned by `createTrace`. */
  runId?: string;
  /** Pin the span UUID returned by `addSpan`. */
  spanId?: string;
  /** Pin the event UUID returned by `addEvent`. */
  eventId?: string;
}

export interface FirstTraceBundleOptions extends DeterministicHooks {
  agentId: string;
  /** Free-form one-liner appended as the public observation event. */
  summary: string;
}

/**
 * Build, finalise, and serialise a one-event, one-span trace bundle.
 *
 * The optional `now`/`runId`/`spanId`/`eventId` hooks are useful for tests
 * that need byte-stable hashes; they patch the globals only for the
 * duration of this single call and restore them in a `finally` block so
 * we never leak the patch into surrounding code.
 */
export async function firstTraceBundle(
  opts: FirstTraceBundleOptions,
): Promise<TraceBundleLite> {
  const restore = installDeterministicHooks(opts);
  try {
    const run = await createTrace({ agentId: opts.agentId });
    const span = addSpan(run, { name: "first-trace", visibility: "public" });
    await addEvent<"observation">(run, span.id, {
      kind: "observation",
      observation: opts.summary,
      visibility: "public",
    });
    await closeSpan(run, span.id);
    const bundle = await finalizeTrace(run);

    // Canonicalise the public view (the part we publish) — this is the
    // exact bytes the blob-gateway will checksum at upload time.
    const content = canonicalJson(bundle.publicView);
    const manifestHash = sha256Hex(content);

    return {
      runId: bundle.publicView.runId,
      agentId: bundle.publicView.agentId,
      rootHash: bundle.rootHash,
      merkleRoot: bundle.merkleRoot,
      manifestHash,
      content,
      bundle,
    };
  } finally {
    restore();
  }
}

/**
 * Apply the deterministic-clock + UUID hooks and return a function that
 * undoes them. No-op when no hooks are supplied — the production hot path
 * pays zero cost.
 */
function installDeterministicHooks(hooks: DeterministicHooks): () => void {
  // Capture all originals up front so multiple-restore is a no-op.
  const originalRandomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const originalDate = globalThis.Date;

  let didPatchUuid = false;
  let didPatchDate = false;

  if (hooks.runId || hooks.spanId || hooks.eventId) {
    const queue: string[] = [];
    if (hooks.runId) queue.push(hooks.runId);
    if (hooks.spanId) queue.push(hooks.spanId);
    if (hooks.eventId) queue.push(hooks.eventId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis.crypto as any).randomUUID = (): string => {
      const next = queue.shift();
      if (next) return next;
      return originalRandomUuid
        ? originalRandomUuid()
        : "00000000-0000-4000-8000-000000000000";
    };
    didPatchUuid = true;
  }

  if (hooks.now) {
    const fixed = hooks.now();
    const fixedMs = fixed.getTime();
    // Wrap the Date constructor so `new Date()` (no args) returns the
    // pinned moment; `new Date(ms)` and `new Date(str)` still work.
    const Wrapped = new Proxy(originalDate, {
      construct(target, args) {
        if (args.length === 0) {
          return new (target as DateConstructor)(fixedMs);
        }
        return new (target as DateConstructor)(
          ...(args as ConstructorParameters<DateConstructor>),
        );
      },
      get(target, prop, receiver) {
        if (prop === "now") return () => fixedMs;
        return Reflect.get(target, prop, receiver);
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = Wrapped;
    didPatchDate = true;
  }

  return function restore() {
    if (didPatchUuid && originalRandomUuid) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis.crypto as any).randomUUID = originalRandomUuid;
    }
    if (didPatchDate) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = originalDate;
    }
  };
}

/**
 * Minimal RFC 8785-ish canonical JSON.
 *
 * Sorts keys, strips nulls/undefined. The full RFC 8785 implementation
 * lives in `@fluxpointstudios/orynq-sdk-core/utils` but we deliberately
 * avoid that dependency here so quickstart stays tiny + has zero
 * transitive deps beyond polkadot.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortValue(v));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined || v === null) continue;
      sorted[key] = sortValue(v);
    }
    return sorted;
  }
  return value;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}
