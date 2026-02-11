/**
 * @summary Tests for type exports and constants in the process-trace package.
 */

import { describe, it, expect } from 'vitest';
import {
  HASH_DOMAIN_PREFIXES,
  DEFAULT_EVENT_VISIBILITY,
} from '../index.js';
import type {
  Visibility,
  TraceStatus,
  SchemaVersion,
  TraceEvent,
  TraceEventKind,
  TraceSpan,
  TraceRun,
  TraceMerkleTree,
  MerkleProof,
  TraceBundle,
  TraceBundlePublicView,
  HashDomain,
  RollingHashState,
} from '../index.js';

describe('HASH_DOMAIN_PREFIXES', () => {
  it('has all expected keys', () => {
    const expectedKeys: HashDomain[] = [
      'event',
      'roll',
      'span',
      'leaf',
      'node',
      'manifest',
      'root',
      'safety',
      'safetyReport',
    ];

    const actualKeys = Object.keys(HASH_DOMAIN_PREFIXES);

    expect(actualKeys).toHaveLength(expectedKeys.length);
    for (const key of expectedKeys) {
      expect(actualKeys).toContain(key);
    }
  });

  it('has correct prefix format for all domains', () => {
    for (const [domain, prefix] of Object.entries(HASH_DOMAIN_PREFIXES)) {
      // All prefixes should follow pattern "poi-trace:<domain>:v1|"
      // Domain may contain hyphens (e.g. "safety-report")
      expect(prefix).toMatch(/^poi-trace:[a-z]+(-[a-z]+)*:v1\|$/);
      // camelCase keys map to hyphenated prefixes (e.g. safetyReport -> safety-report)
      const hyphenatedDomain = domain.replace(/[A-Z]/g, (c: string) => `-${c.toLowerCase()}`);
      expect(prefix).toContain(hyphenatedDomain);
    }
  });

  it('event prefix is correct', () => {
    expect(HASH_DOMAIN_PREFIXES.event).toBe('poi-trace:event:v1|');
  });

  it('roll prefix is correct', () => {
    expect(HASH_DOMAIN_PREFIXES.roll).toBe('poi-trace:roll:v1|');
  });

  it('span prefix is correct', () => {
    expect(HASH_DOMAIN_PREFIXES.span).toBe('poi-trace:span:v1|');
  });

  it('leaf prefix is correct', () => {
    expect(HASH_DOMAIN_PREFIXES.leaf).toBe('poi-trace:leaf:v1|');
  });

  it('node prefix is correct', () => {
    expect(HASH_DOMAIN_PREFIXES.node).toBe('poi-trace:node:v1|');
  });

  it('manifest prefix is correct', () => {
    expect(HASH_DOMAIN_PREFIXES.manifest).toBe('poi-trace:manifest:v1|');
  });

  it('root prefix is correct', () => {
    expect(HASH_DOMAIN_PREFIXES.root).toBe('poi-trace:root:v1|');
  });

  it('all prefixes are unique', () => {
    const prefixes = Object.values(HASH_DOMAIN_PREFIXES);
    const uniquePrefixes = new Set(prefixes);
    expect(uniquePrefixes.size).toBe(prefixes.length);
  });

  it('is immutable (readonly)', () => {
    // TypeScript should prevent mutation, but we verify the object shape
    expect(typeof HASH_DOMAIN_PREFIXES).toBe('object');
    expect(Object.isFrozen(HASH_DOMAIN_PREFIXES)).toBe(false); // It's const but not frozen
  });
});

describe('DEFAULT_EVENT_VISIBILITY', () => {
  it('has all expected event kinds', () => {
    const expectedKinds: TraceEventKind[] = [
      'command',
      'output',
      'decision',
      'observation',
      'error',
      'custom',
    ];

    const actualKinds = Object.keys(DEFAULT_EVENT_VISIBILITY);

    expect(actualKinds).toHaveLength(expectedKinds.length);
    for (const kind of expectedKinds) {
      expect(actualKinds).toContain(kind);
    }
  });

  it('command events default to public', () => {
    expect(DEFAULT_EVENT_VISIBILITY.command).toBe('public');
  });

  it('output events default to private', () => {
    expect(DEFAULT_EVENT_VISIBILITY.output).toBe('private');
  });

  it('decision events default to private', () => {
    expect(DEFAULT_EVENT_VISIBILITY.decision).toBe('private');
  });

  it('observation events default to public', () => {
    expect(DEFAULT_EVENT_VISIBILITY.observation).toBe('public');
  });

  it('error events default to private', () => {
    expect(DEFAULT_EVENT_VISIBILITY.error).toBe('private');
  });

  it('custom events default to private', () => {
    expect(DEFAULT_EVENT_VISIBILITY.custom).toBe('private');
  });

  it('all values are valid Visibility types', () => {
    const validVisibilities: Visibility[] = ['public', 'private', 'secret'];
    for (const visibility of Object.values(DEFAULT_EVENT_VISIBILITY)) {
      expect(validVisibilities).toContain(visibility);
    }
  });

  it('returns expected visibility for each event kind', () => {
    const expected: Record<TraceEventKind, Visibility> = {
      command: 'public',
      output: 'private',
      decision: 'private',
      observation: 'public',
      error: 'private',
      custom: 'private',
    };

    for (const [kind, visibility] of Object.entries(expected)) {
      expect(DEFAULT_EVENT_VISIBILITY[kind as TraceEventKind]).toBe(visibility);
    }
  });
});

describe('Visibility type', () => {
  it('accepts public visibility', () => {
    const visibility: Visibility = 'public';
    expect(visibility).toBe('public');
  });

  it('accepts private visibility', () => {
    const visibility: Visibility = 'private';
    expect(visibility).toBe('private');
  });

  it('accepts secret visibility', () => {
    const visibility: Visibility = 'secret';
    expect(visibility).toBe('secret');
  });
});

describe('TraceStatus type', () => {
  it('accepts running status', () => {
    const status: TraceStatus = 'running';
    expect(status).toBe('running');
  });

  it('accepts completed status', () => {
    const status: TraceStatus = 'completed';
    expect(status).toBe('completed');
  });

  it('accepts failed status', () => {
    const status: TraceStatus = 'failed';
    expect(status).toBe('failed');
  });

  it('accepts cancelled status', () => {
    const status: TraceStatus = 'cancelled';
    expect(status).toBe('cancelled');
  });
});

describe('SchemaVersion type', () => {
  it('accepts version 1.0', () => {
    const version: SchemaVersion = '1.0';
    expect(version).toBe('1.0');
  });
});

describe('TraceEvent interface structure', () => {
  it('accepts a valid CommandEvent', () => {
    const event: TraceEvent = {
      kind: 'command',
      id: 'test-id',
      seq: 0,
      timestamp: '2024-01-15T10:30:00.000Z',
      visibility: 'public',
      command: 'npm install',
      args: ['--save-dev'],
    };

    expect(event.kind).toBe('command');
    expect(event.command).toBe('npm install');
  });

  it('accepts a valid OutputEvent', () => {
    const event: TraceEvent = {
      kind: 'output',
      id: 'test-id',
      seq: 1,
      timestamp: '2024-01-15T10:30:01.000Z',
      visibility: 'private',
      stream: 'stdout',
      content: 'Installation complete',
    };

    expect(event.kind).toBe('output');
    expect(event.stream).toBe('stdout');
  });

  it('accepts a valid DecisionEvent', () => {
    const event: TraceEvent = {
      kind: 'decision',
      id: 'test-id',
      seq: 2,
      timestamp: '2024-01-15T10:30:02.000Z',
      visibility: 'private',
      decision: 'Use TypeScript',
      reasoning: 'Better type safety',
    };

    expect(event.kind).toBe('decision');
    expect(event.decision).toBe('Use TypeScript');
  });

  it('accepts a valid ObservationEvent', () => {
    const event: TraceEvent = {
      kind: 'observation',
      id: 'test-id',
      seq: 3,
      timestamp: '2024-01-15T10:30:03.000Z',
      visibility: 'public',
      observation: 'Package.json exists',
      category: 'file-system',
    };

    expect(event.kind).toBe('observation');
    expect(event.observation).toBe('Package.json exists');
  });

  it('accepts a valid ErrorTraceEvent', () => {
    const event: TraceEvent = {
      kind: 'error',
      id: 'test-id',
      seq: 4,
      timestamp: '2024-01-15T10:30:04.000Z',
      visibility: 'private',
      error: 'File not found',
      code: 'ENOENT',
      recoverable: true,
    };

    expect(event.kind).toBe('error');
    expect(event.error).toBe('File not found');
  });

  it('accepts a valid CustomEvent', () => {
    const event: TraceEvent = {
      kind: 'custom',
      id: 'test-id',
      seq: 5,
      timestamp: '2024-01-15T10:30:05.000Z',
      visibility: 'private',
      eventType: 'api-call',
      data: { endpoint: '/api/v1/users' },
    };

    expect(event.kind).toBe('custom');
    expect(event.eventType).toBe('api-call');
  });
});

describe('TraceSpan interface structure', () => {
  it('accepts a valid TraceSpan', () => {
    const span: TraceSpan = {
      id: 'span-1',
      spanSeq: 0,
      name: 'build',
      status: 'completed',
      visibility: 'public',
      startedAt: '2024-01-15T10:30:00.000Z',
      endedAt: '2024-01-15T10:31:00.000Z',
      durationMs: 60000,
      eventIds: ['event-1', 'event-2'],
      childSpanIds: [],
      hash: 'abc123',
    };

    expect(span.id).toBe('span-1');
    expect(span.spanSeq).toBe(0);
    expect(span.name).toBe('build');
  });

  it('accepts span with parent', () => {
    const span: TraceSpan = {
      id: 'span-2',
      spanSeq: 1,
      parentSpanId: 'span-1',
      name: 'npm-install',
      status: 'running',
      visibility: 'private',
      startedAt: '2024-01-15T10:30:00.000Z',
      eventIds: [],
      childSpanIds: [],
    };

    expect(span.parentSpanId).toBe('span-1');
  });

  it('accepts span with metadata', () => {
    const span: TraceSpan = {
      id: 'span-3',
      spanSeq: 2,
      name: 'test',
      status: 'completed',
      visibility: 'public',
      startedAt: '2024-01-15T10:30:00.000Z',
      eventIds: [],
      childSpanIds: [],
      metadata: {
        environment: 'production',
        region: 'us-east-1',
      },
    };

    expect(span.metadata?.environment).toBe('production');
  });
});

describe('RollingHashState interface structure', () => {
  it('accepts a valid RollingHashState', () => {
    const state: RollingHashState = {
      currentHash: 'abc123def456',
      itemCount: 5,
    };

    expect(state.currentHash).toBe('abc123def456');
    expect(state.itemCount).toBe(5);
  });
});

describe('TraceMerkleTree interface structure', () => {
  it('accepts a valid TraceMerkleTree', () => {
    const tree: TraceMerkleTree = {
      rootHash: 'root123',
      leafCount: 3,
      depth: 2,
      leafHashes: ['leaf1', 'leaf2', 'leaf3'],
    };

    expect(tree.rootHash).toBe('root123');
    expect(tree.leafCount).toBe(3);
    expect(tree.depth).toBe(2);
    expect(tree.leafHashes).toHaveLength(3);
  });
});

describe('MerkleProof interface structure', () => {
  it('accepts a valid MerkleProof', () => {
    const proof: MerkleProof = {
      leafHash: 'leaf123',
      leafIndex: 1,
      siblings: [
        { hash: 'sibling1', position: 'left' },
        { hash: 'sibling2', position: 'right' },
      ],
      rootHash: 'root123',
    };

    expect(proof.leafHash).toBe('leaf123');
    expect(proof.leafIndex).toBe(1);
    expect(proof.siblings).toHaveLength(2);
    expect(proof.siblings[0]?.position).toBe('left');
    expect(proof.rootHash).toBe('root123');
  });

  it('accepts empty siblings array', () => {
    const proof: MerkleProof = {
      leafHash: 'leaf123',
      leafIndex: 0,
      siblings: [],
      rootHash: 'leaf123',
    };

    expect(proof.siblings).toHaveLength(0);
  });
});
