// infra/pyodide-loader.js — Pyodide lazy-load singleton
// DOMAIN-BLIND per §P4.14. Loads Python-in-WASM runtime from jsdelivr CDN.
// Version pinned to v0.26.2; upgrading requires CSP + SW cache rev.

(function () {
  'use strict';

  const PYODIDE_VERSION = 'v0.26.2';
  const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/pyodide.js`;

  let loadPromise = null;
  let loadedPackages = new Set();

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
      loadPromise = (async () => {
        // Dynamic script tag injection — dispatch origin is CDN, not self
        onProgress?.('fetching_script', { url: PYODIDE_URL });
        await injectScript(PYODIDE_URL);

        if (typeof loadPyodide !== 'function') {
          throw new Error('pyodide-loader: loadPyodide not defined after script injection');
        }

        onProgress?.('initializing');
        const pyodide = await loadPyodide({
          indexURL: `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`,
        });

        onProgress?.('ready');
        return pyodide;
      })();
    }

    const pyodide = await loadPromise;

    // Incrementally load any requested packages not already loaded
    const missing = packages.filter(p => !loadedPackages.has(p));
    if (missing.length > 0) {
      onProgress?.('loading_packages', { packages: missing });
      await pyodide.loadPackage(missing);
      missing.forEach(p => loadedPackages.add(p));
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
    return {
      version: PYODIDE_VERSION,
      initialized: !!loadPromise,
      loaded: loadPromise !== null,
      packages: [...loadedPackages],
    };
  }

  window.pyodideLoader = { ensurePyodide, status, PYODIDE_VERSION };
})();
