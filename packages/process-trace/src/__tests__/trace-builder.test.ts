/**
 * @summary Tests for trace building functionality in the process-trace package.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTrace,
  addSpan,
  addEvent,
  closeSpan,
  finalizeTrace,
  getSpan,
  getSpanEvents,
  isFinalized,
  getEventCount,
  getSpanCount,
  getRootSpans,
  getChildSpans,
  getEvent,
  getEventsByKind,
  DEFAULT_EVENT_VISIBILITY,
} from '../index.js';
import type {
  TraceRun,
  TraceSpan,
  TraceEvent,
  TraceBundle,
  CommandEvent,
  OutputEvent,
  DecisionEvent,
} from '../index.js';

// -----------------------------------------------------------------------------
// createTrace Tests
// -----------------------------------------------------------------------------

describe('createTrace', () => {
  it('initializes correctly with required fields', async () => {
    const run = await createTrace({ agentId: 'test-agent' });

    expect(run).toHaveProperty('id');
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(run.schemaVersion).toBe('1.0');
    expect(run.agentId).toBe('test-agent');
    expect(run.status).toBe('running');
    expect(run.events).toEqual([]);
    expect(run.spans).toEqual([]);
    expect(run.nextSeq).toBe(0);
    expect(run.nextSpanSeq).toBe(0);
  });

  it('sets startedAt timestamp', async () => {
    const before = new Date().toISOString();
    const run = await createTrace({ agentId: 'test-agent' });
    const after = new Date().toISOString();

    expect(run.startedAt).toBeDefined();
    expect(run.startedAt >= before).toBe(true);
    expect(run.startedAt <= after).toBe(true);
  });

  it('initializes rolling hash to genesis', async () => {
    const run = await createTrace({ agentId: 'test-agent' });

    expect(run.rollingHash).toBeDefined();
    expect(run.rollingHash).toHaveLength(64);
    expect(run.rollingHash).toMatch(/^[a-f0-9]+$/);
  });

  it('accepts optional description', async () => {
    const run = await createTrace({
      agentId: 'test-agent',
      description: 'Test run description',
    });

    expect(run.metadata?.description).toBe('Test run description');
  });

  it('accepts optional metadata', async () => {
    const run = await createTrace({
      agentId: 'test-agent',
      metadata: {
        environment: 'test',
        version: '1.0.0',
      },
    });

    expect(run.metadata?.environment).toBe('test');
    expect(run.metadata?.version).toBe('1.0.0');
  });

  it('throws error for missing agentId', async () => {
    await expect(
      // @ts-expect-error - Testing runtime validation
      createTrace({})
    ).rejects.toThrow(/agentId/);
  });

  it('throws error for empty agentId', async () => {
    await expect(
      createTrace({ agentId: '' })
    ).rejects.toThrow(/agentId/);
  });

  it('generates unique run IDs', async () => {
    const run1 = await createTrace({ agentId: 'test-agent' });
    const run2 = await createTrace({ agentId: 'test-agent' });

    expect(run1.id).not.toBe(run2.id);
  });
});

// -----------------------------------------------------------------------------
// addSpan Tests
// -----------------------------------------------------------------------------

describe('addSpan', () => {
  let run: TraceRun;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
  });

  it('creates span with correct fields', () => {
    const span = addSpan(run, { name: 'build' });

    expect(span.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(span.spanSeq).toBe(0);
    expect(span.name).toBe('build');
    expect(span.status).toBe('running');
    expect(span.visibility).toBe('private'); // default
    expect(span.eventIds).toEqual([]);
    expect(span.childSpanIds).toEqual([]);
    expect(span.startedAt).toBeDefined();
  });

  it('increments spanSeq monotonically', () => {
    const span1 = addSpan(run, { name: 'span1' });
    const span2 = addSpan(run, { name: 'span2' });
    const span3 = addSpan(run, { name: 'span3' });

    expect(span1.spanSeq).toBe(0);
    expect(span2.spanSeq).toBe(1);
    expect(span3.spanSeq).toBe(2);
  });

  it('accepts custom visibility', () => {
    const publicSpan = addSpan(run, { name: 'public', visibility: 'public' });
    const privateSpan = addSpan(run, { name: 'private', visibility: 'private' });
    const secretSpan = addSpan(run, { name: 'secret', visibility: 'secret' });

    expect(publicSpan.visibility).toBe('public');
    expect(privateSpan.visibility).toBe('private');
    expect(secretSpan.visibility).toBe('secret');
  });

  it('accepts parent span ID', () => {
    const parentSpan = addSpan(run, { name: 'parent' });
    const childSpan = addSpan(run, { name: 'child', parentSpanId: parentSpan.id });

    expect(childSpan.parentSpanId).toBe(parentSpan.id);
    expect(parentSpan.childSpanIds).toContain(childSpan.id);
  });

  it('accepts metadata', () => {
    const span = addSpan(run, {
      name: 'build',
      metadata: { tool: 'npm', version: '10.0' },
    });

    expect(span.metadata?.tool).toBe('npm');
    expect(span.metadata?.version).toBe('10.0');
  });

  it('adds span to run.spans', () => {
    const span = addSpan(run, { name: 'build' });

    expect(run.spans).toContain(span);
    expect(run.spans).toHaveLength(1);
  });

  it('throws error for missing name', () => {
    expect(() =>
      // @ts-expect-error - Testing runtime validation
      addSpan(run, {})
    ).toThrow(/name/);
  });

  it('throws error for empty name', () => {
    expect(() =>
      addSpan(run, { name: '' })
    ).toThrow(/name/);
  });

  it('throws error for non-existent parent span', () => {
    expect(() =>
      addSpan(run, { name: 'child', parentSpanId: 'non-existent-id' })
    ).toThrow(/Parent span not found/);
  });

  it('throws error for closed parent span', async () => {
    const parentSpan = addSpan(run, { name: 'parent' });
    await closeSpan(run, parentSpan.id);

    expect(() =>
      addSpan(run, { name: 'child', parentSpanId: parentSpan.id })
    ).toThrow(/not running/);
  });

  it('throws error after finalization', async () => {
    const span = addSpan(run, { name: 'build' });
    await closeSpan(run, span.id);
    await finalizeTrace(run);

    expect(() =>
      addSpan(run, { name: 'new-span' })
    ).toThrow(/finalized/);
  });
});

// -----------------------------------------------------------------------------
// addEvent Tests
// -----------------------------------------------------------------------------

describe('addEvent', () => {
  let run: TraceRun;
  let span: TraceSpan;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
    span = addSpan(run, { name: 'build' });
  });

  it('assigns seq number', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });

    expect(event.seq).toBe(0);
  });

  it('increments seq monotonically', async () => {
    const event1 = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });
    const event2 = await addEvent(run, span.id, {
      kind: 'output',
      stream: 'stdout',
      content: 'done',
      visibility: 'private',
    });
    const event3 = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm build',
      visibility: 'public',
    });

    expect(event1.seq).toBe(0);
    expect(event2.seq).toBe(1);
    expect(event3.seq).toBe(2);
  });

  it('computes event hash', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });

    expect(event.hash).toBeDefined();
    expect(event.hash).toHaveLength(64);
    expect(event.hash).toMatch(/^[a-f0-9]+$/);
  });

  it('updates rolling hash', async () => {
    const initialHash = run.rollingHash;

    await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });

    expect(run.rollingHash).not.toBe(initialHash);
    expect(run.rollingHash).toHaveLength(64);
  });

  it('adds event ID to span.eventIds', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });

    expect(span.eventIds).toContain(event.id);
  });

  it('adds event to run.events', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });

    expect(run.events).toContain(event);
  });

  it('sets timestamp', async () => {
    const before = new Date().toISOString();
    const event = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });
    const after = new Date().toISOString();

    expect(event.timestamp >= before).toBe(true);
    expect(event.timestamp <= after).toBe(true);
  });

  it('applies default visibility for command events', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
    });

    expect(event.visibility).toBe(DEFAULT_EVENT_VISIBILITY.command);
    expect(event.visibility).toBe('public');
  });

  it('applies default visibility for output events', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'output',
      stream: 'stdout',
      content: 'output',
    });

    expect(event.visibility).toBe(DEFAULT_EVENT_VISIBILITY.output);
    expect(event.visibility).toBe('private');
  });

  it('applies default visibility for decision events', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'decision',
      decision: 'use TypeScript',
    });

    expect(event.visibility).toBe(DEFAULT_EVENT_VISIBILITY.decision);
    expect(event.visibility).toBe('private');
  });

  it('allows overriding default visibility', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'output',
      stream: 'stdout',
      content: 'public output',
      visibility: 'public',
    });

    expect(event.visibility).toBe('public');
  });

  it('throws error for non-existent span', async () => {
    await expect(
      addEvent(run, 'non-existent-span', {
        kind: 'command',
        command: 'npm install',
        visibility: 'public',
      })
    ).rejects.toThrow(/Span not found/);
  });

  it('throws error for closed span', async () => {
    await closeSpan(run, span.id);

    await expect(
      addEvent(run, span.id, {
        kind: 'command',
        command: 'npm install',
        visibility: 'public',
      })
    ).rejects.toThrow(/closed span/);
  });

  it('throws error after finalization', async () => {
    await closeSpan(run, span.id);
    await finalizeTrace(run);

    await expect(
      addEvent(run, span.id, {
        kind: 'command',
        command: 'npm install',
        visibility: 'public',
      })
    ).rejects.toThrow(/finalized/);
  });

  it('throws error for missing kind', async () => {
    await expect(
      addEvent(run, span.id, {
        // @ts-expect-error - Testing runtime validation
        command: 'npm install',
      })
    ).rejects.toThrow(/kind/);
  });
});

// -----------------------------------------------------------------------------
// closeSpan Tests
// -----------------------------------------------------------------------------

describe('closeSpan', () => {
  let run: TraceRun;
  let span: TraceSpan;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
    span = addSpan(run, { name: 'build' });
  });

  it('sets endedAt timestamp', async () => {
    const before = new Date().toISOString();
    await closeSpan(run, span.id);
    const after = new Date().toISOString();

    expect(span.endedAt).toBeDefined();
    expect(span.endedAt! >= before).toBe(true);
    expect(span.endedAt! <= after).toBe(true);
  });

  it('sets durationMs', async () => {
    await closeSpan(run, span.id);

    expect(span.durationMs).toBeDefined();
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('computes span hash', async () => {
    await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });
    await closeSpan(run, span.id);

    expect(span.hash).toBeDefined();
    expect(span.hash).toHaveLength(64);
    expect(span.hash).toMatch(/^[a-f0-9]+$/);
  });

  it('sets status to completed by default', async () => {
    await closeSpan(run, span.id);

    expect(span.status).toBe('completed');
  });

  it('accepts custom status', async () => {
    await closeSpan(run, span.id, 'failed');

    expect(span.status).toBe('failed');
  });

  it('throws error for non-existent span', async () => {
    await expect(
      closeSpan(run, 'non-existent-span')
    ).rejects.toThrow(/Span not found/);
  });

  it('throws error for already closed span', async () => {
    await closeSpan(run, span.id);

    await expect(
      closeSpan(run, span.id)
    ).rejects.toThrow(/already closed/);
  });
});

// -----------------------------------------------------------------------------
// finalizeTrace Tests
// -----------------------------------------------------------------------------

describe('finalizeTrace', () => {
  let run: TraceRun;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
  });

  it('builds bundle with all hashes', async () => {
    const span = addSpan(run, { name: 'build', visibility: 'public' });
    await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });
    await closeSpan(run, span.id);

    const bundle = await finalizeTrace(run);

    expect(bundle).toHaveProperty('rootHash');
    expect(bundle).toHaveProperty('merkleRoot');
    expect(bundle).toHaveProperty('publicView');
    expect(bundle).toHaveProperty('privateRun');
    expect(bundle.rootHash).toHaveLength(64);
    expect(bundle.merkleRoot).toHaveLength(64);
  });

  it('sets run status to completed', async () => {
    const span = addSpan(run, { name: 'build' });
    await closeSpan(run, span.id);

    await finalizeTrace(run);

    expect(run.status).toBe('completed');
  });

  it('sets run endedAt and durationMs', async () => {
    const span = addSpan(run, { name: 'build' });
    await closeSpan(run, span.id);

    await finalizeTrace(run);

    expect(run.endedAt).toBeDefined();
    expect(run.durationMs).toBeDefined();
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('closes open spans automatically', async () => {
    const span = addSpan(run, { name: 'build' });
    // Don't close the span

    await finalizeTrace(run);

    expect(span.status).toBe('completed');
    expect(span.hash).toBeDefined();
  });

  it('throws error if already finalized', async () => {
    const span = addSpan(run, { name: 'build' });
    await closeSpan(run, span.id);
    await finalizeTrace(run);

    await expect(
      finalizeTrace(run)
    ).rejects.toThrow(/already finalized/);
  });

  it('bundle contains public view with public spans', async () => {
    const publicSpan = addSpan(run, { name: 'public', visibility: 'public' });
    await addEvent(run, publicSpan.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });
    await closeSpan(run, publicSpan.id);

    const privateSpan = addSpan(run, { name: 'private', visibility: 'private' });
    await addEvent(run, privateSpan.id, {
      kind: 'command',
      command: 'secret command',
      visibility: 'private',
    });
    await closeSpan(run, privateSpan.id);

    const bundle = await finalizeTrace(run);

    expect(bundle.publicView.publicSpans).toHaveLength(1);
    expect(bundle.publicView.publicSpans[0]?.name).toBe('public');
    expect(bundle.publicView.redactedSpanHashes).toHaveLength(1);
  });

  it('handles empty trace', async () => {
    const bundle = await finalizeTrace(run);

    expect(bundle.rootHash).toBeDefined();
    expect(bundle.publicView.publicSpans).toHaveLength(0);
    expect(bundle.publicView.totalSpans).toBe(0);
    expect(bundle.publicView.totalEvents).toBe(0);
  });

  it('formatVersion matches schema version', async () => {
    const span = addSpan(run, { name: 'build' });
    await closeSpan(run, span.id);

    const bundle = await finalizeTrace(run);

    expect(bundle.formatVersion).toBe('1.0');
  });
});

// -----------------------------------------------------------------------------
// Query Function Tests
// -----------------------------------------------------------------------------

describe('getSpan', () => {
  let run: TraceRun;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
  });

  it('returns span by ID', () => {
    const span = addSpan(run, { name: 'build' });

    const found = getSpan(run, span.id);

    expect(found).toBe(span);
  });

  it('returns undefined for non-existent ID', () => {
    const found = getSpan(run, 'non-existent');

    expect(found).toBeUndefined();
  });
});

describe('getSpanEvents', () => {
  let run: TraceRun;
  let span: TraceSpan;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
    span = addSpan(run, { name: 'build' });
  });

  it('returns events for span sorted by seq', async () => {
    const event1 = await addEvent(run, span.id, {
      kind: 'command',
      command: 'first',
      visibility: 'public',
    });
    const event2 = await addEvent(run, span.id, {
      kind: 'output',
      stream: 'stdout',
      content: 'second',
      visibility: 'private',
    });

    const events = getSpanEvents(run, span.id);

    expect(events).toHaveLength(2);
    expect(events[0]).toBe(event1);
    expect(events[1]).toBe(event2);
  });

  it('returns empty array for span with no events', () => {
    const events = getSpanEvents(run, span.id);

    expect(events).toEqual([]);
  });

  it('returns empty array for non-existent span', () => {
    const events = getSpanEvents(run, 'non-existent');

    expect(events).toEqual([]);
  });
});

describe('isFinalized', () => {
  let run: TraceRun;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
  });

  it('returns false for new run', () => {
    expect(isFinalized(run)).toBe(false);
  });

  it('returns true after finalization', async () => {
    const span = addSpan(run, { name: 'build' });
    await closeSpan(run, span.id);
    await finalizeTrace(run);

    expect(isFinalized(run)).toBe(true);
  });
});

describe('getEventCount', () => {
  let run: TraceRun;
  let span: TraceSpan;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
    span = addSpan(run, { name: 'build' });
  });

  it('returns 0 for new run', () => {
    expect(getEventCount(run)).toBe(0);
  });

  it('returns correct count after adding events', async () => {
    await addEvent(run, span.id, {
      kind: 'command',
      command: 'first',
      visibility: 'public',
    });
    await addEvent(run, span.id, {
      kind: 'command',
      command: 'second',
      visibility: 'public',
    });

    expect(getEventCount(run)).toBe(2);
  });
});

describe('getSpanCount', () => {
  let run: TraceRun;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
  });

  it('returns 0 for new run', () => {
    expect(getSpanCount(run)).toBe(0);
  });

  it('returns correct count after adding spans', () => {
    addSpan(run, { name: 'span1' });
    addSpan(run, { name: 'span2' });
    addSpan(run, { name: 'span3' });

    expect(getSpanCount(run)).toBe(3);
  });
});

describe('getRootSpans', () => {
  let run: TraceRun;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
  });

  it('returns only spans without parents', () => {
    const root1 = addSpan(run, { name: 'root1' });
    const root2 = addSpan(run, { name: 'root2' });
    addSpan(run, { name: 'child1', parentSpanId: root1.id });
    addSpan(run, { name: 'child2', parentSpanId: root2.id });

    const rootSpans = getRootSpans(run);

    expect(rootSpans).toHaveLength(2);
    expect(rootSpans).toContain(root1);
    expect(rootSpans).toContain(root2);
  });

  it('returns empty array for no spans', () => {
    expect(getRootSpans(run)).toEqual([]);
  });
});

describe('getChildSpans', () => {
  let run: TraceRun;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
  });

  it('returns child spans for parent', () => {
    const parent = addSpan(run, { name: 'parent' });
    const child1 = addSpan(run, { name: 'child1', parentSpanId: parent.id });
    const child2 = addSpan(run, { name: 'child2', parentSpanId: parent.id });

    const children = getChildSpans(run, parent.id);

    expect(children).toHaveLength(2);
    expect(children).toContain(child1);
    expect(children).toContain(child2);
  });

  it('returns empty array for span with no children', () => {
    const span = addSpan(run, { name: 'lonely' });

    expect(getChildSpans(run, span.id)).toEqual([]);
  });
});

describe('getEvent', () => {
  let run: TraceRun;
  let span: TraceSpan;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
    span = addSpan(run, { name: 'build' });
  });

  it('returns event by ID', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
      visibility: 'public',
    });

    const found = getEvent(run, event.id);

    expect(found).toBe(event);
  });

  it('returns undefined for non-existent ID', () => {
    const found = getEvent(run, 'non-existent');

    expect(found).toBeUndefined();
  });
});

describe('getEventsByKind', () => {
  let run: TraceRun;
  let span: TraceSpan;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
    span = addSpan(run, { name: 'build' });
  });

  it('returns events of specified kind', async () => {
    const cmd1 = await addEvent(run, span.id, {
      kind: 'command',
      command: 'first',
      visibility: 'public',
    });
    await addEvent(run, span.id, {
      kind: 'output',
      stream: 'stdout',
      content: 'output',
      visibility: 'private',
    });
    const cmd2 = await addEvent(run, span.id, {
      kind: 'command',
      command: 'second',
      visibility: 'public',
    });

    const commands = getEventsByKind(run, 'command');

    expect(commands).toHaveLength(2);
    expect(commands).toContain(cmd1);
    expect(commands).toContain(cmd2);
  });

  it('returns empty array if no events of kind exist', async () => {
    await addEvent(run, span.id, {
      kind: 'command',
      command: 'test',
      visibility: 'public',
    });

    const decisions = getEventsByKind(run, 'decision');

    expect(decisions).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Event Ordering Tests
// -----------------------------------------------------------------------------

describe('event ordering', () => {
  let run: TraceRun;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
  });

  it('seq is monotonic across multiple spans', async () => {
    const span1 = addSpan(run, { name: 'span1' });
    const span2 = addSpan(run, { name: 'span2' });

    const e1 = await addEvent(run, span1.id, {
      kind: 'command',
      command: 'cmd1',
      visibility: 'public',
    });
    const e2 = await addEvent(run, span2.id, {
      kind: 'command',
      command: 'cmd2',
      visibility: 'public',
    });
    const e3 = await addEvent(run, span1.id, {
      kind: 'command',
      command: 'cmd3',
      visibility: 'public',
    });

    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
    expect(e3.seq).toBe(2);
  });

  it('events are stored in insertion order', async () => {
    const span = addSpan(run, { name: 'span' });

    await addEvent(run, span.id, { kind: 'command', command: 'first', visibility: 'public' });
    await addEvent(run, span.id, { kind: 'command', command: 'second', visibility: 'public' });
    await addEvent(run, span.id, { kind: 'command', command: 'third', visibility: 'public' });

    expect(run.events[0]?.seq).toBe(0);
    expect(run.events[1]?.seq).toBe(1);
    expect(run.events[2]?.seq).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Span Ordering Tests
// -----------------------------------------------------------------------------

describe('span ordering', () => {
  let run: TraceRun;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
  });

  it('spanSeq is monotonic', () => {
    const span1 = addSpan(run, { name: 'span1' });
    const span2 = addSpan(run, { name: 'span2' });
    const span3 = addSpan(run, { name: 'span3' });

    expect(span1.spanSeq).toBe(0);
    expect(span2.spanSeq).toBe(1);
    expect(span3.spanSeq).toBe(2);
  });

  it('child spans have higher spanSeq than parent', () => {
    const parent = addSpan(run, { name: 'parent' });
    const child = addSpan(run, { name: 'child', parentSpanId: parent.id });
    const grandchild = addSpan(run, { name: 'grandchild', parentSpanId: child.id });

    expect(child.spanSeq).toBeGreaterThan(parent.spanSeq);
    expect(grandchild.spanSeq).toBeGreaterThan(child.spanSeq);
  });
});

// -----------------------------------------------------------------------------
// Visibility Defaults Tests
// -----------------------------------------------------------------------------

describe('visibility defaults', () => {
  let run: TraceRun;
  let span: TraceSpan;

  beforeEach(async () => {
    run = await createTrace({ agentId: 'test-agent' });
    span = addSpan(run, { name: 'build' });
  });

  it('command events are public by default', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'command',
      command: 'npm install',
    });

    expect(event.visibility).toBe('public');
  });

  it('output events are private by default', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'output',
      stream: 'stdout',
      content: 'output',
    });

    expect(event.visibility).toBe('private');
  });

  it('decision events are private by default', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'decision',
      decision: 'use TypeScript',
    });

    expect(event.visibility).toBe('private');
  });

  it('observation events are public by default', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'observation',
      observation: 'file exists',
    });

    expect(event.visibility).toBe('public');
  });

  it('error events are private by default', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'error',
      error: 'Something went wrong',
    });

    expect(event.visibility).toBe('private');
  });

  it('custom events are private by default', async () => {
    const event = await addEvent(run, span.id, {
      kind: 'custom',
      eventType: 'api-call',
      data: { endpoint: '/api' },
    });

    expect(event.visibility).toBe('private');
  });

  it('spans are private by default', () => {
    const span = addSpan(run, { name: 'build' });

    expect(span.visibility).toBe('private');
  });
});
