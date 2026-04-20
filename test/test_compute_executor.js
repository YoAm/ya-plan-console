// Unit tests for infra/compute-executor.js formatComputeEnrp (pure fn).
// Skips tests for runComputeJob which requires real Pyodide — those go in
// the Playwright E2E suite (AR-034).

const fs = require('fs');
const vm = require('vm');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e.message}`); console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Load into sandbox with fake window and minimal pyodide-loader shim
const windowShim = {
  pyodideLoader: { PYODIDE_VERSION: 'v0.26.2' },  // needed by formatComputeEnrp
};
const sandbox = { window: windowShim, console, btoa: (s) => Buffer.from(s).toString('base64') };
vm.createContext(sandbox);
const src = fs.readFileSync('infra/compute-executor.js', 'utf-8');
vm.runInContext(src, sandbox);
const ce = windowShim.computeExecutor;

console.log('=== compute-executor.js unit tests ===\n');
console.log('--- formatComputeEnrp ---');

test('formats successful result with stdout', () => {
  const body = ce.formatComputeEnrp({
    rulingId: 'TEST-001',
    scriptName: 'test.py',
    result: {
      stdout: 'hello\n',
      stderr: '',
      returnValue: '42',
      outputFiles: [],
      durationMs: 1234,
      error: null,
    },
    packages: ['numpy'],
  });
  assert(body.includes('TEST-001'), 'ruling_id missing');
  assert(body.includes('Status: OK'), 'status missing');
  assert(body.includes('numpy'), 'packages missing');
  assert(body.includes('hello'), 'stdout missing');
  assert(body.includes('42'), 'return value missing');
  assert(body.includes('1.23s'), 'duration missing or wrong format');
});

test('formats failed result with traceback', () => {
  const body = ce.formatComputeEnrp({
    rulingId: 'TEST-002',
    scriptName: 'broken.py',
    result: {
      stdout: '',
      stderr: '',
      returnValue: null,
      outputFiles: [],
      durationMs: 500,
      error: {
        name: 'ValueError',
        message: 'something broke',
        traceback: 'Traceback (most recent call last):\n  File "broken.py"...',
      },
    },
  });
  assert(body.includes('Status: FAILED'), 'FAILED status missing');
  assert(body.includes('ValueError'), 'error name missing');
  assert(body.includes('something broke'), 'error message missing');
  assert(body.includes('Traceback'), 'traceback missing');
});

test('formats result with output files listed', () => {
  const body = ce.formatComputeEnrp({
    rulingId: 'TEST-003',
    scriptName: 'writes.py',
    result: {
      stdout: '', stderr: '', returnValue: null,
      outputFiles: [
        { path: 'results/data.csv', content: 'a,b,c\n1,2,3\n' },
        { path: 'results/plot.json', content: '{"x":[1]}' },
      ],
      durationMs: 100,
      error: null,
    },
  });
  assert(body.includes('results/data.csv'), 'output file 1 missing');
  assert(body.includes('results/plot.json'), 'output file 2 missing');
  assert(body.includes('bytes'), 'byte count missing');
});

test('formats empty result (no stdout/stderr/files)', () => {
  const body = ce.formatComputeEnrp({
    rulingId: 'TEST-004',
    scriptName: 'silent.py',
    result: {
      stdout: '', stderr: '', returnValue: null,
      outputFiles: [], durationMs: 10, error: null,
    },
  });
  assert(body.includes('FILES EMITTED'), 'FILES EMITTED section missing');
  assert(body.includes('(none)'), 'empty marker missing');
});

test('formats result with packages=[] (no packages)', () => {
  const body = ce.formatComputeEnrp({
    rulingId: 'TEST-005',
    scriptName: 'simple.py',
    result: { stdout: 'ok', stderr: '', returnValue: null, outputFiles: [], durationMs: 5, error: null },
    packages: [],
  });
  assert(body.includes('Packages: (none)'), 'empty packages marker missing');
});

test('Pyodide version embedded in ENRP', () => {
  const body = ce.formatComputeEnrp({
    rulingId: 'TEST-006',
    scriptName: 'v.py',
    result: { stdout: '', stderr: '', returnValue: null, outputFiles: [], durationMs: 1, error: null },
  });
  assert(body.includes('v0.26.2'), 'Pyodide version not embedded');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
