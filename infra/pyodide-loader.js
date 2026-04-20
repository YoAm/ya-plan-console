// infra/pyodide-loader.js — Pyodide lazy-load singleton
// DOMAIN-BLIND per §P4.14. Loads Python-in-WASM runtime from jsdelivr CDN.
// Version pinned to v0.26.2; upgrading requires CSP + SW cache rev.

(function () {
  'use strict';

  const PYODIDE_VERSION = 'v0.26.2';
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
  };

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
        try {
          pyodide = await loadPyodide({
            indexURL: `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`,
          });
        } finally {
          clearInterval(heartbeat);
        }

        recordAndEmit('ready', { init_ms: Date.now() - initStart });
        isReady = true;
        return pyodide;
      })();
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
      },
    };
  }

  window.pyodideLoader = { ensurePyodide, status, PYODIDE_VERSION };
})();
