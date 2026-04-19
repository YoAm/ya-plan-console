// infra/compute-executor.js — Python-in-Pyodide execution with /input + /output mount
// DOMAIN-BLIND per §P4.14. Generic Python executor; caller supplies script.

(function () {
  'use strict';

  const INPUT_DIR = '/input';
  const OUTPUT_DIR = '/output';

  // Run a compute job in the given pyodide instance.
  //
  // Args:
  //   pyodide      — PyodideInterface from pyodide-loader.ensurePyodide
  //   script       — Python code string
  //   pulledFiles  — [{path, content}] to mount at /input/<path>
  //   inputVars    — dict injected as pyodide globals before script runs
  //   timeoutMs    — optional soft timeout (not enforced by Pyodide itself;
  //                  caller should AbortController the surrounding Promise)
  //
  // Returns: { stdout, stderr, returnValue, outputFiles, durationMs, error }
  //   stdout/stderr — captured output strings
  //   returnValue   — final expression value (str or null)
  //   outputFiles   — [{path, content}] from /output/ tree
  //   durationMs    — wall-clock execution time
  //   error         — if script raised: { name, message, traceback }; else null
  async function runComputeJob({ pyodide, script, pulledFiles = [], inputVars = {} }) {
    const stdout = [];
    const stderr = [];
    const t0 = performance.now();

    // Set up capture
    pyodide.setStdout({
      batched: (msg) => stdout.push(msg),
    });
    pyodide.setStderr({
      batched: (msg) => stderr.push(msg),
    });

    // Reset FS: clean /input and /output
    try { cleanDir(pyodide, INPUT_DIR); } catch (_) {}
    try { cleanDir(pyodide, OUTPUT_DIR); } catch (_) {}
    safeMkdir(pyodide, INPUT_DIR);
    safeMkdir(pyodide, OUTPUT_DIR);

    // Mount pulled files
    for (const f of pulledFiles) {
      const safePath = f.path.replace(/\.\./g, '').replace(/^\/+/, '');
      const fullPath = `${INPUT_DIR}/${safePath}`;
      mkdirsForFile(pyodide, fullPath);
      pyodide.FS.writeFile(fullPath, f.content);
    }

    // Inject input vars as globals
    for (const [k, v] of Object.entries(inputVars)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
        pyodide.globals.set(k, v);
      } else {
        // JSON-serializable fallback
        pyodide.globals.set(k, pyodide.toPy(v));
      }
    }

    // Also expose INPUT_DIR and OUTPUT_DIR as globals for convenience
    pyodide.globals.set('INPUT_DIR', INPUT_DIR);
    pyodide.globals.set('OUTPUT_DIR', OUTPUT_DIR);

    // Run script
    let returnValue = null;
    let error = null;
    try {
      const result = await pyodide.runPythonAsync(script);
      // Convert Python result to JS where possible
      if (result !== undefined && result !== null) {
        try {
          returnValue = typeof result.toJs === 'function'
            ? JSON.stringify(result.toJs({ dict_converter: Object.fromEntries }))
            : String(result);
        } catch (_) {
          returnValue = String(result);
        }
        if (typeof result.destroy === 'function') result.destroy();
      }
    } catch (e) {
      error = {
        name: e.name || 'PythonError',
        message: String(e.message || e).slice(0, 2000),
        traceback: String(e.stack || '').slice(0, 4000),
      };
    }

    // Harvest /output/
    const outputFiles = walkDir(pyodide, OUTPUT_DIR, OUTPUT_DIR);

    const durationMs = Math.round(performance.now() - t0);

    return {
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      returnValue,
      outputFiles,
      durationMs,
      error,
    };
  }

  // ─── FS helpers ─────────────────────────────────────────────────────

  function safeMkdir(pyodide, path) {
    try { pyodide.FS.mkdir(path); } catch (_) { /* exists */ }
  }

  function mkdirsForFile(pyodide, fullPath) {
    const parts = fullPath.split('/').filter(Boolean);
    parts.pop();  // drop filename
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      safeMkdir(pyodide, cur);
    }
  }

  function cleanDir(pyodide, dir) {
    const entries = pyodide.FS.readdir(dir).filter(n => n !== '.' && n !== '..');
    for (const name of entries) {
      const full = dir + '/' + name;
      const stat = pyodide.FS.stat(full);
      if (pyodide.FS.isDir(stat.mode)) {
        cleanDir(pyodide, full);
        pyodide.FS.rmdir(full);
      } else {
        pyodide.FS.unlink(full);
      }
    }
  }

  function walkDir(pyodide, dir, baseDir) {
    const result = [];
    let entries;
    try {
      entries = pyodide.FS.readdir(dir).filter(n => n !== '.' && n !== '..');
    } catch (_) {
      return result;
    }
    for (const name of entries) {
      const full = dir + '/' + name;
      const stat = pyodide.FS.stat(full);
      if (pyodide.FS.isDir(stat.mode)) {
        result.push(...walkDir(pyodide, full, baseDir));
      } else {
        const relPath = full.slice(baseDir.length + 1);  // strip /output/ prefix
        let content;
        try {
          // Try UTF-8 text first; fall back to binary as base64
          const bytes = pyodide.FS.readFile(full);
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch (_) {
            // Binary — base64 encode
            content = 'BINARY_BASE64:' + btoa(String.fromCharCode.apply(null, bytes));
          }
        } catch (e) {
          content = `[read error: ${e.message}]`;
        }
        result.push({ path: relPath, content });
      }
    }
    return result;
  }

  // Format compute result as ENRP markdown body.
  // This is a convention, not a Python contract — scripts CAN emit their own ENRP
  // to /output/enrp.md and the caller will use that instead.
  function formatComputeEnrp({ rulingId, scriptName, result, packages = [] }) {
    const lines = [
      `# ENRP — ${rulingId} (compute substrate)`,
      '',
      `Script: ${scriptName}`,
      `Pyodide: ${window.pyodideLoader.PYODIDE_VERSION}`,
      `Packages: ${packages.join(', ') || '(none)'}`,
      `Duration: ${(result.durationMs / 1000).toFixed(2)}s`,
      `Status: ${result.error ? 'FAILED' : 'OK'}`,
      '',
    ];

    if (result.error) {
      lines.push('## ERROR');
      lines.push('```');
      lines.push(`${result.error.name}: ${result.error.message}`);
      if (result.error.traceback) {
        lines.push('');
        lines.push(result.error.traceback);
      }
      lines.push('```');
      lines.push('');
    }

    if (result.stdout) {
      lines.push('## STDOUT');
      lines.push('```');
      lines.push(result.stdout);
      lines.push('```');
      lines.push('');
    }

    if (result.stderr) {
      lines.push('## STDERR');
      lines.push('```');
      lines.push(result.stderr);
      lines.push('```');
      lines.push('');
    }

    if (result.returnValue !== null && result.returnValue !== undefined) {
      lines.push('## RETURN VALUE');
      lines.push('```');
      lines.push(String(result.returnValue));
      lines.push('```');
      lines.push('');
    }

    lines.push('## FILES EMITTED');
    if (result.outputFiles.length === 0) {
      lines.push('(none)');
    } else {
      for (const f of result.outputFiles) {
        const size = f.content.length;
        lines.push(`- \`${f.path}\` — ${size} bytes`);
      }
    }

    return lines.join('\n') + '\n';
  }

  window.computeExecutor = { runComputeJob, formatComputeEnrp };
})();
