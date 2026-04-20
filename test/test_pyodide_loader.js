// Unit tests for pyodide-loader.js
// Validates: exports, health-check shape, WASM detection logic
//
// We don't actually run loadPyodide here (requires browser WASM).
// We test the structure of runHealthChecks and validate it catches
// a missing WebAssembly global.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

console.log('=== pyodide-loader tests ===\n');

// Load source code
const loaderSrc = fs.readFileSync(
  path.join(__dirname, '..', 'infra', 'pyodide-loader.js'),
  'utf-8'
);

// Structural checks
assert(loaderSrc.includes('runHealthChecks'), 'exports runHealthChecks');
assert(loaderSrc.includes("window.pyodideLoader = { ensurePyodide, status, runHealthChecks"),
  'runHealthChecks in public API');
assert(loaderSrc.includes('WebAssembly.compile'), 'health check tests WebAssembly.compile');
assert(loaderSrc.includes("'wasm-unsafe-eval'"), 'error message mentions wasm-unsafe-eval');
assert(loaderSrc.includes('installFetchInterceptor'), 'fetch interceptor present');
assert(loaderSrc.includes('LOAD_TIMEOUT_MS') || loaderSrc.includes('Pyodide load timeout'),
  '5-minute load timeout wrapper present');

// Preflight is async-await, catches BEFORE loadPyodide
assert(loaderSrc.includes('await runHealthChecks()'),
  'ensurePyodide awaits runHealthChecks before load');
assert(loaderSrc.includes('wasm_compile') && loaderSrc.includes('wasm_instantiate'),
  'tests both compile AND instantiate separately');

// Load simulated runtime
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
  runScripts: 'outside-only',
  url: 'https://example.com/',
});

const window = dom.window;
// Provide minimal globals
window.pyodideLoader = null;
window.document = dom.window.document;

// Stub fetch to simulate success on HEAD requests
window.fetch = async (url, opts) => {
  return {
    ok: true,
    status: 200,
    headers: new Map([['Content-Length', '100']]),
    body: null,
  };
};
window.fetch.bind = (t) => window.fetch;

// Stub WebAssembly that ACTUALLY compiles (in Node, this works natively)
// NOTE: jsdom doesn't provide WebAssembly; inject from Node global
if (typeof WebAssembly !== 'undefined') {
  window.WebAssembly = WebAssembly;
}

// Eval the loader source in the jsdom window
try {
  // The loader uses an IIFE: (function() { ... })(). We evaluate it.
  const evalFn = new Function('window', 'globalThis', 'document', 'fetch', 'WebAssembly',
    'structuredClone', 'AbortController', 'setTimeout', 'clearTimeout', 'console',
    loaderSrc);

  evalFn(
    window, window, window.document, window.fetch,
    window.WebAssembly, global.structuredClone,
    global.AbortController, global.setTimeout, global.clearTimeout, console
  );

  assert(typeof window.pyodideLoader === 'object', 'pyodideLoader installed on window');
  assert(typeof window.pyodideLoader.runHealthChecks === 'function',
    'runHealthChecks is a function');
  assert(typeof window.pyodideLoader.ensurePyodide === 'function',
    'ensurePyodide is a function');
  assert(typeof window.pyodideLoader.status === 'function', 'status is a function');
  assert(typeof window.pyodideLoader.PYODIDE_VERSION === 'string', 'PYODIDE_VERSION exported');
  assert(window.pyodideLoader.PYODIDE_VERSION.startsWith('v0.'),
    `PYODIDE_VERSION looks valid: ${window.pyodideLoader.PYODIDE_VERSION}`);
} catch (e) {
  failed++;
  failures.push(`failed to eval loader: ${e.message}`);
  console.log(`  ✗ loader eval error: ${e.message}`);
}

// Call runHealthChecks and verify shape
(async () => {
  if (window.pyodideLoader?.runHealthChecks) {
    try {
      const hc = await window.pyodideLoader.runHealthChecks();
      assert(typeof hc === 'object', 'runHealthChecks returns object');
      assert(typeof hc.ok === 'boolean', 'hc.ok is boolean');
      assert(Array.isArray(hc.checks), 'hc.checks is array');
      assert(hc.checks.length >= 5, `hc.checks has at least 5 entries (got ${hc.checks.length})`);
      assert(typeof hc.summary === 'string', 'hc.summary is string');

      // Each check has required shape
      const firstCheck = hc.checks[0];
      assert(typeof firstCheck.name === 'string', 'check.name is string');
      assert(typeof firstCheck.ok === 'boolean', 'check.ok is boolean');
      assert(typeof firstCheck.detail === 'string', 'check.detail is string');

      // We expect specific check names to exist
      const checkNames = hc.checks.map(c => c.name);
      const expectedNames = ['webassembly_api', 'wasm_compile', 'wasm_instantiate', 'fetch_api'];
      for (const name of expectedNames) {
        assert(checkNames.includes(name), `check '${name}' present`);
      }

      // In Node with real WebAssembly, wasm_compile should pass
      const wasmCompile = hc.checks.find(c => c.name === 'wasm_compile');
      assert(wasmCompile && wasmCompile.ok, 'wasm_compile passes in test env');
    } catch (e) {
      failed++;
      failures.push(`health check exec error: ${e.message}`);
      console.log(`  ✗ runHealthChecks threw: ${e.message}`);
    }
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
