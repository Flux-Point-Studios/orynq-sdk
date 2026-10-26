import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishCheckpointCandidate } from './publish.mjs';

const root = '11'.repeat(32), sha = '22'.repeat(20), fileSha = '33'.repeat(20), candidateSha = '44'.repeat(20);
const artifact = sequence => ({ format: 'orynq-midnight-checkpoint-advance/v1', network: 'mainnet', rootId: root, sequence });
function fixture(candidate = [artifact(1)], current = []) {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-publication-')), file = join(dir, 'candidate.json');
  writeFileSync(file, JSON.stringify(candidate), { mode: 0o600 });
  const calls = [], token = 'synthetic-private-publication-token';
  let existing = false, open = false;
  const fetcher = async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/Flux-Point-Studios/orynq-sdk/'));
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.ok(!url.includes(token)); assert.ok(!(options.body ?? '').includes(token));
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    let status = 200, value;
    if (url.endsWith('/git/ref/heads/main')) value = { object: { sha } };
    else if (url.includes('/git/blobs/')) { const content = url.endsWith(candidateSha) ? readFileSync(file) : Buffer.from(JSON.stringify(current)); value = { encoding: 'base64', size: content.length, content: content.toString('base64') }; }
    else if (url.includes('/contents/') && url.endsWith(`?ref=${sha}`)) value = { sha: fileSha, size: Buffer.byteLength(JSON.stringify(current)) };
    else if (url.includes('/git/ref/heads/maintenance/')) { status = existing ? 200 : 404; value = { object: { sha } }; }
    else if (url.includes('/contents/') && options.method === 'GET') value = { sha: candidateSha, size: readFileSync(file).length };
    else if (url.includes('/pulls?')) value = open ? [{ number: 73 }] : [];
    else if (url.endsWith('/pulls')) { open = true; value = { number: 73 }; }
    else if (url.endsWith('/git/refs')) { existing = true; status = 201; value = {}; }
    else if (url.includes('/contents/') && options.method === 'PUT') { status = 201; value = {}; }
    else throw new Error('Unexpected fixture endpoint');
    return new Response(JSON.stringify(value), { status });
  };
  return { file, token, calls, fetcher, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('publication creates an immutable review branch and PR without editing main, and is idempotent', async () => {
  const f = fixture();
  try {
    const first = await publishCheckpointCandidate(f), again = await publishCheckpointCandidate(f);
    assert.equal(first.pullRequest, 'https://github.com/Flux-Point-Studios/orynq-sdk/pull/73');
    assert.equal(again.existing, true);
    assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/pulls')).length, 1);
    assert.ok(f.calls.every(call => call.method !== 'PATCH' && call.method !== 'DELETE'));
    assert.ok(f.calls.filter(call => call.method === 'PUT').every(call => call.body.branch.startsWith('maintenance/checkpoints/mainnet-')));
  } finally { f.cleanup(); }
});
test('publication refuses current-main prefix loss before any remote mutation', async () => {
  const f = fixture([artifact(2)], [artifact(1)]);
  try { await assert.rejects(publishCheckpointCandidate(f), /preserve and extend/); assert.ok(f.calls.every(call => call.method === 'GET')); }
  finally { f.cleanup(); }
});
test('publication refuses empty candidates before accessing credentials remotely', async () => {
  const f = fixture([]);
  try { await assert.rejects(publishCheckpointCandidate(f), /empty/); assert.equal(f.calls.length, 0); }
  finally { f.cleanup(); }
});
test('publication refuses oversized candidate files before reading bytes or making requests', async () => {
  const f = fixture();
  const fd = openSync(f.file, 'r+');
  try { ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { closeSync(fd); }
  try { await assert.rejects(publishCheckpointCandidate(f), /exceeds its bounds/); assert.equal(f.calls.length, 0); }
  finally { f.cleanup(); }
});
test('the credential step pins and executes the verified publisher snapshot with preloads removed', () => {
  const source = readFileSync(new URL('./publish.mjs', import.meta.url));
  const workflow = readFileSync(new URL('../../.woodpecker/checkpoint-maintenance.yaml', import.meta.url), 'utf8');
  assert.ok(workflow.includes(createHash('sha256').update(source).digest('hex')));
  assert.ok(workflow.includes('env -u NODE_OPTIONS -u NODE_PATH node'));
  assert.ok(workflow.includes("'data:text/javascript;base64,' + source.toString('base64')"));
  assert.equal((source.toString().match(/from ["'](?!node:)/g) ?? []).length, 0);
  assert.ok(!workflow.includes('checkpoint_review_token\n    commands:\n      - pnpm'));
});
