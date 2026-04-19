// ya-plan console health check v1
// Runs ~20 independent checks covering: auth, network, storage, PWA, SW,
// permissions, API limits, version freshness, and the bidirectional channels.
// Each check: { id, label, category, run() → {status, detail, fix?} }
// status: 'pass' | 'warn' | 'fail' | 'skip' | 'info'

const CHECKS = [
  // ═══ Environment ═══════════════════════════════════════════════════

  {
    id: 'env_online',
    label: 'Network online',
    category: 'Environment',
    run: async () => ({
      status: navigator.onLine ? 'pass' : 'fail',
      detail: navigator.onLine ? 'navigator.onLine = true' : 'offline — navigator.onLine = false',
      fix: navigator.onLine ? null : 'Check Wi-Fi or mobile data.',
    }),
  },

  {
    id: 'env_clock',
    label: 'Device clock near UTC',
    category: 'Environment',
    run: async () => {
      const getPat = () => localStorage.getItem('yp_pat_v1');
      const pat = getPat();
      if (!pat) return { status: 'skip', detail: 'No PAT, skipping server-time check.' };
      try {
        const r = await fetch('https://api.github.com/rate_limit', {
          headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
        });
        const dateHeader = r.headers.get('Date');
        if (!dateHeader) return { status: 'warn', detail: 'No Date header from GitHub.' };
        const serverMs = new Date(dateHeader).getTime();
        const skewMs = Math.abs(Date.now() - serverMs);
        const skewSec = Math.round(skewMs / 1000);
        if (skewSec < 60) return { status: 'pass', detail: `Clock within ${skewSec}s of GitHub.` };
        if (skewSec < 300) return { status: 'warn', detail: `Clock off by ~${skewSec}s.` };
        return {
          status: 'fail',
          detail: `Clock off by ${skewSec}s — auth can break.`,
          fix: 'Set phone clock to automatic network time.',
        };
      } catch (e) {
        return { status: 'skip', detail: `Could not fetch: ${e.message}` };
      }
    },
  },

  {
    id: 'env_standalone',
    label: 'Running as installed PWA',
    category: 'Environment',
    run: async () => {
      const standalone = window.matchMedia('(display-mode: standalone)').matches;
      return {
        status: standalone ? 'pass' : 'info',
        detail: standalone ? 'display-mode: standalone' : 'Running in browser tab. Not an error; just informational.',
        fix: standalone ? null : 'Chrome menu → Add to Home screen for app-like launcher.',
      };
    },
  },

  {
    id: 'env_lang',
    label: 'Browser language',
    category: 'Environment',
    run: async () => ({
      status: 'info',
      detail: `navigator.language = ${navigator.language}. Languages: ${navigator.languages?.join(', ') || '—'}`,
    }),
  },

  // ═══ Storage ═══════════════════════════════════════════════════════

  {
    id: 'storage_localstorage',
    label: 'localStorage works',
    category: 'Storage',
    run: async () => {
      try {
        const key = `__yp_health_${Date.now()}`;
        localStorage.setItem(key, 'x');
        const ok = localStorage.getItem(key) === 'x';
        localStorage.removeItem(key);
        return { status: ok ? 'pass' : 'fail', detail: 'read/write round-trip' };
      } catch (e) {
        return { status: 'fail', detail: e.message, fix: 'Enable site storage in Chrome settings.' };
      }
    },
  },

  {
    id: 'storage_indexeddb',
    label: 'IndexedDB works',
    category: 'Storage',
    run: async () => {
      if (!('indexedDB' in window)) return { status: 'fail', detail: 'indexedDB not available' };
      try {
        // Open telemetry DB (should already exist)
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('yp-telemetry', 1);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.onupgradeneeded = () => {
            if (!r.result.objectStoreNames.contains('events')) {
              r.result.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
            }
          };
        });
        const count = await new Promise((res, rej) => {
          const tx = db.transaction('events', 'readonly');
          const r = tx.objectStore('events').count();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        return { status: 'pass', detail: `IndexedDB open, ${count} telemetry events buffered.` };
      } catch (e) {
        return { status: 'fail', detail: e.message };
      }
    },
  },

  {
    id: 'storage_quota',
    label: 'Storage quota',
    category: 'Storage',
    run: async () => {
      if (!navigator.storage?.estimate) return { status: 'skip', detail: 'StorageManager API not available.' };
      const est = await navigator.storage.estimate();
      const pct = est.quota ? (est.usage / est.quota * 100).toFixed(2) : 'n/a';
      const mb = (est.usage / (1024 * 1024)).toFixed(2);
      const quotaMb = est.quota ? (est.quota / (1024 * 1024 * 1024)).toFixed(1) : '?';
      return {
        status: 'info',
        detail: `${mb} MB used / ${quotaMb} GB quota (${pct}%)`,
      };
    },
  },

  // ═══ Auth ══════════════════════════════════════════════════════════

  {
    id: 'auth_pat_present',
    label: 'PAT stored',
    category: 'Auth',
    run: async () => {
      const pat = localStorage.getItem('yp_pat_v1');
      if (!pat) return { status: 'fail', detail: 'No PAT. Tap Connect with a valid token.' };
      return { status: 'pass', detail: `PAT stored (length ${pat.length}).` };
    },
  },

  {
    id: 'auth_pat_format',
    label: 'PAT format',
    category: 'Auth',
    run: async () => {
      const pat = localStorage.getItem('yp_pat_v1');
      if (!pat) return { status: 'skip', detail: 'No PAT.' };
      const isFineGrained = /^github_pat_[A-Za-z0-9_]+$/.test(pat);
      const isClassic = /^ghp_[A-Za-z0-9]{30,}$/.test(pat);
      if (isFineGrained && pat.length >= 90) {
        return { status: 'pass', detail: `Fine-grained PAT, ${pat.length} chars (min 90 expected).` };
      }
      if (isClassic) {
        return { status: 'warn', detail: 'Classic PAT (broad scope). Fine-grained recommended.' };
      }
      if (/^github_pat_/.test(pat) && pat.length < 90) {
        return {
          status: 'fail',
          detail: `Fine-grained PAT is only ${pat.length} chars — expected 90+. Possibly truncated on paste.`,
          fix: 'Regenerate PAT and paste using GitHub\'s 📋 copy button, not manual select.',
        };
      }
      return { status: 'warn', detail: 'PAT format unrecognized.' };
    },
  },

  {
    id: 'auth_pat_valid',
    label: 'PAT authenticates to GitHub',
    category: 'Auth',
    run: async () => {
      const pat = localStorage.getItem('yp_pat_v1');
      if (!pat) return { status: 'skip', detail: 'No PAT.' };
      try {
        const r = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
        });
        if (r.status === 401) {
          const body = await r.text();
          return {
            status: 'fail',
            detail: `401 ${body.slice(0, 120)}`,
            fix: 'PAT invalid. Regenerate on GitHub.',
          };
        }
        if (!r.ok) return { status: 'warn', detail: `HTTP ${r.status}` };
        const user = await r.json();
        return { status: 'pass', detail: `Authenticated as ${user.login}.` };
      } catch (e) {
        return { status: 'fail', detail: `Fetch failed: ${e.message}` };
      }
    },
  },

  {
    id: 'auth_repo_access',
    label: 'PAT can read ya-plan',
    category: 'Auth',
    run: async () => {
      const pat = localStorage.getItem('yp_pat_v1');
      if (!pat) return { status: 'skip', detail: 'No PAT.' };
      try {
        const r = await fetch('https://api.github.com/repos/YoAm/ya-plan', {
          headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
        });
        if (r.status === 404) {
          return {
            status: 'fail',
            detail: '404 — PAT has no access to YoAm/ya-plan.',
            fix: 'Edit PAT on GitHub, add YoAm/ya-plan to Repository access.',
          };
        }
        if (!r.ok) return { status: 'fail', detail: `HTTP ${r.status}` };
        const info = await r.json();
        return { status: 'pass', detail: `Accessed ya-plan (${info.default_branch}, ${info.size}KB).` };
      } catch (e) {
        return { status: 'fail', detail: e.message };
      }
    },
  },

  {
    id: 'auth_write_capability',
    label: 'PAT Contents: write',
    category: 'Auth',
    run: async () => {
      const pat = localStorage.getItem('yp_pat_v1');
      if (!pat) return { status: 'skip', detail: 'No PAT.' };
      // We can't test write without actually writing, but we can check
      // permissions.admin / permissions.push / permissions.pull on the repo.
      try {
        const r = await fetch('https://api.github.com/repos/YoAm/ya-plan', {
          headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
        });
        if (!r.ok) return { status: 'skip', detail: 'Repo unreachable.' };
        const info = await r.json();
        const perms = info.permissions || {};
        if (perms.push) return { status: 'pass', detail: `push:${perms.push}, pull:${perms.pull}` };
        return {
          status: 'fail',
          detail: `No push permission: ${JSON.stringify(perms)}`,
          fix: 'Edit PAT: set Contents to Read and write.',
        };
      } catch (e) {
        return { status: 'skip', detail: e.message };
      }
    },
  },

  // ═══ API ══════════════════════════════════════════════════════════

  {
    id: 'api_rate_limit',
    label: 'GitHub API rate limit',
    category: 'API',
    run: async () => {
      const pat = localStorage.getItem('yp_pat_v1');
      if (!pat) return { status: 'skip', detail: 'No PAT.' };
      try {
        const r = await fetch('https://api.github.com/rate_limit', {
          headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
        });
        if (!r.ok) return { status: 'fail', detail: `HTTP ${r.status}` };
        const data = await r.json();
        const core = data.resources?.core || {};
        const pct = core.limit ? (core.remaining / core.limit * 100).toFixed(0) : 'n/a';
        const resetSec = core.reset ? Math.max(0, core.reset - Math.floor(Date.now() / 1000)) : 0;
        const resetMin = Math.floor(resetSec / 60);
        const status = core.remaining < 100 ? 'warn' : 'pass';
        return {
          status,
          detail: `${core.remaining}/${core.limit} remaining (${pct}%). Reset in ${resetMin}m.`,
          fix: status === 'warn' ? `Wait ${resetMin} minutes; avoid extra refreshes.` : null,
        };
      } catch (e) {
        return { status: 'fail', detail: e.message };
      }
    },
  },

  // ═══ PWA / Service Worker ═════════════════════════════════════════

  {
    id: 'sw_supported',
    label: 'Service Worker supported',
    category: 'PWA',
    run: async () => ({
      status: 'serviceWorker' in navigator ? 'pass' : 'fail',
      detail: 'serviceWorker' in navigator ? 'API available.' : 'Browser does not support Service Workers.',
    }),
  },

  {
    id: 'sw_registered',
    label: 'Service Worker active',
    category: 'PWA',
    run: async () => {
      if (!('serviceWorker' in navigator)) return { status: 'skip', detail: 'SW not supported.' };
      const regs = await navigator.serviceWorker.getRegistrations();
      if (!regs.length) return { status: 'fail', detail: 'No SW registered.', fix: 'Reload page.' };
      const r = regs[0];
      const active = r.active?.state;
      return {
        status: active === 'activated' ? 'pass' : 'warn',
        detail: `SW scope ${r.scope}, active=${active}, waiting=${r.waiting?.state || '-'}, installing=${r.installing?.state || '-'}, controller=${!!navigator.serviceWorker.controller}`,
      };
    },
  },

  {
    id: 'sw_cache_version',
    label: 'SW cache version matches',
    category: 'PWA',
    run: async () => {
      if (!('caches' in window)) return { status: 'skip', detail: 'Cache API not available.' };
      const names = await caches.keys();
      // Match current version — caller can bump this
      const expected = 'yp-console-v'; // any v{N} prefix
      const ours = names.filter(n => n.startsWith(expected));
      if (!ours.length) return { status: 'warn', detail: `No cache. Names: ${names.join(', ')}` };
      return { status: 'pass', detail: `Cache(s): ${ours.join(', ')}` };
    },
  },

  {
    id: 'pwa_version_fresh',
    label: 'Running latest deployed version',
    category: 'PWA',
    run: async () => {
      const currentVersion = document.getElementById('version')?.textContent;
      if (!currentVersion) return { status: 'skip', detail: 'No version label in DOM.' };
      const pat = localStorage.getItem('yp_pat_v1');
      if (!pat) return { status: 'info', detail: `Running ${currentVersion}. (No PAT to check freshness.)` };
      try {
        const r = await fetch('https://api.github.com/repos/YoAm/ya-plan-console/contents/index.html?ref=main', {
          headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
        });
        // public repo — try without auth if token has no ya-plan-console access
        let content = null;
        if (r.status === 404) {
          const r2 = await fetch('https://raw.githubusercontent.com/YoAm/ya-plan-console/main/index.html');
          if (r2.ok) content = await r2.text();
        } else if (r.ok) {
          const data = await r.json();
          content = new TextDecoder('utf-8').decode(
            Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0))
          );
        }
        if (!content) return { status: 'skip', detail: 'Could not fetch deployed index.html' };
        const m = content.match(/id="version">([^<]+)/);
        if (!m) return { status: 'skip', detail: 'No version tag in remote.' };
        const remote = m[1];
        if (remote === currentVersion) return { status: 'pass', detail: `You are on ${currentVersion} (latest).` };
        return {
          status: 'warn',
          detail: `You are on ${currentVersion}; latest is ${remote}.`,
          fix: 'Tap ⟳ (hard reload) to get the latest.',
        };
      } catch (e) {
        return { status: 'skip', detail: e.message };
      }
    },
  },

  // ═══ Permissions ═══════════════════════════════════════════════════

  {
    id: 'perm_clipboard',
    label: 'Clipboard API available',
    category: 'Permissions',
    run: async () => {
      if (!navigator.clipboard) return { status: 'warn', detail: 'No clipboard API. Copy buttons will fall back to select.' };
      return { status: 'pass', detail: 'navigator.clipboard available.' };
    },
  },

  {
    id: 'perm_notifications',
    label: 'Notifications permission',
    category: 'Permissions',
    run: async () => {
      if (!('Notification' in window)) return { status: 'skip', detail: 'Notifications API unavailable.' };
      return { status: 'info', detail: `Permission: ${Notification.permission}` };
    },
  },

  {
    id: 'perm_persistent_storage',
    label: 'Persistent storage',
    category: 'Permissions',
    run: async () => {
      if (!navigator.storage?.persisted) return { status: 'skip', detail: 'API unavailable.' };
      const persistent = await navigator.storage.persisted();
      return {
        status: persistent ? 'pass' : 'info',
        detail: persistent ? 'Storage is persistent (not auto-evicted).' : 'Non-persistent — browser may evict on low storage.',
      };
    },
  },

  // ═══ Messaging ════════════════════════════════════════════════════

  {
    id: 'msg_inbox_reachable',
    label: 'PM→PWA inbox reachable',
    category: 'Messaging',
    run: async () => {
      const pat = localStorage.getItem('yp_pat_v1');
      if (!pat) return { status: 'skip', detail: 'No PAT.' };
      try {
        const r = await fetch('https://api.github.com/repos/YoAm/ya-plan/contents/inbox-pwa?ref=main', {
          headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
        });
        if (r.status === 404) return { status: 'warn', detail: 'inbox-pwa/ not yet created in repo.' };
        if (!r.ok) return { status: 'fail', detail: `HTTP ${r.status}` };
        const items = await r.json();
        const files = items.filter(i => i.type === 'file' && i.name.endsWith('.md') && i.name !== 'README.md');
        return { status: 'pass', detail: `inbox-pwa/ reachable. ${files.length} pending message(s).` };
      } catch (e) {
        return { status: 'fail', detail: e.message };
      }
    },
  },

  {
    id: 'msg_events_reachable',
    label: 'PWA→PM events queue reachable',
    category: 'Messaging',
    run: async () => {
      const pat = localStorage.getItem('yp_pat_v1');
      if (!pat) return { status: 'skip', detail: 'No PAT.' };
      try {
        const r = await fetch('https://api.github.com/repos/YoAm/ya-plan/contents/events?ref=main', {
          headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
        });
        if (!r.ok) return { status: 'fail', detail: `HTTP ${r.status}` };
        const items = await r.json();
        const files = items.filter(i => i.type === 'file' && i.name.endsWith('.md') && i.name !== 'README.md');
        return { status: 'pass', detail: `events/ reachable. ${files.length} pending event(s).` };
      } catch (e) {
        return { status: 'fail', detail: e.message };
      }
    },
  },

  {
    id: 'msg_telemetry_buffer',
    label: 'Telemetry buffer',
    category: 'Messaging',
    run: async () => {
      if (!window.telemetry) return { status: 'skip', detail: 'Telemetry module not loaded.' };
      if (!window.telemetry.isEnabled()) return { status: 'info', detail: 'Opted out.' };
      try {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('yp-telemetry', 1);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const count = await new Promise((res) => {
          const tx = db.transaction('events', 'readonly');
          const r = tx.objectStore('events').count();
          r.onsuccess = () => res(r.result);
          r.onerror = () => res(-1);
        });
        const status = count > 100 ? 'warn' : 'pass';
        return {
          status,
          detail: `${count} events buffered locally.`,
          fix: status === 'warn' ? 'Tap "Flush now" in Telemetry card.' : null,
        };
      } catch (e) {
        return { status: 'skip', detail: e.message };
      }
    },
  },
];

async function runAll() {
  const results = [];
  for (const check of CHECKS) {
    const t0 = performance.now();
    try {
      const r = await check.run();
      results.push({ ...check, ...r, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      results.push({ ...check, status: 'fail', detail: `Check crashed: ${e.message}`, ms: Math.round(performance.now() - t0) });
    }
  }
  return results;
}

function renderResults(results, container) {
  container.innerHTML = '';
  const byCategory = {};
  for (const r of results) {
    (byCategory[r.category] = byCategory[r.category] || []).push(r);
  }

  // Summary at top
  const summary = document.createElement('div');
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0, info: 0 };
  results.forEach(r => counts[r.status]++);
  summary.style.cssText = 'font-size:12px;margin-bottom:12px;padding:8px;background:#f9fafb;border-radius:4px';
  summary.innerHTML = `
    <strong>Results:</strong>
    <span style="color:#059669">${counts.pass} pass</span> ·
    <span style="color:#d97706">${counts.warn} warn</span> ·
    <span style="color:#dc2626">${counts.fail} fail</span> ·
    <span style="color:#6b7280">${counts.skip} skip · ${counts.info} info</span>
  `;
  container.appendChild(summary);

  for (const [cat, items] of Object.entries(byCategory)) {
    const h = document.createElement('h3');
    h.textContent = cat;
    h.style.cssText = 'font-size:12px;color:#6b7280;text-transform:uppercase;margin:14px 0 6px 0;letter-spacing:0.05em';
    container.appendChild(h);
    for (const r of items) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:8px;margin-bottom:4px;border-left:3px solid #e5e7eb;background:#fafafa;font-size:12px';
      const color = r.status === 'pass' ? '#059669' : r.status === 'warn' ? '#d97706' : r.status === 'fail' ? '#dc2626' : '#6b7280';
      row.style.borderLeftColor = color;
      const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : r.status === 'fail' ? '✗' : r.status === 'skip' ? '—' : 'ℹ';
      row.innerHTML = `
        <div><span style="color:${color};font-weight:600">${icon}</span> <strong>${r.label}</strong> <span style="color:#9ca3af;font-size:10px">${r.ms}ms</span></div>
        <div style="color:#4b5563;margin-top:2px">${escapeHtml(r.detail || '')}</div>
        ${r.fix ? `<div style="color:${color};margin-top:4px;font-style:italic">→ ${escapeHtml(r.fix)}</div>` : ''}
      `;
      container.appendChild(row);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

window.health = { runAll, renderResults, CHECKS };
