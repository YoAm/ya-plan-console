// console/runner/runner-ui.js — UI dashboard for the runner tab
// Application tier: knows about plan repo paths via runnerConfig + consoleConfig.

(function () {
  'use strict';

  const CFG = window.runnerConfig;
  const CCFG = window.consoleConfig;

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

  function renderPyodideState() {
    const el = $('pyodideState');
    if (!el) return;
    if (!window.pyodideLoader) {
      el.textContent = '';
      return;
    }
    const s = window.pyodideLoader.status();
    if (s.loaded && s.packages.length > 0) {
      el.textContent = `pyodide ${s.version} · ${s.packages.join(',')}`;
    } else if (s.loaded) {
      el.textContent = `pyodide ${s.version} ready`;
    } else if (s.initialized) {
      el.textContent = 'pyodide loading…';
    } else {
      el.textContent = 'pyodide not loaded';
    }
    el.className = 'small';
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
    container.innerHTML = recentJobs.slice(-10).reverse().map(j => `
      <div class="job-entry job-${j.state}">
        <span class="job-ruling">${esc(j.rulingId || '?')}</span>
        <span class="job-state">${esc(j.state)}</span>
        <span class="job-ts">${esc(new Date(j.ts).toLocaleTimeString())}</span>
        <div class="job-detail">${esc(j.detail || '')}</div>
      </div>
    `).join('');
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
    const apiKey = loadApiKey();
    if (!apiKey) {
      alert('Anthropic API key required. Tap "Set API key" first.');
      return;
    }
    const pat = getPat();
    if (!pat) {
      alert('GitHub PAT required. Connect via the main console page first.');
      return;
    }

    const workerId = getOrCreateWorkerId();
    worker = window.queueWorker.startWorker({
      pat,
      dataRepo: CFG.DATA_REPO,
      paths: CFG.QUEUE_PATHS,
      apiKeyAccessor: loadApiKey,
      pollIntervalMs: CFG.POLL_INTERVAL_MS,
      workerId,
      onStateChange: (state, jobPath, detail) => {
        renderWorkerState();
        if (state === 'dispatching' || state === 'fetching_files') {
          recentJobs.push({
            rulingId: detail?.ruling_id,
            state: 'in-flight',
            ts: Date.now(),
            detail: jobPath ? jobPath.split('/').pop() : '',
          });
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
      const msg = e.httpStatus === 401 ? 'invalid key (401)' :
                  e.httpStatus ? `HTTP ${e.httpStatus}` : e.message;
      $('keyStatus').textContent = '✗ ' + msg;
      $('keyStatus').className = 'err';
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

  // ═══ Init ════════════════════════════════════════════════════════════

  function init() {
    $('setKeyBtn').addEventListener('click', onSetApiKey);
    $('clearKeyBtn').addEventListener('click', onClearApiKey);
    $('startBtn').addEventListener('click', onStartWorker);
    $('stopBtn').addEventListener('click', onStopWorker);
    $('refreshQueueBtn').addEventListener('click', renderPendingQueue);

    $('workerIdDisplay').textContent = getOrCreateWorkerId();
    updateKeyStatus();
    renderWorkerState();
    renderPendingQueue();
    if (window._pyodideRender) clearInterval(window._pyodideRender);
    window._pyodideRender = setInterval(renderPyodideState, 2000);

    // Auto-start if user previously enabled
    const autoStart = localStorage.getItem(CFG.WORKER_ENABLED_STORAGE_KEY);
    if (autoStart && loadApiKey() && getPat()) {
      onStartWorker();
    }
  }

  window.runnerUi = { init };
})();
