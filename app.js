// ya-plan console v1 — read-only dashboard
// Fetches state from github.com/YoAm/ya-plan via Contents REST API
// v2 will add: event composition, WebAuthn PAT encryption, Service Worker

const REPO = { owner: 'YoAm', name: 'ya-plan', branch: 'main' };
const PAT_KEY = 'yp_pat_v1';

let pat = null;

const $ = (id) => document.getElementById(id);

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

function loadPat() {
  pat = localStorage.getItem(PAT_KEY);
  if (pat) {
    $('authBox').style.display = 'none';
    ['kpisCard', 'openItemsCard', 'commitsCard', 'enrpsCard', 'eventsCard']
      .forEach(id => $(id).style.display = '');
    $('refreshBtn').disabled = false;
    $('logoutBtn').style.display = '';
    refresh();
  }
}

async function saveAuth() {
  const val = $('patInput').value.trim();
  if (!val) { alert('Paste your PAT first.'); return; }

  // Preflight: verify PAT works against ya-plan before storing
  renderStatus('validating PAT…');
  try {
    const r = await fetch(
      `https://api.github.com/repos/${REPO.owner}/${REPO.name}`,
      { headers: { 'Authorization': `Bearer ${val}`, 'Accept': 'application/vnd.github+json' } }
    );
    if (!r.ok) {
      const body = await r.text();
      renderStatus(`PAT rejected: HTTP ${r.status}`);
      alert(`PAT validation failed.\n\nHTTP ${r.status}\n${body.slice(0, 400)}\n\nCheck: (1) PAT has ${REPO.owner}/${REPO.name} access (2) PAT has Contents R/W permission (3) PAT not expired.`);
      return;
    }
    const info = await r.json();
    if (info.full_name !== `${REPO.owner}/${REPO.name}`) {
      alert(`Unexpected response: got ${info.full_name}, expected ${REPO.owner}/${REPO.name}`);
      return;
    }
  } catch (e) {
    renderStatus(`network error: ${e.message}`);
    alert(`Could not reach api.github.com.\n\n${e.name}: ${e.message}\n\nCheck: phone has internet, no VPN/firewall blocking github.com.`);
    return;
  }

  localStorage.setItem(PAT_KEY, val);
  pat = val;
  $('patInput').value = '';
  loadPat();
}

function logout() {
  if (!confirm('Clear PAT from this browser?')) return;
  localStorage.removeItem(PAT_KEY);
  pat = null;
  location.reload();
}

// ═══ GitHub API wrapper ═════════════════════════════════════════════

async function ghRaw(path) {
  // Fetch file content via Contents API (works for files up to 1MB; larger = use blobs)
  const r = await fetch(
    `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${path}?ref=${REPO.branch}`,
    { headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' } }
  );
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}: ${await r.text()}`);
  const data = await r.json();
  if (data.encoding !== 'base64') throw new Error(`Unexpected encoding: ${data.encoding}`);
  // Decode base64 → UTF-8 (handles Hebrew correctly)
  const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function ghJson(path) {
  const txt = await ghRaw(path);
  return JSON.parse(txt);
}

async function ghDir(path) {
  const r = await fetch(
    `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${path}?ref=${REPO.branch}`,
    { headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' } }
  );
  if (!r.ok) throw new Error(`GitHub ${r.status} for dir ${path}`);
  return await r.json();
}

async function ghCommits(n = 5) {
  const r = await fetch(
    `https://api.github.com/repos/${REPO.owner}/${REPO.name}/commits?sha=${REPO.branch}&per_page=${n}`,
    { headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' } }
  );
  if (!r.ok) throw new Error(`GitHub ${r.status} for commits`);
  return await r.json();
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
    const data = await ghJson('report_data_v110.json');
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
    const ssot = await ghRaw('SSOT.md');
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
    const commits = await ghCommits(8);
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
    const entries = await ghDir('enrps');
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
    const entries = await ghDir('events');
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
  renderStatus(`connecting to ${REPO.owner}/${REPO.name}…`);
  $('refreshBtn').disabled = true;
  const startedAt = Date.now();
  const results = await Promise.allSettled([loadKpis(), loadOpenItems(), loadCommits(), loadEnrps(), loadEvents()]);
  const elapsed = Date.now() - startedAt;
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed === results.length) {
    renderStatus(`❌ all ${failed} fetches failed · check errors in cards`);
  } else if (failed > 0) {
    renderStatus(`⚠ ${failed}/${results.length} fetches failed · ${elapsed}ms · ${new Date().toLocaleTimeString('en-IL')}`);
  } else {
    renderStatus(`✓ ${REPO.owner}/${REPO.name}@${REPO.branch} · ${elapsed}ms · ${new Date().toLocaleTimeString('en-IL')}`);
  }
  $('refreshBtn').disabled = false;
}

// ═══ Init ════════════════════════════════════════════════════════════

// Wire all button handlers (inline onclick= is CSP-blocked by design)
document.getElementById('connectBtn').addEventListener('click', saveAuth);
document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('hardReloadBtn').addEventListener('click', hardReload);
document.getElementById('logoutBtn').addEventListener('click', logout);

loadPat();

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
