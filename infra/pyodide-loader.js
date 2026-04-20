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
  async function ensurePyodide({ packages = [], onProgress = null } = {}) {
    if (!loadPromise) {
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

  window.pyodideLoader = { ensurePyodide, status, PYODIDE_VERSION };
})();
