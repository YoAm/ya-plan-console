# ya-plan-console test suite

Run from repo root:

```bash
npm install           # one-time: installs jsdom for UI integration tests
npm test              # runs all test suites in sequence
npm run test:fast     # only Node-only tests (skips jsdom UI test)
npm run test:ui       # only jsdom UI integration
```

All suites exit non-zero on failure.

## Test suites

### `test_csp.js` — CSP static analysis

Parses the `<meta http-equiv="Content-Security-Policy">` tag in each HTML file.
For each `script-src` that does NOT include `'unsafe-inline'`, scans for
non-empty inline `<script>...</script>` blocks. Fails if any would be blocked.

Catches: the AR-028 bug class (inline bootstrap script blocked by CSP, buttons
inert). Limitation: static only — doesn't catch dynamic CSP violations (eval,
innerHTML with scripts, blob: URLs). Runtime violations handled by
`securitypolicyviolation` listener in `runner-ui.js`, logged to localStorage.

### `test_runner_core.js` — pure function unit tests (27 tests)

Loads `infra/runner-core.js` in a Node vm sandbox, exercises:

- `parseJob`: substrate validation (llm/compute), field requirements
- `parseMultiFileManifest`: extraction, `allowedPathPrefixes` enforcement,
  **path-traversal rejection** (`..` segments, absolute paths)
- `buildMessages`: spawn text + pulled files composition
- `extractEnrp`: envelope parsing, fallback on missing envelope
- `enrpFilename`: timestamp format
- `statusLine`: JSONL event formatting

### `test_compute_executor.js` — ENRP formatter tests (6 tests)

Loads `infra/compute-executor.js`, tests `formatComputeEnrp` output:
stdout/stderr rendering, error + traceback handling, output file listing,
empty result markers, packages embedding, Pyodide version stamping.

**Not tested here**: `runComputeJob` itself (requires real Pyodide).
Deferred to Playwright E2E (future AR).

### `test_runner_ui.js` — jsdom UI integration (20 tests)

Loads all runner scripts in real HTML order, verifies `window.*` globals,
invokes `runnerUi.init()`, simulates `setKeyBtn` + `startBtn` clicks,
asserts `workerStateBadge` transitions from OFF → IDLE.

**Limitation**: jsdom doesn't enforce CSP. This test alone cannot catch
CSP-blocked inline scripts — that's what `test_csp.js` is for.

## What's NOT in this suite

- **Real browser E2E** (Playwright): would catch CSP violations, SW
  lifecycle bugs, Pyodide boot failures, touch handler differences.
  ~200MB Chromium install. Planned as future AR.
- **Real Pyodide execution**: same reason as above.
- **Real GitHub API I/O**: integration tests would hit rate limits + require
  a test PAT. Unit-tested at the function level; full chain validated
  empirically by shipping jobs to the runner.

## Pre-commit discipline

Before any push touching `console/runner/`, `infra/`, or `console/sw.js`:

```bash
npm test
```

All 56 tests must pass. Discovered bugs (path traversal, timestamp truncation)
are captured as tests before fixing, so regressions are caught at commit time.
