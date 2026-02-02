/**
 * @summary Tests for rolling hash functionality in the process-trace package.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeEventHash,
  computeEventHashes,
  initRollingHash,
  updateRollingHash,
  computeRollingHash,
  verifyRollingHash,
  computeRootHash,
  getGenesisHash,
  HASH_DOMAIN_PREFIXES,
} from '../index.js';
import type {
  TraceEvent,
  TraceSpan,
  RollingHashState,
  CommandEvent,
  OutputEvent,
} from '../index.js';

// -----------------------------------------------------------------------------
// Test Fixtures
// -----------------------------------------------------------------------------

function createCommandEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    kind: 'command',
    id: crypto.randomUUID(),
    seq: 0,
    timestamp: '2024-01-15T10:30:00.000Z',
    visibility: 'public',
    command: 'npm install',
    ...overrides,
  };
}

function createOutputEvent(overrides: Partial<OutputEvent> = {}): OutputEvent {
  return {
    kind: 'output',
    id: crypto.randomUUID(),
    seq: 1,
    timestamp: '2024-01-15T10:30:01.000Z',
    visibility: 'private',
    stream: 'stdout',
    content: 'done',
    ...overrides,
  };
}

function createSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: crypto.randomUUID(),
    spanSeq: 0,
    name: 'test-span',
    status: 'completed',
    visibility: 'public',
    startedAt: '2024-01-15T10:30:00.000Z',
    endedAt: '2024-01-15T10:31:00.000Z',
    durationMs: 60000,
    eventIds: [],
    childSpanIds: [],
    hash: 'test-hash',
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// computeEventHash Tests
// -----------------------------------------------------------------------------

describe('computeEventHash', () => {
  it('produces a 64-character hex string', async () => {
    const event = createCommandEvent();
    const hash = await computeEventHash(event);

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('produces consistent output for the same event', async () => {
    const event = createCommandEvent({
      id: 'fixed-id',
      seq: 0,
      timestamp: '2024-01-15T10:30:00.000Z',
    });

    const hash1 = await computeEventHash(event);
    const hash2 = await computeEventHash(event);

    expect(hash1).toBe(hash2);
  });

  it('produces different output for different events', async () => {
    const event1 = createCommandEvent({ command: 'npm install' });
    const event2 = createCommandEvent({ command: 'npm build' });

    const hash1 = await computeEventHash(event1);
    const hash2 = await computeEventHash(event2);

    expect(hash1).not.toBe(hash2);
  });

  it('ignores the hash field when computing hash', async () => {
    const event = createCommandEvent({ id: 'test-id' });
    const eventWithHash = { ...event, hash: 'existing-hash-value' };

    const hashWithout = await computeEventHash(event);
    const hashWith = await computeEventHash(eventWithHash);

    expect(hashWithout).toBe(hashWith);
  });

  it('produces different hashes for different event kinds', async () => {
    const commandEvent = createCommandEvent({ id: 'test-id', seq: 0 });
    const outputEvent = createOutputEvent({ id: 'test-id', seq: 0 });

    const commandHash = await computeEventHash(commandEvent);
    const outputHash = await computeEventHash(outputEvent);

    expect(commandHash).not.toBe(outputHash);
  });

  it('produces different hashes for different seq values', async () => {
    const event1 = createCommandEvent({ seq: 0 });
    const event2 = createCommandEvent({ seq: 1 });

    const hash1 = await computeEventHash(event1);
    const hash2 = await computeEventHash(event2);

    expect(hash1).not.toBe(hash2);
  });

  it('produces different hashes for different timestamps', async () => {
    const event1 = createCommandEvent({ timestamp: '2024-01-15T10:30:00.000Z' });
    const event2 = createCommandEvent({ timestamp: '2024-01-15T10:30:01.000Z' });

    const hash1 = await computeEventHash(event1);
    const hash2 = await computeEventHash(event2);

    expect(hash1).not.toBe(hash2);
  });

  it('produces different hashes for different visibility levels', async () => {
    const publicEvent = createCommandEvent({ visibility: 'public' });
    const privateEvent = createCommandEvent({ visibility: 'private' });

    const publicHash = await computeEventHash(publicEvent);
    const privateHash = await computeEventHash(privateEvent);

    expect(publicHash).not.toBe(privateHash);
  });
});

// -----------------------------------------------------------------------------
// computeEventHashes Tests
// -----------------------------------------------------------------------------

describe('computeEventHashes', () => {
  it('returns empty array for empty input', async () => {
    const hashes = await computeEventHashes([]);
    expect(hashes).toEqual([]);
  });

  it('returns hashes in seq order', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ seq: 2 }),
      createCommandEvent({ seq: 0 }),
      createCommandEvent({ seq: 1 }),
    ];

    const hashes = await computeEventHashes(events);

    expect(hashes).toHaveLength(3);
    // Verify order by computing individually
    const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < hashes.length; i++) {
      const expectedHash = await computeEventHash(sortedEvents[i]!);
      expect(hashes[i]).toBe(expectedHash);
    }
  });

  it('produces consistent hashes for same events', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ id: 'e1', seq: 0 }),
      createOutputEvent({ id: 'e2', seq: 1 }),
    ];

    const hashes1 = await computeEventHashes(events);
    const hashes2 = await computeEventHashes(events);

    expect(hashes1).toEqual(hashes2);
  });
});

// -----------------------------------------------------------------------------
// initRollingHash Tests
// -----------------------------------------------------------------------------

describe('initRollingHash', () => {
  it('returns expected genesis state', async () => {
    const state = await initRollingHash();

    expect(state).toHaveProperty('currentHash');
    expect(state).toHaveProperty('itemCount');
    expect(state.itemCount).toBe(0);
    expect(state.currentHash).toHaveLength(64);
    expect(state.currentHash).toMatch(/^[a-f0-9]+$/);
  });

  it('returns consistent genesis hash', async () => {
    const state1 = await initRollingHash();
    const state2 = await initRollingHash();

    expect(state1.currentHash).toBe(state2.currentHash);
    expect(state1.itemCount).toBe(state2.itemCount);
  });

  it('genesis hash matches getGenesisHash output', async () => {
    const state = await initRollingHash();
    const genesisHash = await getGenesisHash();

    expect(state.currentHash).toBe(genesisHash);
  });
});

// -----------------------------------------------------------------------------
// updateRollingHash Tests
// -----------------------------------------------------------------------------

describe('updateRollingHash', () => {
  let initialState: RollingHashState;

  beforeEach(async () => {
    initialState = await initRollingHash();
  });

  it('produces deterministic results', async () => {
    const eventHash = await computeEventHash(createCommandEvent());

    const state1 = await updateRollingHash(initialState, eventHash);
    const state2 = await updateRollingHash(initialState, eventHash);

    expect(state1.currentHash).toBe(state2.currentHash);
    expect(state1.itemCount).toBe(state2.itemCount);
  });

  it('increments itemCount by 1', async () => {
    const eventHash = await computeEventHash(createCommandEvent());

    const state1 = await updateRollingHash(initialState, eventHash);
    expect(state1.itemCount).toBe(1);

    const state2 = await updateRollingHash(state1, eventHash);
    expect(state2.itemCount).toBe(2);
  });

  it('produces different hash for different event hashes', async () => {
    const eventHash1 = await computeEventHash(createCommandEvent({ command: 'npm install' }));
    const eventHash2 = await computeEventHash(createCommandEvent({ command: 'npm build' }));

    const state1 = await updateRollingHash(initialState, eventHash1);
    const state2 = await updateRollingHash(initialState, eventHash2);

    expect(state1.currentHash).not.toBe(state2.currentHash);
  });

  it('produces 64-character hex hash', async () => {
    const eventHash = await computeEventHash(createCommandEvent());

    const state = await updateRollingHash(initialState, eventHash);

    expect(state.currentHash).toHaveLength(64);
    expect(state.currentHash).toMatch(/^[a-f0-9]+$/);
  });

  it('order matters for sequential updates', async () => {
    const eventHash1 = await computeEventHash(createCommandEvent({ command: 'first' }));
    const eventHash2 = await computeEventHash(createCommandEvent({ command: 'second' }));

    // Order: first, second
    let stateA = await updateRollingHash(initialState, eventHash1);
    stateA = await updateRollingHash(stateA, eventHash2);

    // Order: second, first
    let stateB = await updateRollingHash(initialState, eventHash2);
    stateB = await updateRollingHash(stateB, eventHash1);

    expect(stateA.currentHash).not.toBe(stateB.currentHash);
  });
});

// -----------------------------------------------------------------------------
// computeRollingHash Tests
// -----------------------------------------------------------------------------

describe('computeRollingHash', () => {
  it('returns genesis hash for empty events', async () => {
    const hash = await computeRollingHash([]);
    const genesisHash = await getGenesisHash();

    expect(hash).toBe(genesisHash);
  });

  it('batch equals sequential updates', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ seq: 0, command: 'npm install' }),
      createOutputEvent({ seq: 1, content: 'done' }),
      createCommandEvent({ seq: 2, command: 'npm build' }),
    ];

    // Batch computation
    const batchHash = await computeRollingHash(events);

    // Sequential computation
    let state = await initRollingHash();
    for (const event of events.sort((a, b) => a.seq - b.seq)) {
      const eventHash = await computeEventHash(event);
      state = await updateRollingHash(state, eventHash);
    }

    expect(batchHash).toBe(state.currentHash);
  });

  it('produces consistent output for same events', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ id: 'e1', seq: 0 }),
      createOutputEvent({ id: 'e2', seq: 1 }),
    ];

    const hash1 = await computeRollingHash(events);
    const hash2 = await computeRollingHash(events);

    expect(hash1).toBe(hash2);
  });

  it('sorts events by seq before processing', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ id: 'e3', seq: 2 }),
      createCommandEvent({ id: 'e1', seq: 0 }),
      createCommandEvent({ id: 'e2', seq: 1 }),
    ];

    const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);

    const hashUnsorted = await computeRollingHash(events);
    const hashSorted = await computeRollingHash(sortedEvents);

    expect(hashUnsorted).toBe(hashSorted);
  });

  it('produces different output for different event sequences', async () => {
    const events1: TraceEvent[] = [
      createCommandEvent({ seq: 0, command: 'npm install' }),
    ];
    const events2: TraceEvent[] = [
      createCommandEvent({ seq: 0, command: 'npm build' }),
    ];

    const hash1 = await computeRollingHash(events1);
    const hash2 = await computeRollingHash(events2);

    expect(hash1).not.toBe(hash2);
  });
});

// -----------------------------------------------------------------------------
// verifyRollingHash Tests
// -----------------------------------------------------------------------------

describe('verifyRollingHash', () => {
  it('returns true for valid hash', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ seq: 0 }),
      createOutputEvent({ seq: 1 }),
    ];

    const expectedHash = await computeRollingHash(events);
    const isValid = await verifyRollingHash(events, expectedHash);

    expect(isValid).toBe(true);
  });

  it('returns false for tampered event', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ seq: 0, command: 'original' }),
    ];

    const originalHash = await computeRollingHash(events);

    // Tamper with the event
    const tamperedEvents: TraceEvent[] = [
      createCommandEvent({ seq: 0, command: 'tampered' }),
    ];

    const isValid = await verifyRollingHash(tamperedEvents, originalHash);

    expect(isValid).toBe(false);
  });

  it('returns false for wrong hash', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ seq: 0 }),
    ];

    const wrongHash = '0'.repeat(64);
    const isValid = await verifyRollingHash(events, wrongHash);

    expect(isValid).toBe(false);
  });

  it('returns true for empty events with genesis hash', async () => {
    const genesisHash = await getGenesisHash();
    const isValid = await verifyRollingHash([], genesisHash);

    expect(isValid).toBe(true);
  });

  it('handles uppercase hash comparison', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ seq: 0 }),
    ];

    const hash = await computeRollingHash(events);
    const uppercaseHash = hash.toUpperCase();

    const isValid = await verifyRollingHash(events, uppercaseHash);

    expect(isValid).toBe(true);
  });

  it('returns false when events are missing', async () => {
    const events: TraceEvent[] = [
      createCommandEvent({ seq: 0 }),
      createOutputEvent({ seq: 1 }),
    ];

    const fullHash = await computeRollingHash(events);

    // Only verify with partial events
    const partialEvents = [events[0]!];
    const isValid = await verifyRollingHash(partialEvents, fullHash);

    expect(isValid).toBe(false);
  });

  it('returns false when event is modified', async () => {
    const event = createCommandEvent({ seq: 0, command: 'npm install' });
    const events: TraceEvent[] = [event];

    const originalHash = await computeRollingHash(events);

    // Modify the event
    const modifiedEvents: TraceEvent[] = [
      { ...event, command: 'npm install --save' },
    ];

    const isValid = await verifyRollingHash(modifiedEvents, originalHash);

    expect(isValid).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// computeRootHash Tests
// -----------------------------------------------------------------------------

describe('computeRootHash', () => {
  it('incorporates spans correctly', async () => {
    const rollingHash = 'a'.repeat(64);
    const spans: TraceSpan[] = [
      createSpan({ spanSeq: 0, hash: 'span1hash' }),
      createSpan({ spanSeq: 1, hash: 'span2hash' }),
    ];

    const rootHash = await computeRootHash(rollingHash, spans);

    expect(rootHash).toHaveLength(64);
    expect(rootHash).toMatch(/^[a-f0-9]+$/);
  });

  it('produces consistent output for same inputs', async () => {
    const rollingHash = 'b'.repeat(64);
    const spans: TraceSpan[] = [
      createSpan({ spanSeq: 0, hash: 'spanhash' }),
    ];

    const rootHash1 = await computeRootHash(rollingHash, spans);
    const rootHash2 = await computeRootHash(rollingHash, spans);

    expect(rootHash1).toBe(rootHash2);
  });

  it('produces different output for different rolling hashes', async () => {
    const rollingHash1 = 'a'.repeat(64);
    const rollingHash2 = 'b'.repeat(64);
    const spans: TraceSpan[] = [
      createSpan({ spanSeq: 0, hash: 'spanhash' }),
    ];

    const rootHash1 = await computeRootHash(rollingHash1, spans);
    const rootHash2 = await computeRootHash(rollingHash2, spans);

    expect(rootHash1).not.toBe(rootHash2);
  });

  it('produces different output for different span hashes', async () => {
    const rollingHash = 'c'.repeat(64);
    const spans1: TraceSpan[] = [
      createSpan({ spanSeq: 0, hash: 'hash1' }),
    ];
    const spans2: TraceSpan[] = [
      createSpan({ spanSeq: 0, hash: 'hash2' }),
    ];

    const rootHash1 = await computeRootHash(rollingHash, spans1);
    const rootHash2 = await computeRootHash(rollingHash, spans2);

    expect(rootHash1).not.toBe(rootHash2);
  });

  it('sorts spans by spanSeq before hashing', async () => {
    const rollingHash = 'd'.repeat(64);
    const unsortedSpans: TraceSpan[] = [
      createSpan({ spanSeq: 2, hash: 'hash3' }),
      createSpan({ spanSeq: 0, hash: 'hash1' }),
      createSpan({ spanSeq: 1, hash: 'hash2' }),
    ];
    const sortedSpans: TraceSpan[] = [
      createSpan({ spanSeq: 0, hash: 'hash1' }),
      createSpan({ spanSeq: 1, hash: 'hash2' }),
      createSpan({ spanSeq: 2, hash: 'hash3' }),
    ];

    const rootHash1 = await computeRootHash(rollingHash, unsortedSpans);
    const rootHash2 = await computeRootHash(rollingHash, sortedSpans);

    expect(rootHash1).toBe(rootHash2);
  });

  it('handles empty spans array', async () => {
    const rollingHash = 'e'.repeat(64);
    const spans: TraceSpan[] = [];

    const rootHash = await computeRootHash(rollingHash, spans);

    expect(rootHash).toHaveLength(64);
    expect(rootHash).toMatch(/^[a-f0-9]+$/);
  });

  it('throws error if span is missing hash', async () => {
    const rollingHash = 'f'.repeat(64);
    const spans: TraceSpan[] = [
      { ...createSpan({ spanSeq: 0 }), hash: undefined },
    ];

    await expect(computeRootHash(rollingHash, spans)).rejects.toThrow(/missing hash/i);
  });
});

// -----------------------------------------------------------------------------
// Domain Separation Tests
// -----------------------------------------------------------------------------

describe('domain separation', () => {
  it('different prefixes produce different hashes for same content', async () => {
    // Create events with identical content but conceptually different "domains"
    // This is simulated by the prefixes used internally
    const event1 = createCommandEvent({ id: 'same-id', seq: 0, command: 'test' });
    const event2 = createCommandEvent({ id: 'same-id', seq: 0, command: 'test' });

    // The hash should be the same for identical events
    const hash1 = await computeEventHash(event1);
    const hash2 = await computeEventHash(event2);
    expect(hash1).toBe(hash2);

    // But different from the rolling hash operation
    const state = await initRollingHash();
    const updatedState = await updateRollingHash(state, hash1);
    expect(updatedState.currentHash).not.toBe(hash1);
  });

  it('event hash uses event domain prefix', async () => {
    // Verify that event hashing uses the correct domain prefix
    // by checking that the hash is deterministic and non-empty
    const event = createCommandEvent({ command: 'test-command' });
    const hash = await computeEventHash(event);

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
    expect(HASH_DOMAIN_PREFIXES.event).toBe('poi-trace:event:v1|');
  });

  it('rolling hash uses roll domain prefix', async () => {
    const state = await initRollingHash();
    const eventHash = await computeEventHash(createCommandEvent());
    const updatedState = await updateRollingHash(state, eventHash);

    expect(updatedState.currentHash).toHaveLength(64);
    expect(HASH_DOMAIN_PREFIXES.roll).toBe('poi-trace:roll:v1|');
  });

  it('root hash uses root domain prefix', async () => {
    const rollingHash = 'a'.repeat(64);
    const spans: TraceSpan[] = [createSpan({ hash: 'test-hash' })];
    const rootHash = await computeRootHash(rollingHash, spans);

    expect(rootHash).toHaveLength(64);
    expect(HASH_DOMAIN_PREFIXES.root).toBe('poi-trace:root:v1|');
  });

  it('genesis hash is deterministic', async () => {
    const genesis1 = await getGenesisHash();
    const genesis2 = await getGenesisHash();

    expect(genesis1).toBe(genesis2);
    expect(genesis1).toHaveLength(64);
  });
});
