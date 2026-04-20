// Unit tests for infra/runner-core.js pure functions
// Load runner-core.js into a minimal window shim, exercise each function.

const fs = require('fs');
const vm = require('vm');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assertEq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg} expected ${e}, got ${a}`);
}

function assertThrows(fn, substrMatch, msg = '') {
  try { fn(); }
  catch (e) {
    if (substrMatch && !String(e.message).includes(substrMatch)) {
      throw new Error(`${msg} threw but message "${e.message}" does not contain "${substrMatch}"`);
    }
    return;
  }
  throw new Error(`${msg} expected throw containing "${substrMatch}" but nothing thrown`);
}

// Load runner-core into a sandbox with a fake window
const windowShim = {};
const sandbox = { window: windowShim, console };
vm.createContext(sandbox);
const src = fs.readFileSync('infra/runner-core.js', 'utf-8');
vm.runInContext(src, sandbox);
const rc = windowShim.runnerCore;

console.log('=== runner-core.js unit tests ===\n');

console.log('--- parseJob ---');

test('parses valid LLM job', () => {
  const job = rc.parseJob(JSON.stringify({
    ruling_id: 'TEST-001',
    spawn_file: 'spawn.md',
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
  }));
  assertEq(job.substrate, 'llm');
  assertEq(job.ruling_id, 'TEST-001');
  assertEq(job.files_to_pull, []);
});

test('parses valid compute job (inline script)', () => {
  const job = rc.parseJob(JSON.stringify({
    ruling_id: 'TEST-002',
    substrate: 'compute',
    script: 'print("ok")',
  }));
  assertEq(job.substrate, 'compute');
});

test('parses valid compute job (script_file)', () => {
  const job = rc.parseJob(JSON.stringify({
    ruling_id: 'TEST-003',
    substrate: 'compute',
    script_file: 'scripts/foo.py',
  }));
  assertEq(job.substrate, 'compute');
  assertEq(job.script_file, 'scripts/foo.py');
});

test('auto-detects compute substrate when model absent', () => {
  const job = rc.parseJob(JSON.stringify({
    ruling_id: 'TEST-004',
    script: 'print("auto-detected")',
  }));
  assertEq(job.substrate, 'compute');
});

test('auto-detects llm substrate when model present', () => {
  const job = rc.parseJob(JSON.stringify({
    ruling_id: 'TEST-005',
    spawn_file: 'x.md',
    model: 'claude-sonnet-4-20250514',
    max_tokens: 100,
  }));
  assertEq(job.substrate, 'llm');
});

test('rejects invalid JSON', () => {
  assertThrows(() => rc.parseJob('{not json'), 'invalid JSON');
});

test('rejects missing ruling_id', () => {
  assertThrows(() => rc.parseJob(JSON.stringify({ spawn_file: 'x', model: 'y', max_tokens: 1 })),
    "'ruling_id'");
});

test('rejects llm job missing spawn_file', () => {
  assertThrows(() => rc.parseJob(JSON.stringify({
    ruling_id: 'X', substrate: 'llm', model: 'y', max_tokens: 1,
  })), "'spawn_file'");
});

test('rejects llm job missing model', () => {
  assertThrows(() => rc.parseJob(JSON.stringify({
    ruling_id: 'X', substrate: 'llm', spawn_file: 'y', max_tokens: 1,
  })), "'model'");
});

test('rejects compute job with no script or script_file', () => {
  assertThrows(() => rc.parseJob(JSON.stringify({
    ruling_id: 'X', substrate: 'compute',
  })), 'script');
});

test('rejects unknown substrate', () => {
  assertThrows(() => rc.parseJob(JSON.stringify({
    ruling_id: 'X', substrate: 'magic',
  })), 'unknown substrate');
});

test('defaults files_to_pull to []', () => {
  const job = rc.parseJob(JSON.stringify({
    ruling_id: 'X', script: 'pass',
  }));
  assertEq(job.files_to_pull, []);
});

console.log('\n--- parseMultiFileManifest (SECURITY) ---');

test('extracts basic file block', () => {
  const text = '```file:foo.txt\nhello\n```';
  const m = rc.parseMultiFileManifest(text);
  assertEq(m, [{ path: 'foo.txt', content: 'hello' }]);
});

test('extracts multiple file blocks', () => {
  const text = '```file:a.txt\n1\n```\n\n```file:b.txt\n2\n```';
  const m = rc.parseMultiFileManifest(text);
  assertEq(m.length, 2);
  assertEq(m[0].path, 'a.txt');
  assertEq(m[1].path, 'b.txt');
});

test('allowed_path_prefixes: permits allowed path', () => {
  const text = '```file:viewer/index.html\n<html>\n```';
  const m = rc.parseMultiFileManifest(text, { allowedPathPrefixes: ['viewer/'] });
  assertEq(m[0].path, 'viewer/index.html');
});

test('allowed_path_prefixes: REJECTS path outside prefix', () => {
  const text = '```file:infra/evil.js\nbad\n```';
  assertThrows(
    () => rc.parseMultiFileManifest(text, { allowedPathPrefixes: ['viewer/'] }),
    "outside allowed prefixes"
  );
});

test('REJECTS path with .. segment (traversal guard)', () => {
  const text = '```file:viewer/../etc/passwd\ndata\n```';
  assertThrows(
    () => rc.parseMultiFileManifest(text, { allowedPathPrefixes: ['viewer/'] }),
    "contains '..'"
  );
});

test('REJECTS absolute path', () => {
  const text = '```file:/etc/passwd\ndata\n```';
  assertThrows(
    () => rc.parseMultiFileManifest(text, { allowedPathPrefixes: [] }),
    "absolute"
  );
});

test('allowed_path_prefixes empty array: permits all', () => {
  const text = '```file:anywhere.txt\nok\n```';
  const m = rc.parseMultiFileManifest(text, { allowedPathPrefixes: [] });
  assertEq(m[0].path, 'anywhere.txt');
});

test('ignores non-file code blocks', () => {
  const text = '```python\nprint("hi")\n```\n\n```file:x.txt\ncontent\n```';
  const m = rc.parseMultiFileManifest(text);
  assertEq(m.length, 1);
  assertEq(m[0].path, 'x.txt');
});

test('empty input returns []', () => {
  const m = rc.parseMultiFileManifest('');
  assertEq(m, []);
});

console.log('\n--- buildMessages ---');

test('builds message with just spawn text', () => {
  const msgs = rc.buildMessages({ spawnText: 'do X' });
  assertEq(msgs.length, 1);
  assertEq(msgs[0].role, 'user');
  if (!msgs[0].content.includes('do X')) throw new Error('spawn text missing');
});

test('builds message with pulled files', () => {
  const msgs = rc.buildMessages({
    spawnText: 'spawn',
    pulledFiles: [{ path: 'a.md', content: 'FILE A' }],
  });
  if (!msgs[0].content.includes('FILE A')) throw new Error('file content missing');
  if (!msgs[0].content.includes('FILE: a.md')) throw new Error('file path missing');
});

console.log('\n--- extractEnrp ---');

test('extracts ENRP with envelope', () => {
  const resp = `preamble
═══════════════════════════════════════════════════════
ENRP — Architect AR-999
Body here
═══════════════════════════════════════════════════════
ENRP COMPLETE — Architect AR-999
═══════════════════════════════════════════════════════
postamble`;
  const { enrpBody, meta } = rc.extractEnrp(resp);
  assertEq(meta.ruling_id, 'AR-999');
  assertEq(meta.node_type, 'Architect');
  if (!enrpBody.includes('Body here')) throw new Error('ENRP body missing');
  if (enrpBody.includes('preamble')) throw new Error('preamble included');
});

test('falls back to raw text when no envelope', () => {
  const resp = 'just some text no envelope';
  const { enrpBody, meta } = rc.extractEnrp(resp);
  assertEq(enrpBody, resp);
  assertEq(meta.ruling_id, null);
});

console.log('\n--- enrpFilename ---');

test('generates valid ENRP filename', () => {
  const name = rc.enrpFilename('AR-099', new Date('2026-04-20T12:34:56Z'));
  // Format: ENRP_AR-099_2026-04-20T123456Z.md
  if (!name.startsWith('ENRP_AR-099_')) throw new Error(`bad prefix: ${name}`);
  if (!name.endsWith('.md')) throw new Error(`bad suffix: ${name}`);
  if (!/\d{4}-\d{2}-\d{2}T\d{6}Z\.md$/.test(name)) throw new Error(`bad timestamp format: ${name}`);
});

console.log('\n--- statusLine ---');

test('generates valid JSONL status line', () => {
  const line = rc.statusLine('heartbeat', { elapsed_s: 30 });
  const parsed = JSON.parse(line);
  assertEq(parsed.event, 'heartbeat');
  assertEq(parsed.elapsed_s, 30);
  if (!parsed.ts) throw new Error('ts missing');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
