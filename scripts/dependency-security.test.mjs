import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const braces = require('braces');
const nested = depth => '{'.repeat(depth) + 'a,b' + '}'.repeat(depth);

test('brace parsing rejects nesting beyond the default bound', () => {
  assert.throws(() => braces.parse(nested(101)), /depth/i);
});

test('callers can lower the brace nesting bound', () => {
  assert.throws(() => braces.parse(nested(9), { maxDepth: 8 }), /depth/i);
});

test('ordinary nested alternatives and numeric ranges retain their results', () => {
  assert.deepEqual(braces('file-{a,{b,c}}.{js,ts}', { expand: true }), [
    'file-a.js', 'file-a.ts', 'file-b.js', 'file-b.ts', 'file-c.js', 'file-c.ts',
  ]);
  assert.deepEqual(braces.expand('v{1..3}'), ['v1', 'v2', 'v3']);
});
