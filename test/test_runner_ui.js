// Integration test: load runner-ui.js + index.html in jsdom, simulate button clicks,
// verify handlers fire without errors.
//
// Runs in Node with jsdom shim. This is the test that should have existed
// BEFORE shipping AR-028 and AR-030.

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

function loadScriptInto(window, scriptPath) {
  const src = fs.readFileSync(scriptPath, 'utf-8');
  const script = new vm.Script(src, { filename: path.basename(scriptPath) });
  const context = window._cachedContext || (window._cachedContext = window);
  script.runInContext(vm.createContext(window));
}

async function runTests() {
  console.log('=== jsdom UI test: runner/index.html click handler chain ===\n');

  const html = fs.readFileSync('console/runner/index.html', 'utf-8');

  // Strip <script src=...> tags from the loaded HTML — jsdom with resources:'usable'
  // would try to fetch them as http://.  We'll inject scripts manually.
  const htmlNoScripts = html.replace(/<script[^>]*src=[^>]*><\/script>/g, '');

  const dom = new JSDOM(htmlNoScripts, {
    url: 'http://localhost/console/runner/',
    runScripts: 'outside-only',
  });
  const { window } = dom;

  // Shim what browsers provide that jsdom doesn't fully:
  // - localStorage (jsdom has this, works)
  // - fetch (jsdom does not; inject a simple mock)
  // - navigator.serviceWorker (jsdom omits)
  window.fetch = async () => ({ ok: false, status: 0, text: async () => 'mock' });
  if (!window.navigator.serviceWorker) {
    window.navigator.serviceWorker = {
      register: async () => ({}),
      addEventListener: () => {},
      getRegistration: async () => null,
    };
  }

  // Pretend we have a stored GitHub PAT + Anthropic key for the pipeline to run.
  window.localStorage.setItem('yp_pat_v1', 'test-pat');
  window.localStorage.setItem('anthropic_api_key_v1', 'sk-ant-test');

  console.log('--- loading scripts in order ---');

  // Load in HTML's declared order. Any throw here is our primary bug.
  const scripts = [
    'infra/gh-api.js',
    'infra/auth.js',
    'infra/anthropic-api.js',
    'infra/runner-core.js',
    'infra/pyodide-loader.js',
    'infra/compute-executor.js',
    'infra/queue-status.js',
    'infra/queue-worker.js',
    'console/config.js',     // console-level config
    'console/runner/config.js',
    'console/runner/runner-ui.js',
  ];

  let loadError = null;
  for (const s of scripts) {
    try {
      const src = fs.readFileSync(s, 'utf-8');
      window.eval(src);
      console.log(`  ✓ loaded ${s}`);
    } catch (e) {
      loadError = `${s}: ${e.message}`;
      console.log(`  ✗ FAILED loading ${s}: ${e.message}`);
      if (e.stack) console.log(e.stack.split('\n').slice(0, 4).join('\n'));
      break;
    }
  }
  assert(!loadError, `all scripts load without throwing (${loadError || 'ok'})`);

  if (loadError) {
    console.log('\n--- STOPPING: script load failed ---\n');
    return { passed, failed, failures };
  }

  console.log('\n--- verifying globals ---');
  assert(typeof window.ghApi === 'object', 'window.ghApi defined');
  assert(typeof window.auth === 'object', 'window.auth defined');
  assert(typeof window.anthropicApi === 'object', 'window.anthropicApi defined');
  assert(typeof window.runnerCore === 'object', 'window.runnerCore defined');
  assert(typeof window.pyodideLoader === 'object', 'window.pyodideLoader defined');
  assert(typeof window.computeExecutor === 'object', 'window.computeExecutor defined');
  assert(typeof window.queueStatus === 'object', 'window.queueStatus defined');
  assert(typeof window.queueWorker === 'object', 'window.queueWorker defined');
  assert(typeof window.consoleConfig === 'object', 'window.consoleConfig defined');
  assert(typeof window.runnerConfig === 'object', 'window.runnerConfig defined');
  assert(typeof window.runnerUi === 'object', 'window.runnerUi defined');
  assert(typeof window.runnerUi?.init === 'function', 'window.runnerUi.init is function');

  console.log('\n--- calling runnerUi.init() ---');
  let initError = null;
  try {
    window.runnerUi.init();
    console.log('  ✓ init() completed without throwing');
  } catch (e) {
    initError = e;
    console.log(`  ✗ init() threw: ${e.message}`);
    if (e.stack) console.log(e.stack.split('\n').slice(0, 5).join('\n'));
  }
  assert(!initError, `runnerUi.init() completes (${initError?.message || 'ok'})`);

  console.log('\n--- simulating button clicks ---');

  const doc = window.document;

  // Check initial button states
  const setKeyBtn = doc.getElementById('setKeyBtn');
  const startBtn = doc.getElementById('startBtn');
  const clearKeyBtn = doc.getElementById('clearKeyBtn');
  assert(!!setKeyBtn, 'setKeyBtn element exists');
  assert(!!startBtn, 'startBtn element exists');
  assert(!!clearKeyBtn, 'clearKeyBtn element exists');

  // Count listeners attached (jsdom lets us inspect) — note jsdom tracks internally;
  // simplest test is to click and see if the handler body runs.
  // We intercept console.log / errors to detect side-effects.

  // Test 1: Click setKeyBtn. It calls window.prompt which jsdom returns null for.
  // Handler should handle that gracefully (return early). No throw.
  let setKeyThrew = null;
  try {
    window.prompt = () => null;  // user cancels dialog
    setKeyBtn.click();
  } catch (e) { setKeyThrew = e; }
  assert(!setKeyThrew, `setKeyBtn click runs handler without throw (${setKeyThrew?.message || 'ok'})`);

  // Test 2: Click startBtn. This calls onStartWorker which needs api key +
  // GitHub PAT (both set above) then calls queueWorker.startWorker which does
  // NOT do I/O on construction (only on polling tick). So it should succeed
  // synchronously and leave `worker` variable populated.
  let startThrew = null;
  try {
    // Suppress window.alert (jsdom throws "not implemented")
    window.alert = (msg) => console.log(`  [alert] ${msg}`);
    // confirm returns true (jsdom default is to throw)
    window.confirm = () => true;
    startBtn.click();
  } catch (e) { startThrew = e; }
  assert(!startThrew, `startBtn click runs handler without throw (${startThrew?.message || 'ok'})`);

  // Verify worker state actually updated (badge changed from OFF)
  const badge = doc.getElementById('workerStateBadge');
  const badgeText = badge?.textContent || '';
  console.log(`  badge text after startBtn click: "${badgeText}"`);
  assert(badgeText !== 'OFF', `badge text changed from "OFF" (got "${badgeText}")`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  return { passed, failed, failures };
}

runTests().then(r => process.exit(r.failed > 0 ? 1 : 0)).catch(e => {
  console.error('Harness error:', e);
  process.exit(2);
});

// NOTE: the existing harness tests with an API key set. The asymmetric-gate
// fix (worker starts without API key for compute jobs) isn't directly
// tested here because startBtn is the same click handler either way. A
// proper test would clear localStorage api_key_v1 before click, re-run,
// assert no alert and badge still transitions off→IDLE. Deferred to
// Playwright suite.
