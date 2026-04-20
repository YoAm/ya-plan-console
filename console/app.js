// ya-plan console v3 — minimal auth landing page (AR-037 Phase 1).
// Previous version had 7 dashboard cards (plan state, open items, commits,
// ENRPs, events, telemetry, health). Per Product Design audit 2026-04-20,
// the console is now ops-only: a landing page that authenticates the user's
// PAT and links to the runner. All plan-content cards moved out (the plan
// itself lives in retirement_plan_he_v20_7.html).

const CFG = window.consoleConfig;
let pat = null;
const $ = (id) => document.getElementById(id);

// ═══ Auth ════════════════════════════════════════════════════════════

function loadPatFromStorage() {
  pat = window.auth.loadPat({ storageKey: CFG.STORAGE_KEY });
  if (pat) {
    renderStatus(`✓ authenticated · ${CFG.REPO.owner}/${CFG.REPO.name}`);
    $('authBox').style.display = 'none';
    $('logoutBtn').style.display = '';
    $('telemetryCard').style.display = '';
    $('runnerLinkCard').style.display = '';
    window.telemetry?.log('console.auth_loaded', {});
  } else {
    renderStatus('not connected');
    $('authBox').style.display = '';
    $('logoutBtn').style.display = 'none';
    $('telemetryCard').style.display = 'none';
    $('runnerLinkCard').style.display = 'none';
  }
}

async function handleConnect() {
  const input = $('patInput');
  const val = input.value.trim();
  if (!val) return;
  renderStatus('validating PAT…');
  $('connectBtn').disabled = true;
  try {
    await window.auth.saveAuth(val, {
      storageKey: CFG.STORAGE_KEY,
      expectedRepo: { owner: CFG.REPO.owner, name: CFG.REPO.name },
    });
    input.value = '';
    loadPatFromStorage();
  } catch (e) {
    const msg = e.wrongRepo ? `✗ PAT is for ${e.got} not ${CFG.REPO.owner}/${CFG.REPO.name}`
             : e.httpStatus === 401 ? '✗ invalid PAT (401)'
             : e.httpStatus ? `✗ HTTP ${e.httpStatus}: ${String(e.body || '').slice(0, 150)}`
             : `✗ ${e.message || 'unknown error'}`;
    renderStatus(msg);
    console.error('[auth]', e);
  }
  $('connectBtn').disabled = false;
}

function logout() {
  if (!confirm('Clear PAT from this browser?')) return;
  window.auth.clearAuth({ storageKey: CFG.STORAGE_KEY });
  pat = null;
  loadPatFromStorage();
}

function renderStatus(msg) {
  $('status').textContent = msg;
}

// ═══ Hard reload ═════════════════════════════════════════════════════

async function hardReload() {
  if (!confirm('Unregister SW + clear caches + reload?')) return;
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch (e) { console.warn('hard reload pre-cleanup', e); }
  location.reload();
}

// ═══ Telemetry UI ═══════════════════════════════════════════════════

function wireTelemetryUI() {
  const toggle = $('telemetryToggle');
  const status = $('telemetryStatus');
  const flushBtn = $('telemetryFlushBtn');
  const sessionIdEl = $('telemetrySessionId');
  if (!toggle || !status || !flushBtn || !sessionIdEl) return;

  const sid = window.telemetry?.getSessionId?.();
  if (sid) sessionIdEl.textContent = sid;

  const sync = () => {
    const enabled = window.telemetry?.isEnabled?.() ?? true;
    toggle.checked = enabled;
    status.textContent = enabled ? 'enabled' : 'disabled';
  };
  sync();

  toggle.addEventListener('change', () => {
    if (toggle.checked) window.telemetry?.enable?.();
    else window.telemetry?.disable?.();
    sync();
  });

  flushBtn.addEventListener('click', async () => {
    flushBtn.disabled = true;
    flushBtn.textContent = 'flushing…';
    try {
      await window.telemetry?.flush?.(() => pat);
      flushBtn.textContent = '✓ flushed';
    } catch (e) {
      flushBtn.textContent = '✗ error';
    }
    setTimeout(() => { flushBtn.textContent = 'Flush now'; flushBtn.disabled = false; }, 1500);
  });
}

// ═══ Init ════════════════════════════════════════════════════════════

$('connectBtn').addEventListener('click', handleConnect);
$('hardReloadBtn').addEventListener('click', hardReload);
$('logoutBtn').addEventListener('click', logout);

loadPatFromStorage();
wireTelemetryUI();

// Service worker registration (one-refresh update fix from previous session)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(e => console.warn('SW register failed', e));
}

// Start telemetry auto-flush once authenticated
if (pat) {
  window.telemetry?.startAutoFlush?.(() => pat);
}
