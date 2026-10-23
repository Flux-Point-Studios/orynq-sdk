import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const braces = require('braces');
const nested = depth => '{'.repeat(depth) + 'a,b' + '}'.repeat(depth);

const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
const semver = require('semver');
function assertLockedFloor(name, floor, advisory) {
  const prefix = `  /${name}@`;
  const versions = lock.split('\n').filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length).match(/^(\d+\.\d+\.\d+)[(:]/)).filter(Boolean);
  assert.ok(versions.length > 0, `the lockfile must resolve ${name}`);
  for (const [, version] of versions) {
    assert.ok(semver.gte(version, typeof floor === 'string' ? floor : floor[semver.major(version)]), `${name} ${version} is affected by ${advisory}`);
  }
}

test('every locked Vite release includes the launch-editor security fix', () => {
  assertLockedFloor('vite', '8.3.3', 'GHSA-587h-7wmj-h5pm');
});

test('locked Zod releases include the constrained-collection size gate', () => {
  assertLockedFloor('zod', '4.6.6', 'GHSA-mrhx-c7xc-m3w5');
});

test('both body-parser release lines include the compressed-body error fix', () => {
  assertLockedFloor('body-parser', { 1: '1.20.9', 2: '2.4.0' }, 'GHSA-27r3-jxmh-p828');
});

for (const [name, floor, advisory] of [
  ['hono', '4.13.11', 'GHSA-5r4p-p66f-jhc7'],
  ['@vitest/mocker', '4.1.12', 'GHSA-qxg6-89mg-rqv8 / GHSA-xp26-3454-mjgp'],
  ['fastify', '5.12.6', 'GHSA-389g-gv7q-r4x8'],
  ['ip-address', '10.7.4', 'GHSA-rxp7-6hxx-x8q5'],
]) {
  test(`locked ${name} releases include the security fix`, () => assertLockedFloor(name, floor, advisory));
}

test('the MCP validator rejects an oversized constrained array before visiting its elements', () => {
  const { z } = createRequire(new URL('../packages/orynq-mcp/package.json', import.meta.url))('zod');
  let parsed = 0;
  const result = z.array(z.unknown().transform(value => { parsed++; return value; })).max(2).safeParse([1, 2, 3]);
  assert.equal(result.success, false);
  assert.equal(parsed, 0);
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, 'too_big');
});

test('brace parsing rejects nesting beyond the default bound', () => {
  assert.throws(() => braces.parse(nested(101)), /depth/i);
});

test('callers can lower the brace nesting bound', () => {
  assert.throws(() => braces.parse(nested(9), { maxDepth: 8 }), /depth/i);
});

test('the deepest nesting that fits the length limit fails as a syntax error, not stack exhaustion', () => {
  for (const options of [{}, { expand: true }]) {
    assert.throws(() => braces(nested(4998), options), SyntaxError);
  }
});

test('ordinary nested alternatives and numeric ranges retain their results', () => {
  const literal = value => '{'.repeat(99) + value + '}'.repeat(99);
  assert.deepEqual(braces(nested(100), { expand: true }), [literal('a'), literal('b')]);
  assert.deepEqual(braces('file-{a,{b,c}}.{js,ts}', { expand: true }), [
    'file-a.js', 'file-a.ts', 'file-b.js', 'file-b.ts', 'file-c.js', 'file-c.ts',
  ]);
  assert.deepEqual(braces.expand('v{1..3}'), ['v1', 'v2', 'v3']);
});
