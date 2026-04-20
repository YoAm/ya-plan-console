// CSP enforcement test: parses the CSP meta tag, simulates what a browser
// would block. Catches inline-<script> blockage that jsdom alone misses.
//
// This is the test that should have existed before AR-028 shipped.

const fs = require('fs');

let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

function extractCsp(html) {
  // Match the CSP meta tag first (may span multiple lines), then extract content=
  const metaMatch = html.match(
    /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i
  );
  if (!metaMatch) return null;
  // Content value is double-quoted; CSP directives contain single-quoted keywords like 'self', 'none'
  const contentMatch = metaMatch[0].match(/content\s*=\s*"([\s\S]*?)"\s*\/?\s*>/);
  return contentMatch ? contentMatch[1].trim() : null;
}

function parseCsp(csp) {
  const directives = {};
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...values] = tokens;
    directives[name] = values;
  }
  return directives;
}

function allowsInlineScript(directives) {
  const scriptSrc = directives['script-src'] || directives['default-src'] || [];
  return scriptSrc.includes("'unsafe-inline'");
}

function allowsEval(directives) {
  const scriptSrc = directives['script-src'] || directives['default-src'] || [];
  return scriptSrc.includes("'unsafe-eval'");
}

function allowsWasmCompile(directives) {
  // A page can compile/instantiate WebAssembly if EITHER:
  //   - script-src includes 'wasm-unsafe-eval', OR
  //   - script-src includes 'unsafe-eval' (superset)
  // Per MDN CSP script-src docs and WebAssembly CSP proposal.
  const scriptSrc = directives['script-src'] || directives['default-src'] || [];
  return scriptSrc.includes("'wasm-unsafe-eval'") || scriptSrc.includes("'unsafe-eval'");
}

function loadsPyodide(html) {
  // Detect if the page intends to load Pyodide. Either:
  //   1. Has an infra/pyodide-loader.js <script src>, or
  //   2. Mentions cdn.jsdelivr.net/pyodide in the HTML body.
  return /pyodide-loader\.js/.test(html) || /cdn\.jsdelivr\.net\/pyodide/.test(html);
}

function countInlineScripts(html) {
  // Inline <script> = <script> tags without src attribute.
  const matches = html.match(/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi) || [];
  // Filter out empty or whitespace-only bodies (those don't execute anything)
  return matches.filter(m => {
    const body = m.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '').trim();
    return body.length > 0;
  });
}

function testHtml(htmlPath, { expectsInlineScripts = false } = {}) {
  console.log(`\n=== ${htmlPath} ===`);
  const html = fs.readFileSync(htmlPath, 'utf-8');

  const csp = extractCsp(html);
  assert(!!csp, `CSP meta tag present`);
  if (!csp) return;

  const dir = parseCsp(csp);
  const hasInlineScripts = countInlineScripts(html);
  const inlineAllowed = allowsInlineScript(dir);

  console.log(`  script-src: ${(dir['script-src'] || []).join(' ')}`);
  console.log(`  inline <script> blocks (non-empty): ${hasInlineScripts.length}`);
  console.log(`  CSP allows inline: ${inlineAllowed}`);

  if (hasInlineScripts.length > 0 && !inlineAllowed) {
    failed++;
    const preview = hasInlineScripts[0].slice(0, 150).replace(/\s+/g, ' ');
    failures.push(`${htmlPath}: ${hasInlineScripts.length} inline <script> block(s) would be CSP-blocked. First: ${preview}...`);
    console.log(`  ✗ ${hasInlineScripts.length} inline <script> blocks would be blocked by this CSP`);
    console.log(`    first block preview: ${preview}`);
    return;
  }

  if (expectsInlineScripts && hasInlineScripts.length === 0) {
    console.log(`  ! (expected inline scripts but none found)`);
  }

  passed++;
  console.log(`  ✓ no CSP-blocked inline scripts`);

  // NEW: if this page loads Pyodide, require wasm-unsafe-eval
  if (loadsPyodide(html)) {
    const wasmOk = allowsWasmCompile(dir);
    if (wasmOk) {
      passed++;
      console.log(`  ✓ CSP allows WebAssembly compilation (pyodide page)`);
    } else {
      failed++;
      failures.push(
        `${htmlPath}: page loads Pyodide but CSP script-src missing 'wasm-unsafe-eval'. ` +
        `Without it, WebAssembly.compile is blocked and loadPyodide() hangs forever ` +
        `(Pyodide issue #2255: no internal timeout). ` +
        `Add 'wasm-unsafe-eval' to script-src. ` +
        `Current script-src: ${(dir['script-src'] || []).join(' ') || '(empty)'}`
      );
      console.log(`  ✗ CSP missing 'wasm-unsafe-eval' for pyodide page — WILL HANG ON LOAD`);
    }
  }
}

console.log('=== CSP enforcement test ===');

testHtml('console/runner/index.html');
testHtml('console/index.html');
testHtml('index.html');

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
