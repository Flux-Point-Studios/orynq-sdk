/**
 * @summary Tests for bundle operations in the process-trace package.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createBundle,
  extractPublicView,
  verifyBundle,
  isPublicSpan,
  isPublicEvent,
  filterPublicEvents,
  signBundle,
  verifyBundleSignature,
  countEventsByVisibility,
  countSpansByVisibility,
  getBundleSpanEvents,
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
} from '../index.js';
import type {
  TraceBundle,
  TraceRun,
  TraceSpan,
  TraceEvent,
  SignatureProvider,
  CommandEvent,
  OutputEvent,
} from '../index.js';

// -----------------------------------------------------------------------------
// Test Fixtures
// -----------------------------------------------------------------------------

async function createTestBundle(options: {
  publicSpans?: number;
  privateSpans?: number;
  secretSpans?: number;
  eventsPerSpan?: number;
}): Promise<TraceBundle> {
  const {
    publicSpans = 1,
    privateSpans = 0,
    secretSpans = 0,
    eventsPerSpan = 2,
  } = options;

  const run = await createTrace({ agentId: 'test-agent' });

  for (let i = 0; i < publicSpans; i++) {
    const span = addSpan(run, { name: `public-${i}`, visibility: 'public' });
    for (let j = 0; j < eventsPerSpan; j++) {
      await addEvent(run, span.id, {
        kind: 'command',
        command: `public-cmd-${i}-${j}`,
        visibility: 'public',
      });
    }
    await closeSpan(run, span.id);
  }

  for (let i = 0; i < privateSpans; i++) {
    const span = addSpan(run, { name: `private-${i}`, visibility: 'private' });
    for (let j = 0; j < eventsPerSpan; j++) {
      await addEvent(run, span.id, {
        kind: 'command',
        command: `private-cmd-${i}-${j}`,
        visibility: 'private',
      });
    }
    await closeSpan(run, span.id);
  }

  for (let i = 0; i < secretSpans; i++) {
    const span = addSpan(run, { name: `secret-${i}`, visibility: 'secret' });
    for (let j = 0; j < eventsPerSpan; j++) {
      await addEvent(run, span.id, {
        kind: 'command',
        command: `secret-cmd-${i}-${j}`,
        visibility: 'secret',
      });
    }
    await closeSpan(run, span.id);
  }

  return finalizeTrace(run);
}

function createMockSignatureProvider(): SignatureProvider {
  return {
    signerId: 'test-signer',
    sign: async (data: Uint8Array): Promise<Uint8Array> => {
      // Simple mock signature: just hash the data (not cryptographically secure)
      const hash = new Uint8Array(64);
      for (let i = 0; i < data.length && i < 64; i++) {
        hash[i] = data[i]!;
      }
      return hash;
    },
    verify: async (
      data: Uint8Array,
      signature: Uint8Array,
      signerId: string
    ): Promise<boolean> => {
      if (signerId !== 'test-signer') return false;
      // Check that signature matches what we would have produced
      for (let i = 0; i < data.length && i < 64; i++) {
        if (signature[i] !== data[i]) return false;
      }
      return true;
    },
  };
}

// -----------------------------------------------------------------------------
// createBundle Tests
// -----------------------------------------------------------------------------

describe('createBundle', () => {
  it('requires finalized run', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    addSpan(run, { name: 'build' });
    // Don't finalize

    await expect(createBundle(run)).rejects.toThrow(/non-finalized/i);
  });

  it('requires completed/failed/cancelled status', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    const span = addSpan(run, { name: 'build' });
    await closeSpan(run, span.id);
    // Manually set rootHash but keep status as running
    run.rootHash = 'a'.repeat(64);

    await expect(createBundle(run)).rejects.toThrow(/running/i);
  });

  it('creates bundle with correct structure', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });

    expect(bundle).toHaveProperty('formatVersion');
    expect(bundle).toHaveProperty('publicView');
    expect(bundle).toHaveProperty('privateRun');
    expect(bundle).toHaveProperty('merkleRoot');
    expect(bundle).toHaveProperty('rootHash');
    expect(bundle.formatVersion).toBe('1.0');
  });

  it('includes all spans in privateRun', async () => {
    const bundle = await createTestBundle({
      publicSpans: 2,
      privateSpans: 3,
    });

    expect(bundle.privateRun.spans).toHaveLength(5);
  });

  it('includes all events in privateRun', async () => {
    const bundle = await createTestBundle({
      publicSpans: 2,
      eventsPerSpan: 3,
    });

    expect(bundle.privateRun.events).toHaveLength(6);
  });
});

// -----------------------------------------------------------------------------
// extractPublicView Tests
// -----------------------------------------------------------------------------

describe('extractPublicView', () => {
  it('filters by visibility', async () => {
    const bundle = await createTestBundle({
      publicSpans: 2,
      privateSpans: 2,
      secretSpans: 1,
    });

    const publicView = extractPublicView(bundle);

    expect(publicView.publicSpans).toHaveLength(2);
    expect(publicView.redactedSpanHashes).toHaveLength(3);
  });

  it('returns same publicView from bundle', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });

    const publicView = extractPublicView(bundle);

    expect(publicView).toBe(bundle.publicView);
  });

  it('includes only public events in public spans', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    const span = addSpan(run, { name: 'build', visibility: 'public' });

    await addEvent(run, span.id, {
      kind: 'command',
      command: 'public-cmd',
      visibility: 'public',
    });
    await addEvent(run, span.id, {
      kind: 'output',
      stream: 'stdout',
      content: 'private-output',
      visibility: 'private',
    });
    await closeSpan(run, span.id);

    const bundle = await finalizeTrace(run);
    const publicView = extractPublicView(bundle);

    expect(publicView.publicSpans[0]?.events).toHaveLength(1);
    expect((publicView.publicSpans[0]?.events[0] as CommandEvent)?.command).toBe('public-cmd');
  });

  it('contains cryptographic commitments', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });

    const publicView = extractPublicView(bundle);

    expect(publicView.rootHash).toHaveLength(64);
    expect(publicView.merkleRoot).toHaveLength(64);
  });

  it('contains run metadata', async () => {
    const bundle = await createTestBundle({ publicSpans: 1, eventsPerSpan: 3 });

    const publicView = extractPublicView(bundle);

    expect(publicView.runId).toBeDefined();
    expect(publicView.agentId).toBe('test-agent');
    expect(publicView.schemaVersion).toBe('1.0');
    expect(publicView.totalEvents).toBe(3);
    expect(publicView.totalSpans).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// verifyBundle Tests
// -----------------------------------------------------------------------------

describe('verifyBundle', () => {
  it('valid bundle passes all checks', async () => {
    const bundle = await createTestBundle({
      publicSpans: 2,
      privateSpans: 1,
      eventsPerSpan: 3,
    });

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.checks.rollingHashValid).toBe(true);
    expect(result.checks.rootHashValid).toBe(true);
    expect(result.checks.merkleRootValid).toBe(true);
    expect(result.checks.spanHashesValid).toBe(true);
    expect(result.checks.eventHashesValid).toBe(true);
    expect(result.checks.sequenceValid).toBe(true);
  });

  it('tampered event hash fails', async () => {
    const bundle = await createTestBundle({ publicSpans: 1, eventsPerSpan: 2 });

    // Tamper with an event hash
    bundle.privateRun.events[0]!.hash = 'tampered' + bundle.privateRun.events[0]!.hash!.slice(8);

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.checks.eventHashesValid).toBe(false);
    expect(result.errors.some((e) => e.includes('Event hash mismatch'))).toBe(true);
  });

  it('tampered rolling hash fails', async () => {
    const bundle = await createTestBundle({ publicSpans: 1, eventsPerSpan: 2 });

    // Tamper with rolling hash
    bundle.privateRun.rollingHash = 'tampered' + bundle.privateRun.rollingHash.slice(8);

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.checks.rollingHashValid).toBe(false);
    expect(result.errors.some((e) => e.includes('Rolling hash mismatch'))).toBe(true);
  });

  it('tampered span hash fails', async () => {
    const bundle = await createTestBundle({ publicSpans: 1, eventsPerSpan: 2 });

    // Tamper with span hash
    bundle.privateRun.spans[0]!.hash = 'tampered' + bundle.privateRun.spans[0]!.hash!.slice(8);

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.checks.spanHashesValid).toBe(false);
  });

  it('tampered root hash fails', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });

    // Tamper with root hash
    bundle.rootHash = 'tampered' + bundle.rootHash.slice(8);

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.checks.rootHashValid).toBe(false);
  });

  it('tampered merkle root fails', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });

    // Tamper with merkle root
    bundle.merkleRoot = 'tampered' + bundle.merkleRoot.slice(8);

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.checks.merkleRootValid).toBe(false);
  });

  it('invalid event sequence fails', async () => {
    const bundle = await createTestBundle({ publicSpans: 1, eventsPerSpan: 3 });

    // Break sequence by modifying seq
    bundle.privateRun.events[1]!.seq = 5; // Should be 1

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.checks.sequenceValid).toBe(false);
    expect(result.errors.some((e) => e.includes('sequence gap'))).toBe(true);
  });

  it('invalid span sequence fails', async () => {
    const bundle = await createTestBundle({ publicSpans: 3 });

    // Break sequence by modifying spanSeq
    bundle.privateRun.spans[1]!.spanSeq = 5; // Should be 1

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(false);
    expect(result.checks.sequenceValid).toBe(false);
    expect(result.errors.some((e) => e.includes('Span sequence gap'))).toBe(true);
  });

  it('warns when no public spans exist', async () => {
    const bundle = await createTestBundle({
      publicSpans: 0,
      privateSpans: 2,
    });

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('No public spans'))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Public View Content Tests
// -----------------------------------------------------------------------------

describe('public view content', () => {
  it('contains only public spans', async () => {
    const bundle = await createTestBundle({
      publicSpans: 3,
      privateSpans: 2,
      secretSpans: 1,
    });

    const publicView = bundle.publicView;

    expect(publicView.publicSpans).toHaveLength(3);
    for (const span of publicView.publicSpans) {
      expect(span.visibility).toBe('public');
    }
  });

  it('contains only public events in public spans', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    const span = addSpan(run, { name: 'build', visibility: 'public' });

    await addEvent(run, span.id, {
      kind: 'command',
      command: 'public',
      visibility: 'public',
    });
    await addEvent(run, span.id, {
      kind: 'output',
      stream: 'stdout',
      content: 'private',
      visibility: 'private',
    });
    await addEvent(run, span.id, {
      kind: 'command',
      command: 'secret',
      visibility: 'secret',
    });
    await closeSpan(run, span.id);

    const bundle = await finalizeTrace(run);

    expect(bundle.publicView.publicSpans[0]?.events).toHaveLength(1);
    expect((bundle.publicView.publicSpans[0]?.events[0] as CommandEvent)?.command).toBe('public');
  });

  it('redacted hashes for non-public spans', async () => {
    const bundle = await createTestBundle({
      publicSpans: 1,
      privateSpans: 2,
      secretSpans: 1,
    });

    const publicView = bundle.publicView;

    expect(publicView.redactedSpanHashes).toHaveLength(3);
    for (const redacted of publicView.redactedSpanHashes) {
      expect(redacted.spanId).toBeDefined();
      expect(redacted.hash).toHaveLength(64);
    }
  });

  it('public spans are sorted by spanSeq', async () => {
    const bundle = await createTestBundle({
      publicSpans: 5,
    });

    const publicView = bundle.publicView;
    const spanSeqs = publicView.publicSpans.map((s) => s.spanSeq);

    for (let i = 1; i < spanSeqs.length; i++) {
      expect(spanSeqs[i]).toBeGreaterThan(spanSeqs[i - 1]!);
    }
  });
});

// -----------------------------------------------------------------------------
// Visibility Helper Tests
// -----------------------------------------------------------------------------

describe('isPublicSpan', () => {
  it('returns true for public span', () => {
    const span: TraceSpan = {
      id: 'test',
      spanSeq: 0,
      name: 'test',
      status: 'completed',
      visibility: 'public',
      startedAt: new Date().toISOString(),
      eventIds: [],
      childSpanIds: [],
    };

    expect(isPublicSpan(span)).toBe(true);
  });

  it('returns false for private span', () => {
    const span: TraceSpan = {
      id: 'test',
      spanSeq: 0,
      name: 'test',
      status: 'completed',
      visibility: 'private',
      startedAt: new Date().toISOString(),
      eventIds: [],
      childSpanIds: [],
    };

    expect(isPublicSpan(span)).toBe(false);
  });

  it('returns false for secret span', () => {
    const span: TraceSpan = {
      id: 'test',
      spanSeq: 0,
      name: 'test',
      status: 'completed',
      visibility: 'secret',
      startedAt: new Date().toISOString(),
      eventIds: [],
      childSpanIds: [],
    };

    expect(isPublicSpan(span)).toBe(false);
  });
});

describe('isPublicEvent', () => {
  it('returns true for public event', () => {
    const event: TraceEvent = {
      kind: 'command',
      id: 'test',
      seq: 0,
      timestamp: new Date().toISOString(),
      visibility: 'public',
      command: 'npm install',
    };

    expect(isPublicEvent(event)).toBe(true);
  });

  it('returns false for private event', () => {
    const event: TraceEvent = {
      kind: 'command',
      id: 'test',
      seq: 0,
      timestamp: new Date().toISOString(),
      visibility: 'private',
      command: 'npm install',
    };

    expect(isPublicEvent(event)).toBe(false);
  });

  it('returns false for secret event', () => {
    const event: TraceEvent = {
      kind: 'command',
      id: 'test',
      seq: 0,
      timestamp: new Date().toISOString(),
      visibility: 'secret',
      command: 'npm install',
    };

    expect(isPublicEvent(event)).toBe(false);
  });
});

describe('filterPublicEvents', () => {
  it('returns only public events', () => {
    const events: TraceEvent[] = [
      {
        kind: 'command',
        id: '1',
        seq: 0,
        timestamp: new Date().toISOString(),
        visibility: 'public',
        command: 'public',
      },
      {
        kind: 'command',
        id: '2',
        seq: 1,
        timestamp: new Date().toISOString(),
        visibility: 'private',
        command: 'private',
      },
      {
        kind: 'command',
        id: '3',
        seq: 2,
        timestamp: new Date().toISOString(),
        visibility: 'public',
        command: 'public2',
      },
    ];

    const filtered = filterPublicEvents(events);

    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.visibility === 'public')).toBe(true);
  });

  it('returns empty array when no public events', () => {
    const events: TraceEvent[] = [
      {
        kind: 'command',
        id: '1',
        seq: 0,
        timestamp: new Date().toISOString(),
        visibility: 'private',
        command: 'private',
      },
    ];

    const filtered = filterPublicEvents(events);

    expect(filtered).toHaveLength(0);
  });

  it('returns all events when all are public', () => {
    const events: TraceEvent[] = [
      {
        kind: 'command',
        id: '1',
        seq: 0,
        timestamp: new Date().toISOString(),
        visibility: 'public',
        command: 'public1',
      },
      {
        kind: 'command',
        id: '2',
        seq: 1,
        timestamp: new Date().toISOString(),
        visibility: 'public',
        command: 'public2',
      },
    ];

    const filtered = filterPublicEvents(events);

    expect(filtered).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// Bundle Signing Tests
// -----------------------------------------------------------------------------

describe('signBundle', () => {
  it('adds signature to bundle', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });
    const provider = createMockSignatureProvider();

    const signedBundle = await signBundle(bundle, provider);

    expect(signedBundle.signature).toBeDefined();
    expect(signedBundle.signerId).toBe('test-signer');
  });

  it('returns new bundle (does not mutate original)', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });
    const provider = createMockSignatureProvider();

    const signedBundle = await signBundle(bundle, provider);

    expect(signedBundle).not.toBe(bundle);
    expect(bundle.signature).toBeUndefined();
    expect(signedBundle.signature).toBeDefined();
  });

  it('signature is hex encoded', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });
    const provider = createMockSignatureProvider();

    const signedBundle = await signBundle(bundle, provider);

    expect(signedBundle.signature).toMatch(/^[a-f0-9]+$/);
  });
});

describe('verifyBundleSignature', () => {
  it('returns true for valid signature', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });
    const provider = createMockSignatureProvider();
    const signedBundle = await signBundle(bundle, provider);

    const isValid = await verifyBundleSignature(signedBundle, provider);

    expect(isValid).toBe(true);
  });

  it('returns false for missing signature', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });
    const provider = createMockSignatureProvider();

    const isValid = await verifyBundleSignature(bundle, provider);

    expect(isValid).toBe(false);
  });

  it('returns false for wrong signer', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });
    const provider = createMockSignatureProvider();
    const signedBundle = await signBundle(bundle, provider);

    // Change signer ID
    signedBundle.signerId = 'wrong-signer';

    const isValid = await verifyBundleSignature(signedBundle, provider);

    expect(isValid).toBe(false);
  });

  it('returns false for tampered signature', async () => {
    const bundle = await createTestBundle({ publicSpans: 1 });
    const provider = createMockSignatureProvider();
    const signedBundle = await signBundle(bundle, provider);

    // Tamper with signature
    signedBundle.signature = '00' + signedBundle.signature!.slice(2);

    const isValid = await verifyBundleSignature(signedBundle, provider);

    expect(isValid).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Utility Function Tests
// -----------------------------------------------------------------------------

describe('countEventsByVisibility', () => {
  it('counts events correctly', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    const span = addSpan(run, { name: 'build' });

    await addEvent(run, span.id, { kind: 'command', command: '1', visibility: 'public' });
    await addEvent(run, span.id, { kind: 'command', command: '2', visibility: 'public' });
    await addEvent(run, span.id, { kind: 'command', command: '3', visibility: 'private' });
    await addEvent(run, span.id, { kind: 'command', command: '4', visibility: 'secret' });

    const counts = countEventsByVisibility(run);

    expect(counts.public).toBe(2);
    expect(counts.private).toBe(1);
    expect(counts.secret).toBe(1);
  });

  it('returns zeros for empty run', async () => {
    const run = await createTrace({ agentId: 'test-agent' });

    const counts = countEventsByVisibility(run);

    expect(counts.public).toBe(0);
    expect(counts.private).toBe(0);
    expect(counts.secret).toBe(0);
  });
});

describe('countSpansByVisibility', () => {
  it('counts spans correctly', async () => {
    const run = await createTrace({ agentId: 'test-agent' });

    addSpan(run, { name: 'public1', visibility: 'public' });
    addSpan(run, { name: 'public2', visibility: 'public' });
    addSpan(run, { name: 'private1', visibility: 'private' });
    addSpan(run, { name: 'secret1', visibility: 'secret' });
    addSpan(run, { name: 'secret2', visibility: 'secret' });

    const counts = countSpansByVisibility(run);

    expect(counts.public).toBe(2);
    expect(counts.private).toBe(1);
    expect(counts.secret).toBe(2);
  });

  it('returns zeros for empty run', async () => {
    const run = await createTrace({ agentId: 'test-agent' });

    const counts = countSpansByVisibility(run);

    expect(counts.public).toBe(0);
    expect(counts.private).toBe(0);
    expect(counts.secret).toBe(0);
  });
});

describe('getBundleSpanEvents', () => {
  it('returns events for span sorted by seq', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    const span = addSpan(run, { name: 'build' });

    const e1 = await addEvent(run, span.id, { kind: 'command', command: 'first', visibility: 'public' });
    const e2 = await addEvent(run, span.id, { kind: 'output', stream: 'stdout', content: 'second', visibility: 'private' });
    const e3 = await addEvent(run, span.id, { kind: 'command', command: 'third', visibility: 'public' });

    const events = getBundleSpanEvents(span, run.events);

    expect(events).toHaveLength(3);
    expect(events[0]).toBe(e1);
    expect(events[1]).toBe(e2);
    expect(events[2]).toBe(e3);
  });

  it('returns empty array for span with no events', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    const span = addSpan(run, { name: 'empty' });

    const events = getBundleSpanEvents(span, run.events);

    expect(events).toHaveLength(0);
  });

  it('ignores events not in span', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    const span1 = addSpan(run, { name: 'span1' });
    const span2 = addSpan(run, { name: 'span2' });

    await addEvent(run, span1.id, { kind: 'command', command: 'span1-event', visibility: 'public' });
    await addEvent(run, span2.id, { kind: 'command', command: 'span2-event', visibility: 'public' });

    const events = getBundleSpanEvents(span1, run.events);

    expect(events).toHaveLength(1);
    expect((events[0] as CommandEvent)?.command).toBe('span1-event');
  });
});

// -----------------------------------------------------------------------------
// Edge Cases
// -----------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles bundle with no spans', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    const bundle = await finalizeTrace(run);

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(true);
    expect(bundle.publicView.publicSpans).toHaveLength(0);
    expect(bundle.publicView.redactedSpanHashes).toHaveLength(0);
  });

  it('handles bundle with only secret spans', async () => {
    const bundle = await createTestBundle({
      publicSpans: 0,
      privateSpans: 0,
      secretSpans: 3,
    });

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(true);
    expect(bundle.publicView.publicSpans).toHaveLength(0);
    expect(bundle.publicView.redactedSpanHashes).toHaveLength(3);
  });

  it('handles bundle with only public spans', async () => {
    const bundle = await createTestBundle({
      publicSpans: 5,
      privateSpans: 0,
      secretSpans: 0,
    });

    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(true);
    expect(bundle.publicView.publicSpans).toHaveLength(5);
    expect(bundle.publicView.redactedSpanHashes).toHaveLength(0);
  });

  it('handles mixed visibility events within public span', async () => {
    const run = await createTrace({ agentId: 'test-agent' });
    const span = addSpan(run, { name: 'mixed', visibility: 'public' });

    await addEvent(run, span.id, { kind: 'command', command: 'public', visibility: 'public' });
    await addEvent(run, span.id, { kind: 'output', stream: 'stdout', content: 'private', visibility: 'private' });
    await addEvent(run, span.id, { kind: 'command', command: 'secret', visibility: 'secret' });
    await closeSpan(run, span.id);

    const bundle = await finalizeTrace(run);
    const result = await verifyBundle(bundle);

    expect(result.valid).toBe(true);
    expect(bundle.publicView.publicSpans[0]?.events).toHaveLength(1);
    expect(bundle.privateRun.events).toHaveLength(3);
  });
});
