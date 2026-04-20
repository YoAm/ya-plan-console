// test_csp_wasm.js — Static audit: if the runner loads Pyodide (which needs
// WASM compile+instantiate), the CSP meta MUST include 'wasm-unsafe-eval'.
//
// Why this test exists: a subtle CSP omission caused a >3hr debugging cycle.
// loadPyodide() does not reject on WASM CSP blocks — it just hangs silently.
// Browsers emit a securitypolicyviolation event but the Promise never
// resolves. The only check that could have caught this pre-deploy is a
// static audit of the CSP string. jsdom doesn't enforce CSP; unit tests
// pass; real browser fails. Hence: static string audit.
//
// Runs in unit-test suite; fails fast, pre-deploy.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓', msg); }
  else { failed++; failures.push(msg); console.log('  ✗', msg); }
}

console.log('\n=== test_csp_wasm ===');

const htmlPath = path.join(__dirname, '..', 'console', 'runner', 'index.html');
let html;
try {
  html = fs.readFileSync(htmlPath, 'utf-8');
  assert(true, 'runner/index.html readable');
} catch (e) {
  assert(false, `runner/index.html unreadable: ${e.message}`);
  process.exit(1);
}

const cspMatch = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([\s\S]*?)"/i);
assert(!!cspMatch, 'CSP meta tag present in runner/index.html');

if (cspMatch) {
  const policy = cspMatch[1];

  const scriptSrcMatch = policy.match(/script-src\s+([^;]+)/i);
  assert(!!scriptSrcMatch, 'script-src directive present in CSP');

  if (scriptSrcMatch) {
    const scriptSrc = scriptSrcMatch[1];

    // The critical check: wasm-unsafe-eval is required for Pyodide.
    // Without it, loadPyodide() hangs forever with no error.
    assert(
      scriptSrc.includes("'wasm-unsafe-eval'"),
      `script-src includes 'wasm-unsafe-eval' (required for Pyodide WASM execution). ` +
      `Current: "${scriptSrc.trim()}"`
    );

    // Must also allow cdn.jsdelivr.net for pyodide.js
    assert(
      scriptSrc.includes('cdn.jsdelivr.net'),
      `script-src allows cdn.jsdelivr.net (required for Pyodide script loading)`
    );
  }

  // connect-src must allow cdn.jsdelivr.net for WASM binary fetch
  const connectSrcMatch = policy.match(/connect-src\s+([^;]+)/i);
  if (connectSrcMatch) {
    assert(
      connectSrcMatch[1].includes('cdn.jsdelivr.net'),
      `connect-src allows cdn.jsdelivr.net (required for pyodide.asm.wasm fetch)`
    );
  }
}

console.log(`=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
