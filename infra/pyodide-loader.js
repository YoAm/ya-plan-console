// infra/pyodide-loader.js — Pyodide lazy-load singleton
// DOMAIN-BLIND per §P4.14. Loads Python-in-WASM runtime from jsdelivr CDN.
// Version pinned to v0.26.2; upgrading requires CSP + SW cache rev.

(function () {
  'use strict';

  // v0.29.3 (Jan 2026): addresses pyodide #5280 (Android Chrome hang on init)
  // which affected v0.26.x. Also includes accumulated stability fixes.
  const PYODIDE_VERSION = 'v0.29.3';
  const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/pyodide.js`;

  let loadPromise = null;
  let loadedPackages = new Set();
  let isReady = false;  // true once loadPromise has resolved
  let progress = {
    startMs: null,         // when ensurePyodide first called
    stage: null,           // current stage label
    stageStartMs: null,    // when current stage started
    lastHeartbeatMs: null, // last time any progress callback fired
    lastHeartbeatElapsed: 0, // s elapsed at last heartbeat (for display)
    // Download tracking (via fetch interceptor, pyodide discussion #2927)
    download: {
      url: null,            // currently-downloading file URL
      bytesLoaded: 0,       // bytes received so far
      bytesTotal: 0,        // Content-Length (0 if unknown e.g. gzip)
      lastBytes: 0,         // bytes at last sample
      lastSampleMs: 0,      // ms of last sample
      bytesPerSec: 0,       // current transfer rate
      filesCompleted: 0,    // count of files fully streamed
      fromCache: false,     // true if response came from SW cache (very fast)
    },
  };

  // Fetch interceptor: monkey-patches global fetch to stream byte progress
  // for Pyodide CDN files. No native progress API exists for loadPyodide
  // (see pyodide discussion #2927); this is the canonical workaround.
  // Only intercepts cdn.jsdelivr.net; everything else passes through.
  let originalFetch = null;
  function installFetchInterceptor() {
    if (originalFetch) return;
    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes('cdn.jsdelivr.net/pyodide')) {
        return originalFetch(input, init);
      }
      const startMs = Date.now();
      const response = await originalFetch(input, init);
      if (!response.body) return response;

      // Reset download state for this file
      progress.download.url = url;
      progress.download.bytesLoaded = 0;
      progress.download.bytesTotal = parseInt(response.headers.get('Content-Length') || '0', 10);
      progress.download.lastBytes = 0;
      progress.download.lastSampleMs = Date.now();
      progress.download.bytesPerSec = 0;
      progress.download.fromCache = false;  // reset; will detect on flush

      // Detect SW-cache hit heuristically: response resolves in <50ms AND
      // Content-Length is present. Cache reads skip the network roundtrip.
      const respArrivalMs = Date.now() - startMs;
      const likelyCached = respArrivalMs < 50 && progress.download.bytesTotal > 0;

      const ts = new TransformStream({
        transform(chunk, ctrl) {
          progress.download.bytesLoaded += chunk.byteLength;
          const now = Date.now();
          const dt = now - progress.download.lastSampleMs;
          if (dt >= 300) {
            const db = progress.download.bytesLoaded - progress.download.lastBytes;
            progress.download.bytesPerSec = Math.round(db * 1000 / dt);
            progress.download.lastBytes = progress.download.bytesLoaded;
            progress.download.lastSampleMs = now;
          }
          progress.lastHeartbeatMs = now;
          ctrl.enqueue(chunk);
        },
        flush() {
          progress.download.filesCompleted += 1;
          // Total elapsed for whole transfer — if very fast relative to size,
          // it was a cache hit
          const totalElapsed = Date.now() - startMs;
          progress.download.fromCache = likelyCached || (
            progress.download.bytesLoaded > 1_000_000 && totalElapsed < 200
          );
        },
      });
      return new Response(response.body.pipeThrough(ts), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }
  function uninstallFetchInterceptor() {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
  }

  function recordProgress(stage, detail) {
    progress.stage = stage;
    progress.stageStartMs = Date.now();
    progress.lastHeartbeatMs = Date.now();
    if (detail && typeof detail.elapsed_s === 'number') {
      progress.lastHeartbeatElapsed = detail.elapsed_s;
    }
  }

  // Ensures Pyodide is loaded and returns the singleton instance.
  // First call triggers CDN fetch + WASM initialization (~10MB, ~10-30s cold).
  // Subsequent calls return the cached instance immediately.
  //
  // Args:
  //   packages — array of package names to ensure loaded (e.g. ['numpy']).
  //              Safe to call repeatedly; loads only missing packages.
  //   onProgress — optional callback: (stage, detail) => void
  //     stages: 'fetching_script', 'initializing', 'loading_packages', 'ready'
  //
  // Returns: Promise<PyodideInterface>
  // ═══ Preflight health checks ═════════════════════════════════════════
  // These catch environment bugs BEFORE attempting loadPyodide, which can
  // hang silently for minutes when WASM compile is CSP-blocked (see
  // pyodide/pyodide#2255 — loadPyodide has no timeout and catches its own
  // internal errors). We surface the issue at our layer instead.
  //
  // Returns: { ok: boolean, checks: { name, ok, detail }[], summary: string }
  async function runHealthChecks() {
    const checks = [];

    // 1. WebAssembly global exists
    const hasWA = typeof WebAssembly !== 'undefined' && typeof WebAssembly.compile === 'function';
    checks.push({
      name: 'webassembly_api',
      ok: hasWA,
      detail: hasWA ? 'WebAssembly.compile present' : 'WebAssembly API missing (very old browser?)',
    });

    // 2. WASM compilation actually works (this is the CSP-blocker test)
    // Smallest valid WASM module: magic + version bytes + empty module.
    const MIN_WASM = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,  // \0asm magic
      0x01, 0x00, 0x00, 0x00,  // version 1
    ]);
    let compileOk = false, compileErr = null;
    if (hasWA) {
      try {
        await WebAssembly.compile(MIN_WASM);
        compileOk = true;
      } catch (e) {
        compileErr = e;
      }
    }
    checks.push({
      name: 'wasm_compile',
      ok: compileOk,
      detail: compileOk
        ? 'WebAssembly.compile succeeded on minimal module'
        : `FAIL: ${compileErr?.message || 'unknown'} — likely CSP missing 'wasm-unsafe-eval' in script-src`,
    });

    // 3. WASM instantiation works
    let instantiateOk = false, instantiateErr = null;
    if (compileOk) {
      try {
        const mod = await WebAssembly.compile(MIN_WASM);
        await WebAssembly.instantiate(mod);
        instantiateOk = true;
      } catch (e) {
        instantiateErr = e;
      }
    }
    checks.push({
      name: 'wasm_instantiate',
      ok: instantiateOk,
      detail: instantiateOk
        ? 'WebAssembly.instantiate succeeded'
        : `FAIL: ${instantiateErr?.message || 'skipped (compile failed)'}`,
    });

    // 4. WebAssembly.instantiateStreaming available (needed for large .wasm files)
    const hasStreaming = hasWA && typeof WebAssembly.instantiateStreaming === 'function';
    checks.push({
      name: 'wasm_instantiate_streaming',
      ok: hasStreaming,
      detail: hasStreaming
        ? 'WebAssembly.instantiateStreaming present'
        : 'missing — will fall back to ArrayBuffer path (slower but works)',
    });

    // 5. Fetch API exists (for CDN downloads)
    const hasFetch = typeof fetch === 'function';
    checks.push({
      name: 'fetch_api',
      ok: hasFetch,
      detail: hasFetch ? 'fetch() present' : 'fetch API missing',
    });

    // 6. CDN reachability (don't wait long; 3s timeout)
    let cdnOk = false, cdnErr = null;
    if (hasFetch) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 3000);
        const resp = await fetch(`https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/pyodide.js`, {
          method: 'HEAD', signal: ctl.signal,
        });
        clearTimeout(timer);
        cdnOk = resp.ok;
        if (!resp.ok) cdnErr = new Error(`HTTP ${resp.status}`);
      } catch (e) {
        cdnErr = e;
      }
    }
    checks.push({
      name: 'cdn_reachable',
      ok: cdnOk,
      detail: cdnOk
        ? `cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/ reachable`
        : `FAIL: ${cdnErr?.message || 'unknown'} — check network/CSP connect-src`,
    });

    // 7. Structured clone support (Pyodide uses it extensively)
    const hasStructuredClone = typeof structuredClone === 'function';
    checks.push({
      name: 'structured_clone',
      ok: hasStructuredClone,
      detail: hasStructuredClone ? 'structuredClone available' : 'old browser (may still work)',
    });

    const critical = checks.filter(c => ['webassembly_api', 'wasm_compile', 'wasm_instantiate', 'fetch_api'].includes(c.name));
    const allCriticalOk = critical.every(c => c.ok);
    const failed = checks.filter(c => !c.ok);
    const summary = allCriticalOk
      ? `all critical checks passed (${checks.length - failed.length}/${checks.length})`
      : `FAILED: ${failed.map(c => c.name).join(', ')}`;

    return { ok: allCriticalOk, checks, summary };
  }

  async function ensurePyodide({ packages = [], onProgress = null } = {}) {
    if (!loadPromise) {
      // Preflight: detect CSP/browser incompat BEFORE attempting loadPyodide.
      // Without this, a blocked WebAssembly.compile would hang loadPyodide
      // silently (no timeout, no error surfaced) — see pyodide issue #2255.
      const health = await runHealthChecks();
      if (!health.ok) {
        const wasmCheck = health.checks.find(c => c.name === 'wasm_compile');
        if (wasmCheck && !wasmCheck.ok) {
          throw new Error(
            `Pyodide cannot load: WebAssembly compilation blocked. ` +
            `This is almost always a CSP issue — the page's ` +
            `Content-Security-Policy needs 'wasm-unsafe-eval' in the ` +
            `script-src directive. See MDN: ` +
            `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src. ` +
            `Detail: ${wasmCheck.detail}`
          );
        }
        throw new Error(`Pyodide preflight failed: ${health.summary}`);
      }

      progress.startMs = Date.now();
      progress.stage = 'starting';
      progress.stageStartMs = Date.now();
      progress.lastHeartbeatMs = Date.now();

      // Install fetch interceptor so we see byte-level progress for CDN files
      installFetchInterceptor();

      // Wrap onProgress to also record local progress
      const recordAndEmit = (stage, detail) => {
        recordProgress(stage, detail);
        onProgress?.(stage, detail);
      };

      loadPromise = (async () => {
        // Dynamic script tag injection — dispatch origin is CDN, not self
        recordAndEmit('fetching_script', { url: PYODIDE_URL });
        const fetchStart = Date.now();
        await injectScript(PYODIDE_URL);
        recordAndEmit('script_loaded', { elapsed_ms: Date.now() - fetchStart });

        if (typeof loadPyodide !== 'function') {
          throw new Error('pyodide-loader: loadPyodide not defined after script injection');
        }

        recordAndEmit('initializing');
        // Emit a heartbeat every 2s during loadPyodide so UI + status log
        // show progress (loadPyodide is a single long await with no native
        // progress events; we interpolate).
        const initStart = Date.now();
        const heartbeat = setInterval(() => {
          const elapsed_s = Math.round((Date.now() - initStart) / 1000);
          recordAndEmit('initializing_heartbeat', { elapsed_s });
        }, 2000);

        let pyodide;
        // Hard timeout: if loadPyodide hangs >5min, reject.
        // Prevents worker looping forever on broken platforms
        // (e.g. Pyodide v0.26 on Android per #5280, fixed in v0.29+).
        const LOAD_TIMEOUT_MS = 5 * 60 * 1000;
        try {
          pyodide = await Promise.race([
            loadPyodide({
              indexURL: `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`,
            }),
            new Promise((_, reject) => setTimeout(() => reject(
              new Error(`Pyodide load timeout: >${LOAD_TIMEOUT_MS/1000}s. ` +
                        `WASM runtime never initialized. ` +
                        `May indicate platform incompatibility (Android ≤ v0.26, ` +
                        `iOS wasm-gc bug). Current version: ${PYODIDE_VERSION}.`)
            ), LOAD_TIMEOUT_MS)),
          ]);
        } catch (e) {
          // Reset loadPromise so user can retry after fixing underlying issue
          loadPromise = null;
          throw e;
        } finally {
          clearInterval(heartbeat);
        }

        recordAndEmit('ready', { init_ms: Date.now() - initStart });
        isReady = true;
        uninstallFetchInterceptor();
        return pyodide;
      })();
      loadPromise.catch(() => { uninstallFetchInterceptor(); });
    }

    const pyodide = await loadPromise;

    // Incrementally load any requested packages not already loaded
    const missing = packages.filter(p => !loadedPackages.has(p));
    if (missing.length > 0) {
      recordProgress('loading_packages', { packages: missing });
      onProgress?.('loading_packages', { packages: missing });
      await pyodide.loadPackage(missing);
      missing.forEach(p => loadedPackages.add(p));
      recordProgress('packages_loaded', { packages: missing });
      onProgress?.('packages_loaded', { packages: missing });
    }

    return pyodide;
  }

  // Helper: inject external script via document head, resolve on load/error
  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = (e) => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  // Query loader state (diagnostic)
  function status() {
    const now = Date.now();
    return {
      version: PYODIDE_VERSION,
      initialized: !!loadPromise,
      ready: isReady,
      packages: [...loadedPackages],
      progress: {
        stage: progress.stage,
        elapsedMs: progress.startMs ? (now - progress.startMs) : 0,
        stageElapsedMs: progress.stageStartMs ? (now - progress.stageStartMs) : 0,
        sinceHeartbeatMs: progress.lastHeartbeatMs ? (now - progress.lastHeartbeatMs) : 0,
        lastHeartbeatElapsed: progress.lastHeartbeatElapsed,
        download: { ...progress.download },
      },
    };
  }

  window.pyodideLoader = { ensurePyodide, status, runHealthChecks, PYODIDE_VERSION };
})();
