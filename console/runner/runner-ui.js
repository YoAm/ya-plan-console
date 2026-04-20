// console/runner/runner-ui.js — UI dashboard for the runner tab
// Application tier: knows about plan repo paths via runnerConfig + consoleConfig.

(function () {
  'use strict';

  const CFG = window.runnerConfig;
  const CCFG = window.consoleConfig;

  // ═══ Telemetry helper ═══════════════════════════════════════════════
  // window.telemetry is loaded by console/telemetry.js (imported in index.html).
  // Fail gracefully if absent (e.g., future standalone runner deployment).
  function tlog(name, attrs) {
    try {
      if (window.telemetry?.log) window.telemetry.log('runner.' + name, attrs || {});
    } catch (_) { /* swallow */ }
  }

  // ═══ CSP violation telemetry ═════════════════════════════════════════
  // Catches any CSP violation at runtime (inline script we missed, blob:,
  // unexpected eval, etc). We log to console + localStorage for dev visibility;
  // telemetry integration comes when console/telemetry.js is graduated to infra.
  const CSP_VIOLATIONS_KEY = 'yp_csp_violations_v1';
  document.addEventListener('securitypolicyviolation', (e) => {
    const entry = {
      ts: new Date().toISOString(),
      blockedURI: e.blockedURI,
      violatedDirective: e.violatedDirective,
      effectiveDirective: e.effectiveDirective,
      sourceFile: e.sourceFile,
      lineNumber: e.lineNumber,
      sample: (e.sample || '').slice(0, 200),
    };
    try {
      const existing = JSON.parse(localStorage.getItem(CSP_VIOLATIONS_KEY) || '[]');
      existing.push(entry);
      const trimmed = existing.slice(-50);
      localStorage.setItem(CSP_VIOLATIONS_KEY, JSON.stringify(trimmed));
    } catch (_) { /* localStorage full or JSON parse failure — ignore */ }
    console.warn('[CSP violation]', entry);
    tlog('csp_violation', {
      blockedURI: entry.blockedURI,
      violatedDirective: entry.violatedDirective,
      sourceFile: entry.sourceFile,
      lineNumber: entry.lineNumber,
    });

    // WASM-related CSP violations are critical for the compute substrate —
    // without WASM, Pyodide hangs silently. Surface immediately with the
    // exact fix. Must NOT be lost in status ticker (as happened prior).
    if (entry.blockedURI === 'wasm-eval' ||
        (entry.violatedDirective && entry.violatedDirective.includes('wasm')) ||
        (entry.sourceFile && entry.sourceFile.includes('pyodide'))) {
      showCriticalError(
        'WASM blocked by Content-Security-Policy',
        `Pyodide cannot execute. script-src needs 'wasm-unsafe-eval'. ` +
        `Blocked URI: ${entry.blockedURI}. Violated: ${entry.violatedDirective}. ` +
        `Fix: edit the CSP meta tag in runner/index.html to include 'wasm-unsafe-eval' in script-src.`
      );
    }
  });

  // ═══ Critical error banner ══════════════════════════════════════════
  // For issues the user MUST see immediately. Persists across renders.
  function showCriticalError(title, detail) {
    let banner = document.getElementById('criticalErrorBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'criticalErrorBanner';
      banner.style.cssText = 'background:#5a1818;color:#ffe0b2;padding:12px 16px;' +
        'border:2px solid #ff6b6b;border-radius:6px;margin:10px 0;' +
        'font:12px ui-monospace,monospace;line-height:1.5;';
      const main = document.querySelector('main') || document.body;
      main.insertBefore(banner, main.firstChild);
    }
    if (banner.dataset.title === title) return;  // dedupe
    banner.dataset.title = title;
    banner.innerHTML = `<strong>⚠ ${escapeHtml(title)}</strong><br>` +
                       `<span style="opacity:0.9">${escapeHtml(detail)}</span>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ═══ Auto-update (AR-034) ════════════════════════════════════════════
  // Runner polls for SW updates every 60s; on controllerchange, auto-reloads.
  // Console keeps user-confirm behavior; runner is more aggressive because
  // losing an in-flight compute job is cheaper than stale-UI confusion.
  let updatePollTimer = null;
  let reloadScheduled = false;

  async function checkForUpdate() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistration) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    } catch (e) {
      // Silent — update failures are non-fatal
    }
  }

  function setupAutoUpdate() {
    if (!navigator.serviceWorker) return;

    // Register SW if not already (console's index.html does this; runner
    // subpath inherits same SW via same-origin scope).
    // Trigger reload when new SW takes over
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadScheduled) return;
      reloadScheduled = true;
      const el = document.getElementById('updateStatus');
      if (el) { el.textContent = 'new version → reloading in 2s…'; el.className = 'warn'; }
      // Small delay so user sees the status, then reload
      setTimeout(() => location.reload(), 2000);
    });

    // Poll every 60s
    if (updatePollTimer) clearInterval(updatePollTimer);
    updatePollTimer = setInterval(checkForUpdate, 60000);
    // Also check immediately
    setTimeout(checkForUpdate, 3000);
  }

  function renderUpdateStatus() {
    const el = document.getElementById('updateStatus');
    if (!el) return;
    if (reloadScheduled) {
      el.textContent = 'new version → reloading…';
      el.className = 'warn';
    } else if (!navigator.serviceWorker) {
      el.textContent = 'no service worker (unsupported browser)';
      el.className = 'err';
    } else {
      el.textContent = 'up to date (auto-polling every 60s)';
      el.className = 'small';
    }
  }

  // ═══ Wake Lock (AR-035) ══════════════════════════════════════════════
  // Screen Wake Lock: prevents device sleep while runner is draining.
  // HONEST LIMITS: only keeps screen awake; does NOT prevent tab background
  // suspension if user switches apps. Tab must remain foreground.
  let wakeLockSentinel = null;
  let wakeLockIntent = false;  // user wants it; re-acquire on visibility

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      alert('Wake Lock API not supported in this browser.');
      return false;
    }
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
        renderWakeLockStatus();
      });
      wakeLockIntent = true;
      renderWakeLockStatus();
      return true;
    } catch (e) {
      alert('Wake Lock failed: ' + e.message);
      return false;
    }
  }

  async function releaseWakeLock() {
    wakeLockIntent = false;
    if (wakeLockSentinel) {
      try { await wakeLockSentinel.release(); } catch (_) {}
      wakeLockSentinel = null;
    }
    renderWakeLockStatus();
  }

  function renderWakeLockStatus() {
    const statusEl = document.getElementById('wakeLockStatus');
    const btn = document.getElementById('wakeLockToggleBtn');
    if (!statusEl || !btn) return;
    if (!('wakeLock' in navigator)) {
      statusEl.textContent = '⚠ not supported in this browser';
      statusEl.className = 'err';
      btn.disabled = true;
      btn.textContent = 'unsupported';
      return;
    }
    btn.disabled = false;
    if (wakeLockSentinel) {
      statusEl.textContent = '🔆 screen lock ACTIVE';
      statusEl.className = 'ok';
      btn.textContent = 'Release screen lock';
      btn.className = 'danger';
    } else {
      statusEl.textContent = 'screen lock off';
      statusEl.className = 'small';
      btn.textContent = '🔆 Keep screen on';
      btn.className = '';
    }
  }

  async function toggleWakeLock() {
    if (wakeLockSentinel) {
      await releaseWakeLock();
    } else {
      await requestWakeLock();
    }
  }

  // Re-acquire wake lock on visibility change if user wanted it
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && wakeLockIntent && !wakeLockSentinel) {
      try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
          renderWakeLockStatus();
        });
        renderWakeLockStatus();
      } catch (_) { /* browser may reject after background; swallow */ }
    }
  });

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ═══ Anthropic key management ═══════════════════════════════════════

  function loadApiKey() {
    return localStorage.getItem(CFG.ANTHROPIC_KEY_STORAGE_KEY);
  }

  function saveApiKey(key) {
    localStorage.setItem(CFG.ANTHROPIC_KEY_STORAGE_KEY, key);
  }

  function clearApiKey() {
    localStorage.removeItem(CFG.ANTHROPIC_KEY_STORAGE_KEY);
  }

  // Redact any occurrence of the key in an arbitrary string (belt + suspenders).
  function redact(str) {
    const key = loadApiKey();
    if (!key) return str;
    return String(str).split(key).join('sk-ant-***REDACTED***');
  }

  // ═══ Worker ID ═══════════════════════════════════════════════════════

  function getOrCreateWorkerId() {
    let id = localStorage.getItem(CFG.WORKER_ID_STORAGE_KEY);
    if (!id) {
      id = 'pwa-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(CFG.WORKER_ID_STORAGE_KEY, id);
    }
    return id;
  }

  // ═══ GitHub PAT accessor (reuses console's storage) ══════════════════

  function getPat() {
    return localStorage.getItem(CCFG.STORAGE_KEY);
  }

  // ═══ Worker state ════════════════════════════════════════════════════

  let worker = null;
  let recentJobs = [];  // { rulingId, state, ts, durationMs, detail }

  // ═══ Render ══════════════════════════════════════════════════════════

  const PYODIDE_STAGE_LABELS = {
    starting: 'starting…',
    fetching_script: 'downloading pyodide.js',
    script_loaded: 'script loaded',
    initializing: 'initializing WASM runtime…',
    initializing_heartbeat: 'initializing WASM runtime…',
    loading_packages: 'loading packages…',
    packages_loaded: 'packages ready',
    ready: 'ready',
  };

  function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function renderPyodideState() {
    if (!window.pyodideLoader) return;
    const s = window.pyodideLoader.status();

    const idleBlock = $('pyodideIdleBlock');
    const loadingBlock = $('pyodideLoadingBlock');
    const inlineEl = $('pyodideInlineStatus');
    const stageLabel = $('pyodideStageLabel');
    const elapsedLabel = $('pyodideElapsed');
    const bar = $('pyodideProgressBar');
    const warningEl = $('pyodideWarning');

    const isLoading = s.initialized && !s.ready;
    const isReady = s.ready;
    const isIdle = !s.initialized;

    // Toggle card blocks — when loading, hide idle pane and show progress pane
    if (idleBlock) idleBlock.style.display = isLoading ? 'none' : '';
    if (loadingBlock) loadingBlock.style.display = isLoading ? '' : 'none';

    // Inline label (idle + ready states)
    if (inlineEl) {
      if (isReady && s.packages.length > 0) {
        inlineEl.textContent = `✓ pyodide ${s.version} · ${s.packages.join(',')}`;
        inlineEl.className = 'ok';
      } else if (isReady) {
        inlineEl.textContent = `✓ pyodide ${s.version} ready`;
        inlineEl.className = 'ok';
      } else if (isIdle) {
        inlineEl.textContent = `pyodide idle (loads on first job · ${s.version})`;
        inlineEl.className = 'small';
      }
    }

    // Prewarm button — only usable when idle
    const pwBtn = $('pyodidePrewarmBtn');
    if (pwBtn) pwBtn.disabled = !isIdle;

    // Loading pane — animate with download progress, elapsed, warnings
    if (isLoading) {
      const stage = s.progress.stage;
      const humanStage = PYODIDE_STAGE_LABELS[stage] || stage || 'loading…';
      const dl = s.progress.download || {};

      if (stageLabel) {
        if (dl.bytesLoaded > 0 && dl.url) {
          const filename = dl.url.split('/').pop() || 'pyodide.asm.wasm';
          const loadedMB = (dl.bytesLoaded / 1024 / 1024).toFixed(1);
          const speedKB = dl.bytesPerSec > 0 ? (dl.bytesPerSec / 1024).toFixed(0) : '—';
          if (dl.fromCache && dl.filesCompleted > 0) {
            stageLabel.textContent = `⚡ ${filename} from cache (${loadedMB} MB)`;
          } else if (dl.bytesTotal > 0) {
            const totalMB = (dl.bytesTotal / 1024 / 1024).toFixed(1);
            const pct = Math.round(dl.bytesLoaded / dl.bytesTotal * 100);
            stageLabel.textContent = `${filename} · ${loadedMB}/${totalMB} MB (${pct}%) @ ${speedKB} KB/s`;
          } else {
            stageLabel.textContent = `${filename} · ${loadedMB} MB @ ${speedKB} KB/s`;
          }
        } else if (stage === 'initializing_heartbeat') {
          stageLabel.textContent = `initializing WASM runtime (${s.progress.lastHeartbeatElapsed}s)…`;
        } else {
          stageLabel.textContent = humanStage;
        }
      }

      if (elapsedLabel) {
        elapsedLabel.textContent = formatElapsed(s.progress.elapsedMs);
      }

      // Determinate bar when we have Content-Length, else shimmer
      if (bar) {
        if (dl.bytesTotal > 0 && dl.bytesLoaded > 0 && !isReady) {
          const pct = Math.min(100, Math.round(dl.bytesLoaded / dl.bytesTotal * 100));
          bar.style.width = pct + '%';
          bar.style.animation = 'none';
        } else {
          bar.style.width = '100%';
          bar.style.animation = '';  // let CSS shimmer run
        }
      }

      // Warnings
      if (warningEl) {
        const elapsedS = Math.floor(s.progress.elapsedMs / 1000);
        const sinceHeartbeatS = Math.floor(s.progress.sinceHeartbeatMs / 1000);
        if (elapsedS > 120) {
          warningEl.textContent = `⚠ taking unusually long (${elapsedS}s). Check connection or try Force Reload.`;
          warningEl.style.display = '';
        } else if (elapsedS > 60) {
          warningEl.textContent = `⚠ slower than typical (${elapsedS}s). First load + mobile data can be this slow.`;
          warningEl.style.display = '';
        } else if (sinceHeartbeatS > 30 && stage && stage !== 'fetching_script') {
          warningEl.textContent = `⚠ no progress for ${sinceHeartbeatS}s. Worker may be stuck — try Force Reload.`;
          warningEl.style.display = '';
        } else {
          warningEl.style.display = 'none';
        }
      }
    }
  }

  function renderWorkerState() {
    renderPyodideState();
    const badge = $('workerStateBadge');
    const detail = $('workerStateDetail');
    if (!worker) {
      badge.textContent = 'OFF';
      badge.className = 'badge badge-off';
      detail.textContent = 'worker not running';
      $('startBtn').style.display = '';
      $('stopBtn').style.display = 'none';
      return;
    }
    const s = worker.status();
    badge.textContent = s.state.toUpperCase();
    badge.className = 'badge badge-' + s.state;
    detail.textContent = s.currentJob
      ? `processing ${s.currentJob.split('/').pop()}`
      : (s.state === 'idle' ? 'waiting for next poll' : s.state);
    $('startBtn').style.display = 'none';
    $('stopBtn').style.display = '';
  }

  function renderRecentJobs() {
    const container = $('recentJobs');
    if (recentJobs.length === 0) {
      container.innerHTML = '<div class="small">no jobs yet this session</div>';
      return;
    }
    const now = Date.now();
    container.innerHTML = recentJobs.slice(-10).reverse().map(j => {
      const stateDisplay = j.state === 'in-flight' && j.phase ? j.phase : j.state;
      let elapsedHtml = '';
      if (j.state === 'in-flight') {
        const elapsedS = Math.floor((now - j.ts) / 1000);
        const mm = Math.floor(elapsedS / 60), ss = elapsedS % 60;
        const elapsedStr = elapsedS < 60 ? `${elapsedS}s` : `${mm}m ${ss}s`;
        elapsedHtml = `<span class="job-elapsed">(${elapsedStr})</span>`;
      } else if (j.durationMs) {
        const dS = Math.floor(j.durationMs / 1000);
        elapsedHtml = `<span class="job-elapsed">(${dS}s)</span>`;
      }
      return `
      <div class="job-entry job-${j.state}">
        <span class="job-ruling">${esc(j.rulingId || '?')}</span>
        <span class="job-state">${esc(stateDisplay)} ${elapsedHtml}</span>
        <span class="job-ts">${esc(new Date(j.ts).toLocaleTimeString())}</span>
        <div class="job-detail">${esc(j.detail || '')}</div>
      </div>`;
    }).join('');
  }

  async function renderPendingQueue() {
    const container = $('pendingQueue');
    const pat = getPat();
    if (!pat) {
      container.innerHTML = '<div class="err">no GitHub PAT — connect via ../index.html first</div>';
      return;
    }
    try {
      const entries = await window.ghApi.ghDir(CFG.QUEUE_PATHS.pending, {
        pat, ...CFG.DATA_REPO,
      });
      const jobs = (Array.isArray(entries) ? entries : [])
        .filter(e => e.type === 'file' && e.name.endsWith('.json'))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (jobs.length === 0) {
        container.innerHTML = '<div class="small">queue empty</div>';
        return;
      }
      container.innerHTML = jobs.map(j => `
        <div class="queue-entry">
          <span class="queue-name">${esc(j.name)}</span>
          <span class="queue-size">${esc((j.size/1024).toFixed(1) + 'K')}</span>
        </div>
      `).join('');
    } catch (e) {
      if (String(e.message).includes('404')) {
        container.innerHTML = '<div class="small">queue dir does not exist yet (first job will create it)</div>';
      } else {
        container.innerHTML = `<div class="err">${esc(e.message)}</div>`;
      }
    }
  }

  // ═══ Actions ═════════════════════════════════════════════════════════

  async function onStartWorker() {
    const pat = getPat();
    if (!pat) {
      alert('GitHub PAT required. Connect via the main console page first.');
      return;
    }
    // API key is NOT required to start the worker. Compute-substrate jobs
    // run locally in Pyodide and need no Anthropic key. LLM-substrate jobs
    // will fail with a clear error ("No Anthropic API key available") if
    // one arrives in the queue without a key being set — at which point
    // the user can set it and the worker will retry on the next poll.

    const workerId = getOrCreateWorkerId();
    tlog('worker_start', { workerId });
    worker = window.queueWorker.startWorker({
      pat,
      dataRepo: CFG.DATA_REPO,
      paths: CFG.QUEUE_PATHS,
      apiKeyAccessor: loadApiKey,
      pollIntervalMs: CFG.POLL_INTERVAL_MS,
      workerId,
      onStateChange: (state, jobPath, detail) => {
        renderWorkerState();
        // Telemetry: every state transition becomes an event
        tlog('job_state', {
          state,
          ruling_id: detail?.ruling_id,
          mode: detail?.mode,
          lastState: detail?.lastState,
        });
        // Only push ONE entry per job, at the first transition out of polling.
        // Subsequent state transitions (dispatching, committing) mutate the
        // existing entry, not create a new one.
        if (state === 'fetching_files') {
          recentJobs.push({
            rulingId: detail?.ruling_id,
            state: 'in-flight',
            phase: 'fetching',
            ts: Date.now(),
            detail: jobPath ? jobPath.split('/').pop() : '',
          });
        } else if (state === 'dispatching' || state === 'committing') {
          // Mutate the latest in-flight entry with current phase
          const last = recentJobs[recentJobs.length - 1];
          if (last && last.state === 'in-flight') {
            last.phase = state === 'dispatching' ? (detail?.mode === 'compute' ? 'computing' : 'dispatching') : 'committing';
          }
        } else if (state === 'idle' && detail?.lastState) {
          // Record completion
          const last = recentJobs[recentJobs.length - 1];
          if (last && last.state === 'in-flight') {
            last.state = detail.lastState;
            last.detail = redact(detail.message || '');
            last.durationMs = Date.now() - last.ts;
          }
        }
        renderRecentJobs();
      },
    });

    localStorage.setItem(CFG.WORKER_ENABLED_STORAGE_KEY, '1');
    renderWorkerState();

    // Kick off a pending-queue refresh every 30s
    if (window._pendingRefresh) clearInterval(window._pendingRefresh);
    window._pendingRefresh = setInterval(renderPendingQueue, 30000);
    renderPendingQueue();
  }

  function onStopWorker() {
    tlog('worker_stop', {});
    if (worker) {
      worker.stop();
      worker = null;
    }
    localStorage.removeItem(CFG.WORKER_ENABLED_STORAGE_KEY);
    if (window._pendingRefresh) clearInterval(window._pendingRefresh);
    renderWorkerState();
  }

  async function onSetApiKey() {
    const current = loadApiKey();
    const prompt = current
      ? 'Replace existing Anthropic API key. Paste new key:'
      : 'Paste Anthropic API key (starts with sk-ant-):';
    const val = window.prompt(prompt, '');
    if (!val || !val.trim()) return;
    const key = val.trim();
    $('keyStatus').textContent = 'validating…';
    try {
      await window.anthropicApi.validateKey({ apiKey: key, model: CFG.DEFAULT_MODEL });
      saveApiKey(key);
      $('keyStatus').textContent = '✓ key valid, stored';
      $('keyStatus').className = 'ok';
      $('setKeyBtn').textContent = 'Rotate API key';
      $('clearKeyBtn').style.display = '';
    } catch (e) {
      // Show detailed error so user can debug (and file a bug if it's our fault).
      // For 400: parse the response body JSON for error.message if possible.
      let msg;
      if (e.httpStatus === 401) {
        msg = 'invalid key (401): check that key starts with sk-ant-';
      } else if (e.httpStatus === 400) {
        let detail = '';
        try {
          const parsed = JSON.parse(e.body || '{}');
          detail = parsed.error?.message || '';
        } catch (_) {
          detail = (e.body || '').slice(0, 200);
        }
        msg = `400 Bad Request: ${detail || 'check model name in config'}`;
      } else if (e.httpStatus === 429) {
        msg = '429 rate limit; try again in a minute';
      } else if (e.httpStatus) {
        msg = `HTTP ${e.httpStatus}: ${(e.body || '').slice(0, 150)}`;
      } else {
        // Network error (CORS, no connectivity, etc.)
        msg = `network: ${e.message}`;
      }
      $('keyStatus').textContent = '✗ ' + msg;
      $('keyStatus').className = 'err';
      $('keyStatus').title = msg;  // hover tooltip with full message
      console.error('[validateKey]', e);
    }
  }

  function onClearApiKey() {
    if (!confirm('Clear Anthropic API key from this browser?')) return;
    clearApiKey();
    $('keyStatus').textContent = 'no key stored';
    $('keyStatus').className = '';
    $('setKeyBtn').textContent = 'Set API key';
    $('clearKeyBtn').style.display = 'none';
    if (worker) onStopWorker();
  }

  function updateKeyStatus() {
    const key = loadApiKey();
    if (key) {
      $('keyStatus').textContent = `✓ key stored (${key.length} chars)`;
      $('keyStatus').className = 'ok';
      $('setKeyBtn').textContent = 'Rotate API key';
      $('clearKeyBtn').style.display = '';
    } else {
      $('keyStatus').textContent = 'no key stored';
      $('keyStatus').className = '';
      $('setKeyBtn').textContent = 'Set API key';
      $('clearKeyBtn').style.display = 'none';
    }
  }

  // ═══ Health checks ═══════════════════════════════════════════════════
  // Browser-capability diagnostic: runs preflight, renders results.
  // Purpose: when Pyodide hangs or fails, this tells the user EXACTLY which
  // capability is missing (CSP block vs. network vs. old browser).

  async function runHealthCheckAndRender() {
    const btn = $('healthCheckBtn');
    const summary = $('healthSummary');
    const results = $('healthResults');
    if (!btn || !summary || !results) return;

    btn.disabled = true;
    btn.textContent = 'running…';
    summary.textContent = 'checking WASM, fetch, CDN…';
    summary.className = 'small warn';
    results.style.display = 'none';

    try {
      const hc = await window.pyodideLoader.runHealthChecks();
      const passed = hc.checks.filter(c => c.ok).length;
      const total = hc.checks.length;
      summary.textContent = hc.ok
        ? `✓ ${passed}/${total} checks passed`
        : `✗ ${total - passed} failed — see details`;
      summary.className = hc.ok ? 'small ok' : 'small err';

      results.innerHTML = hc.checks.map(c => {
        const icon = c.ok ? '✓' : '✗';
        const cls = c.ok ? 'ok' : 'err';
        return `<div class="${cls}" style="margin:4px 0">
          <span style="display:inline-block;width:18px">${icon}</span>
          <span style="font-weight:bold">${esc(c.name)}</span>
          <div style="margin-left:18px; color:#8a8f98; font-size:10px">${esc(c.detail)}</div>
        </div>`;
      }).join('');
      results.style.display = '';

      tlog('health_check', {
        ok: hc.ok,
        passed, total,
        failed: hc.checks.filter(c => !c.ok).map(c => c.name),
      });
    } catch (e) {
      summary.textContent = `✗ error: ${String(e.message).slice(0, 80)}`;
      summary.className = 'small err';
      results.style.display = 'none';
      tlog('health_check_error', { err: String(e.message).slice(0, 200) });
    }
    btn.textContent = 'Re-run checks';
    btn.disabled = false;
  }

  // ═══ Feedback ════════════════════════════════════════════════════════
  // One-tap feedback that writes an event to ya-plan/events/ with full
  // runner state snapshot. PM reads next session to know what you saw.

  async function sendFeedback(tag) {
    const note = ($('fbNote').value || '').trim().slice(0, 500);
    const pat = getPat();
    if (!pat) {
      $('fbStatus').textContent = 'no GitHub PAT — connect via main console first';
      $('fbStatus').className = 'err';
      return;
    }
    $('fbStatus').textContent = 'sending…';
    $('fbStatus').className = 'warn';

    // Snapshot current state
    const pyodideState = window.pyodideLoader?.status?.() || {};
    const workerState = worker?.status?.() || { state: 'not-started' };
    const ua = navigator.userAgent.slice(0, 200);

    const now = new Date();
    const ts = now.toISOString();
    const slug = ts.replace(/[:.]/g, '').slice(0, 15) + 'Z_feedback_' + tag;
    const bodyLines = [
      '---',
      `type: runner_feedback`,
      `tag: ${tag}`,
      `ts: ${ts}`,
      `note: ${JSON.stringify(note)}`,
      `ua: ${JSON.stringify(ua)}`,
      '---',
      '',
      `# Runner feedback: ${tag}`,
      '',
      `**Note**: ${note || '(none)'}`,
      '',
      '## State snapshot',
      '',
      '### Pyodide',
      '```json',
      JSON.stringify(pyodideState, null, 2),
      '```',
      '',
      '### Worker',
      '```json',
      JSON.stringify(workerState, null, 2),
      '```',
      '',
      '### Recent jobs (this session)',
      '```json',
      JSON.stringify(recentJobs.slice(-10), null, 2),
      '```',
      '',
      '### CSP violations (last 5)',
      '```json',
      (() => {
        try {
          const v = JSON.parse(localStorage.getItem(CSP_VIOLATIONS_KEY) || '[]');
          return JSON.stringify(v.slice(-5), null, 2);
        } catch (_) { return '[]'; }
      })(),
      '```',
      '',
      '### Runner UI version',
      '```',
      document.getElementById('version')?.textContent || 'unknown',
      '```',
    ];
    const body = bodyLines.join('\n');
    const path = `events/${slug}.md`;

    try {
      await window.ghApi.ghPut(
        path, window.ghApi.toBase64(body),
        `feedback: ${tag} from runner UI`,
        { pat, ...CFG.DATA_REPO, sha: null }
      );
      tlog('feedback_sent', { tag, note_len: note.length });
      $('fbStatus').textContent = `✓ sent: ${path.split('/').pop()}`;
      $('fbStatus').className = 'ok';
      $('fbNote').value = '';
    } catch (e) {
      tlog('feedback_failed', { tag, err: String(e.message).slice(0, 200) });
      $('fbStatus').textContent = `✗ failed: ${String(e.message).slice(0, 80)}`;
      $('fbStatus').className = 'err';
    }
  }

  // ═══ Init ════════════════════════════════════════════════════════════

  function init() {
    $('setKeyBtn').addEventListener('click', onSetApiKey);
    $('clearKeyBtn').addEventListener('click', onClearApiKey);
    $('startBtn').addEventListener('click', onStartWorker);
    $('stopBtn').addEventListener('click', onStopWorker);
    $('refreshQueueBtn').addEventListener('click', renderPendingQueue);
    const wakeLockBtn = $('wakeLockToggleBtn');
    if (wakeLockBtn) wakeLockBtn.addEventListener('click', toggleWakeLock);

    // Feedback buttons
    const fbMap = { 'fb-ok': 'ok', 'fb-slow': 'slow', 'fb-broken': 'broken', 'fb-confused': 'confused' };
    for (const [id, tag] of Object.entries(fbMap)) {
      const btn = $(id);
      if (btn) btn.addEventListener('click', () => sendFeedback(tag));
    }
    const fbCopyBtn = $('fbCopyBtn');
    if (fbCopyBtn) fbCopyBtn.addEventListener('click', async () => {
      const bundle = {
        ts: new Date().toISOString(),
        version: document.getElementById('version')?.textContent || 'unknown',
        ua: navigator.userAgent,
        pyodide: window.pyodideLoader?.status?.() || null,
        worker: worker?.status?.() || { state: 'not-started' },
        recentJobs: recentJobs.slice(-10),
        cspViolations: (() => {
          try { return JSON.parse(localStorage.getItem(CSP_VIOLATIONS_KEY) || '[]').slice(-10); }
          catch { return []; }
        })(),
      };
      const text = JSON.stringify(bundle, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        fbCopyBtn.textContent = '✓ copied';
        setTimeout(() => { fbCopyBtn.textContent = '📋 Copy debug bundle'; }, 2000);
      } catch (e) {
        // Clipboard API may fail without user gesture permission; show in dialog
        prompt('Copy this debug bundle:', text.slice(0, 2000));
      }
    });

    const healthBtn = $('healthCheckBtn');
    if (healthBtn) healthBtn.addEventListener('click', runHealthCheckAndRender);
    // Auto-run health check on load so user sees it before any issue arises
    setTimeout(() => { runHealthCheckAndRender().catch(() => {}); }, 500);

    const prewarmBtn = $('pyodidePrewarmBtn');
    if (prewarmBtn) prewarmBtn.addEventListener('click', async () => {
      const startMs = Date.now();
      tlog('pyodide_prewarm_start', {});
      prewarmBtn.disabled = true;
      prewarmBtn.textContent = 'loading…';
      try {
        await window.pyodideLoader.ensurePyodide({
          onProgress: (stage) => {
            prewarmBtn.textContent = `loading: ${stage}`;
            tlog('pyodide_stage', { stage, elapsed_ms: Date.now() - startMs });
          },
        });
        prewarmBtn.textContent = '✓ loaded';
        tlog('pyodide_prewarm_ok', { ms: Date.now() - startMs });
      } catch (e) {
        prewarmBtn.textContent = `✗ ${e.message.slice(0, 30)}`;
        prewarmBtn.disabled = false;
        tlog('pyodide_prewarm_error', { ms: Date.now() - startMs, err: String(e.message).slice(0, 200) });
      }
      renderPyodideState();
    });

    const hardReloadBtn = $('hardReloadBtn');
    if (hardReloadBtn) hardReloadBtn.addEventListener('click', async () => {
      // Nuclear reload: unregister SW, delete all caches, reload page.
      try {
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      } catch (e) { console.warn('hard reload pre-cleanup error', e); }
      location.reload();
    });

    $('workerIdDisplay').textContent = getOrCreateWorkerId();
    updateKeyStatus();
    renderWorkerState();
    renderPendingQueue();
    renderWakeLockStatus();
    renderUpdateStatus();
    setupAutoUpdate();
    if (window._pyodideRender) clearInterval(window._pyodideRender);
    // Render every 1s — needed for elapsed time ticker during load
    // and for in-flight job elapsed time display
    window._pyodideRender = setInterval(() => {
      renderPyodideState();
      // Re-render recent jobs if any in-flight (updates elapsed display)
      if (recentJobs.some(j => j.state === 'in-flight')) {
        renderRecentJobs();
      }
    }, 1000);

    // Auto-start if user previously enabled (API key NOT required —
    // compute-substrate jobs can run without it)
    const autoStart = localStorage.getItem(CFG.WORKER_ENABLED_STORAGE_KEY);
    if (autoStart && getPat()) {
      onStartWorker();
    }
  }

  window.runnerUi = { init };

  // Self-bootstrap on load (inline <script> would be CSP-blocked under
  // script-src 'self'; this must live inside an external file).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
