// ya-plan console v2 — refactored for monorepo (AR-025)
// Dashboard app consuming generic infra modules via window.ghApi and window.auth.
// Plan-specific constants live in ./config.js (window.consoleConfig).

const CFG = window.consoleConfig;  // { REPO, STORAGE_KEY, EVENTS_PATH, ... }

let pat = null;

const $ = (id) => document.getElementById(id);

// Build the repo args object every infra call needs. pat fills in at call time.
function repoArgs() {
  return { pat, owner: CFG.REPO.owner, name: CFG.REPO.name, branch: CFG.REPO.branch };
}

// HTML escape — applied to ALL content fetched from GitHub before rendering.
// Prevents XSS if SSOT descriptions, commit messages, or filenames contain HTML.
// Without this, malicious content could exfiltrate the PAT from localStorage.
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Sanitized URL for href — only allow http(s). Rejects javascript:, data:, etc.
function safeUrl(u) {
  if (typeof u !== 'string') return '#';
  if (/^https?:\/\//i.test(u)) return u;
  return '#';
}

// ═══ Auth ═══════════════════════════════════════════════════════════

function loadPatFromStorage() {
  pat = window.auth.loadPat({ storageKey: CFG.STORAGE_KEY });
  if (pat) {
    $('authBox').style.display = 'none';
    ['kpisCard', 'openItemsCard', 'commitsCard', 'enrpsCard', 'eventsCard', 'telemetryCard', 'healthCard']
      .forEach(id => $(id).style.display = '');
    $('refreshBtn').disabled = false;
    $('logoutBtn').style.display = '';
    // Start auto-flushing telemetry on every page load with a PAT
    window.telemetry?.startAutoFlush(() => pat);
    window.telemetry?.log('session.start', { v: $('version')?.textContent });
    // Start inbox polling for PM→PWA messages
    window.inbox?.startPolling(() => pat);
    // Render event composition buttons
    if (window.eventsCompose && $('eventButtons')) {
      window.eventsCompose.renderEventButtons($('eventButtons'), () => pat);
    }
    refresh();
  }
}

async function handleConnect() {
  const val = $('patInput').value.trim();
  if (!val) { alert('Paste your PAT first.'); return; }

  renderStatus('validating PAT…');
  const t0 = performance.now();
  try {
    await window.auth.saveAuth(val, {
      storageKey: CFG.STORAGE_KEY,
      expectedRepo: { owner: CFG.REPO.owner, name: CFG.REPO.name },
    });
    pat = val;
    $('patInput').value = '';
    window.telemetry?.log('saveAuth.ok', { ms: Math.round(performance.now() - t0) });
    window.telemetry?.startAutoFlush(() => pat);
    window.telemetry?.flush(() => pat).catch(() => {});
    loadPatFromStorage();
  } catch (e) {
    if (e.httpStatus) {
      window.telemetry?.log('saveAuth.rejected', {
        status: e.httpStatus,
        ms: Math.round(performance.now() - t0),
        bodyPreview: (e.body || '').slice(0, 200),
      });
      renderStatus(`PAT rejected: HTTP ${e.httpStatus}`);
      alert(`PAT validation failed.\n\nHTTP ${e.httpStatus}\n${(e.body || '').slice(0, 400)}\n\nCheck: (1) PAT has ${CFG.REPO.owner}/${CFG.REPO.name} access (2) PAT has Contents R/W permission (3) PAT not expired.`);
    } else if (e.wrongRepo) {
      window.telemetry?.log('saveAuth.wrong_repo', { got: e.got });
      alert(`Unexpected response: got ${e.got}, expected ${CFG.REPO.owner}/${CFG.REPO.name}`);
    } else {
      window.telemetry?.log('saveAuth.network_error', {
        errName: e.name,
        errMsg: String(e.message).slice(0, 200),
        ms: Math.round(performance.now() - t0),
      });
      renderStatus(`network error: ${e.message}`);
      alert(`Could not reach api.github.com.\n\n${e.name}: ${e.message}\n\nCheck: phone has internet, no VPN/firewall blocking github.com.`);
    }
  }
}

function logout() {
  if (!confirm('Clear PAT from this browser?')) return;
  window.auth.logout({ storageKey: CFG.STORAGE_KEY });
  pat = null;
  location.reload();
}

// ═══ Parsers ════════════════════════════════════════════════════════

function parseSsotOpenItems(ssot) {
  // Find §11 rows with status OPEN/HIGH/PENDING
  // Row format: |<id>|<desc>|<owner>|<status>|<body>|
  const lines = ssot.split('\n');
  const items = [];
  for (const line of lines) {
    const m = line.match(/^\|(\d+)\|([^|]+)\|([^|]+)\|([^|]+)\|/);
    if (!m) continue;
    const [, id, desc, owner, status] = m;
    const statusTrim = status.trim();
    if (/^(HIGH|OPEN|OPEN-PENDING|OPEN-PENDING-.*)$/i.test(statusTrim)) {
      items.push({
        id: id.trim(),
        desc: desc.trim(),
        owner: owner.trim(),
        status: statusTrim,
      });
    }
  }
  return items;
}

function parseReportData(jsonObj) {
  // report_data_v110.json structure — extract headline KPIs
  // We deliberately don't hardcode field names; we surface what's there.
  const kpis = [];
  if (jsonObj.mc) {
    const mc = jsonObj.mc;
    if (mc.p50 != null) kpis.push({ label: 'P50 terminal', value: '₪' + Math.round(mc.p50/1000) + 'K', sub: '60K paths' });
    if (mc.p5 != null) kpis.push({ label: 'P5 terminal', value: '₪' + Math.round(mc.p5/1000) + 'K', sub: '5th percentile' });
    if (mc.p_fail != null) kpis.push({ label: 'P(fail)', value: (mc.p_fail * 100).toFixed(2) + '%' });
    if (mc.p_stress != null) kpis.push({ label: 'P(stress)', value: (mc.p_stress * 100).toFixed(2) + '%' });
    if (mc.cg_mean != null) kpis.push({ label: 'CG mean', value: '₪' + Math.round(mc.cg_mean) });
    if (mc.shifts_mean != null) kpis.push({ label: 'Shifts mean', value: mc.shifts_mean.toFixed(3) });
  }
  if (jsonObj.floor) {
    if (jsonObj.floor.m1 != null) kpis.push({ label: 'FLOOR M1', value: '₪' + jsonObj.floor.m1.toLocaleString() });
    if (jsonObj.floor.m85 != null) kpis.push({ label: 'FLOOR M85', value: '₪' + jsonObj.floor.m85.toLocaleString() });
  }
  return kpis;
}

// ═══ Render ══════════════════════════════════════════════════════════

function renderStatus(msg) {
  $('status').textContent = msg;
}

function renderError(cardBodyId, err) {
  const msg = String(err?.message || err).slice(0, 800);
  $(cardBodyId).innerHTML = `<div class="err">${esc(msg)}</div>`;
  console.error(`[${cardBodyId}]`, err);
}

async function loadKpis() {
  try {
    const data = await window.ghApi.ghJson('report_data_v110.json', repoArgs());
    const kpis = parseReportData(data);
    if (kpis.length === 0) {
      $('kpis').innerHTML = '<div class="kpi"><div class="kpi-label">No KPIs found in report_data_v110.json</div></div>';
      return;
    }
    $('kpis').innerHTML = kpis.map(k => `
      <div class="kpi">
        <div class="kpi-label">${esc(k.label)}</div>
        <div class="kpi-value">${esc(k.value)}</div>
        ${k.sub ? `<div class="kpi-sub">${esc(k.sub)}</div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    renderError('kpis', e);
  }
}

async function loadOpenItems() {
  try {
    const ssot = await window.ghApi.ghRaw('SSOT.md', repoArgs());
    const items = parseSsotOpenItems(ssot);
    const high = items.filter(i => /HIGH/i.test(i.status));
    if (high.length === 0) {
      $('openItems').innerHTML = '<li><span style="color:#6b7280">No HIGH items. 🎉</span></li>';
      return;
    }
    $('openItems').innerHTML = high.slice(0, 20).map(i => `
      <li>
        <div>
          <strong>#${esc(i.id)}</strong> ${esc(i.desc)}
          <div class="kpi-sub">Owner: ${esc(i.owner)}</div>
        </div>
        <span class="pri pri-HIGH">HIGH</span>
      </li>
    `).join('');
  } catch (e) {
    renderError('openItems', e);
  }
}

async function loadCommits() {
  try {
    const commits = await window.ghApi.ghCommits(8, repoArgs());
    $('commits').innerHTML = commits.map(c => `
      <div class="commit">
        <span class="commit-sha">${esc(c.sha.slice(0, 7))}</span>
        ${esc(c.commit.message.split('\n')[0].slice(0, 80))}
        <div class="kpi-sub">${esc(new Date(c.commit.author.date).toLocaleString('en-IL'))}</div>
      </div>
    `).join('');
  } catch (e) {
    renderError('commits', e);
  }
}

async function loadEnrps() {
  try {
    const entries = await window.ghApi.ghDir('enrps', repoArgs());
    const md = entries.filter(e => e.name.endsWith('.md'));
    md.sort((a, b) => b.name.localeCompare(a.name)); // newest first by filename (timestamped)
    if (md.length === 0) {
      $('enrps').innerHTML = '<li><span style="color:#6b7280">No ENRPs yet.</span></li>';
      return;
    }
    $('enrps').innerHTML = md.slice(0, 5).map(e => `
      <li>
        <a href="${esc(safeUrl(e.html_url))}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:#1e3a8a">
          ${esc(e.name)}
        </a>
        <span class="kpi-sub">${esc((e.size/1024).toFixed(1) + 'K')}</span>
      </li>
    `).join('');
  } catch (e) {
    renderError('enrps', e);
  }
}

async function loadEvents() {
  try {
    const entries = await window.ghApi.ghDir('events', repoArgs());
    const pending = entries.filter(e => e.name.endsWith('.md') && e.name !== '.gitkeep' && e.type === 'file');
    if (pending.length === 0) {
      $('events').innerHTML = '<li><span style="color:#6b7280">No pending events. Queue is empty.</span></li>';
      return;
    }
    $('events').innerHTML = pending.map(e => `
      <li>
        <a href="${esc(safeUrl(e.html_url))}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:#1e3a8a">
          ${esc(e.name)}
        </a>
        <span class="kpi-sub">${esc((e.size/1024).toFixed(1) + 'K')}</span>
      </li>
    `).join('');
  } catch (e) {
    renderError('events', e);
  }
}

async function refresh() {
  renderStatus(`connecting to ${CFG.REPO.owner}/${CFG.REPO.name}…`);
  $('refreshBtn').disabled = true;
  const startedAt = Date.now();
  const results = await Promise.allSettled([loadKpis(), loadOpenItems(), loadCommits(), loadEnrps(), loadEvents()]);
  const elapsed = Date.now() - startedAt;
  const failed = results.filter(r => r.status === 'rejected').length;
  window.telemetry?.log('refresh', {
    ms: elapsed,
    failed,
    total: results.length,
    results: results.map(r => r.status),
  });
  if (failed === results.length) {
    renderStatus(`❌ all ${failed} fetches failed · check errors in cards`);
  } else if (failed > 0) {
    renderStatus(`⚠ ${failed}/${results.length} fetches failed · ${elapsed}ms · ${new Date().toLocaleTimeString('en-IL')}`);
  } else {
    renderStatus(`✓ ${CFG.REPO.owner}/${CFG.REPO.name}@${CFG.REPO.branch} · ${elapsed}ms · ${new Date().toLocaleTimeString('en-IL')}`);
  }
  $('refreshBtn').disabled = false;
}

// Expose refresh globally so inbox.js and events-compose.js can trigger it
window.refresh = refresh;

// ═══ Init ════════════════════════════════════════════════════════════

// Wire all button handlers (inline onclick= is CSP-blocked by design)
$('connectBtn').addEventListener('click', handleConnect);
$('refreshBtn').addEventListener('click', refresh);
$('hardReloadBtn').addEventListener('click', hardReload);
$('logoutBtn').addEventListener('click', logout);
$('debugBtn').addEventListener('click', () => window.debugWithAI?.showDebugModal());

// Health check button
$('runHealthBtn').addEventListener('click', async () => {
  const btn = $('runHealthBtn');
  const meta = $('healthMeta');
  const container = $('healthResults');
  btn.disabled = true;
  btn.textContent = 'Running…';
  meta.textContent = '';
  container.innerHTML = '<div style="color:#6b7280">Running checks…</div>';
  const t0 = performance.now();
  try {
    const results = await window.health.runAll();
    const elapsed = Math.round(performance.now() - t0);
    window.health.renderResults(results, container);
    meta.textContent = `${results.length} checks · ${elapsed}ms`;
    const counts = { pass: 0, warn: 0, fail: 0 };
    results.forEach(r => counts[r.status] !== undefined && counts[r.status]++);
    window.telemetry?.log('health.run', { pass: counts.pass, warn: counts.warn, fail: counts.fail, ms: elapsed });
  } catch (e) {
    container.innerHTML = `<div style="color:#dc2626">Health checks crashed: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-run';
  }
});

// Telemetry UI wiring
const telemetryToggle = $('telemetryToggle');
const telemetryStatus = $('telemetryStatus');
const telemetrySessionIdEl = $('telemetrySessionId');
const telemetryFlushBtn = $('telemetryFlushBtn');

if (window.telemetry) {
  telemetryToggle.checked = window.telemetry.isEnabled();
  telemetrySessionIdEl.textContent = window.telemetry.sessionId();
  telemetryStatus.textContent = window.telemetry.isEnabled() ? 'on' : 'off';
  telemetryToggle.addEventListener('change', (e) => {
    window.telemetry.setEnabled(e.target.checked);
    telemetryStatus.textContent = e.target.checked ? 'on' : 'off';
    if (!e.target.checked) window.telemetry.stopAutoFlush();
    else if (pat) window.telemetry.startAutoFlush(() => pat);
  });
  telemetryFlushBtn.addEventListener('click', async () => {
    if (!pat) { alert('Not connected.'); return; }
    telemetryFlushBtn.disabled = true;
    telemetryFlushBtn.textContent = 'Flushing…';
    try {
      const r = await window.telemetry.flush(() => pat);
      telemetryStatus.textContent = `flushed: ${JSON.stringify(r)}`;
    } catch (e) {
      telemetryStatus.textContent = `flush error: ${e.message}`;
    } finally {
      telemetryFlushBtn.disabled = false;
      telemetryFlushBtn.textContent = 'Flush now';
    }
  });
}

loadPatFromStorage();

// Register service worker for offline fallback (ignore errors gracefully)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    // Check for updates when page becomes visible
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
    // Ask SW to check for update on load too
    reg.update().catch(() => {});
  }).catch(() => {});

  // SW posts "sw-updated" after activating a new version
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'sw-updated') {
      // Show update banner if not already shown
      if (!document.getElementById('updateBanner')) {
        const banner = document.createElement('div');
        banner.id = 'updateBanner';
        banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:10px;background:#16a34a;color:white;text-align:center;font-size:13px;z-index:1000;display:flex;justify-content:center;gap:8px;align-items:center';
        const msg = document.createElement('span');
        msg.textContent = 'New version available';
        const btn = document.createElement('button');
        btn.textContent = 'Reload';
        btn.style.cssText = 'padding:4px 10px;background:white;color:#16a34a;border:none;border-radius:3px;font-weight:600;cursor:pointer';
        btn.addEventListener('click', () => location.reload());
        banner.appendChild(msg);
        banner.appendChild(btn);
        document.body.appendChild(banner);
      }
    }
    if (e.data?.type === 'sw-unregistered') {
      location.reload();
    }
  });
}

// Hard-reload: unregisters SW, clears cache, reloads. For when things are stuck.
async function hardReload() {
  if (!confirm('Hard reload? Will clear cached app code (not your PAT). Page will refresh.')) return;
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  }
  if ('caches' in window) {
    const names = await caches.keys();
    await Promise.all(names.map(n => caches.delete(n)));
  }
  location.reload();
}
