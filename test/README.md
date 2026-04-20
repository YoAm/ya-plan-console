# ya-plan-console test suite

Run from repo root:

```
node test/test_csp.js         # CSP static-analysis (catches inline-script blocking)
node test/test_runner_ui.js   # jsdom integration (script load + button click chain)
```

Both tests exit non-zero on failure. Wire to CI when ready.

## What each test catches

### test_csp.js

Parses the `<meta http-equiv="Content-Security-Policy">` tag in each HTML file.
For each `script-src` directive that does NOT include `'unsafe-inline'`, scans
the same HTML for non-empty inline `<script>...</script>` blocks. Any found =
**would be silently blocked by the browser**, which is the bug class that shipped
in AR-028 (runner-ui.init() inline script → buttons do nothing).

### test_runner_ui.js

Loads all runner scripts into jsdom (simulating real script-tag order), verifies
every expected `window.*` global is defined, invokes `runnerUi.init()`, and
simulates clicks on `setKeyBtn` / `startBtn`. Verifies no handler throws and
that `workerStateBadge` text transitions from `OFF` → non-OFF on start click.

**Limits:** jsdom does NOT enforce CSP. A script that would be blocked in a
real browser runs fine in jsdom. This is why test_csp.js exists.

## Pre-commit hook (manual, for now)

```bash
node test/test_csp.js && node test/test_runner_ui.js
```

Run before any `git push` touching runner/ or infra/.
