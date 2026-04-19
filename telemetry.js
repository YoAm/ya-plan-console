// ya-plan console telemetry v1
// Goal: when something goes wrong, we know what and why, without asking user to
// reproduce. Also: light RUM (timing, errors) for self-debugging.
//
// Design choices:
// - Single-user app (n=1). No aggregation pipeline. No sampling.
// - Git IS the backend. Events commit to ya-plan/telemetry/YYYY-MM-DD.jsonl
// - IndexedDB buffer for offline robustness. Flushes when online.
// - Opt-out respected via localStorage['yp_telemetry_off'] = 'true'
// - No PII scrubbing needed (owner == user) but: never send PAT, never send
//   fetched repo body content. Only metadata (status codes, timings, paths).

const TELEMETRY_OFF_KEY = 'yp_telemetry_off';
const SESSION_ID_KEY = 'yp_session_id';
const DB_NAME = 'yp-telemetry';
const STORE = 'events';
const FLUSH_INTERVAL_MS = 30000; // 30s
const MAX_BUFFER = 200;

let sessionId = sessionStorage.getItem(SESSION_ID_KEY);
if (!sessionId) {
  // Short session id, not PII. 8 random hex chars.
  sessionId = crypto.getRandomValues(new Uint8Array(4))
    .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  sessionStorage.setItem(SESSION_ID_KEY, sessionId);
}

function isEnabled() {
  return localStorage.getItem(TELEMETRY_OFF_KEY) !== 'true';
}

// ═══ IndexedDB buffer ═══════════════════════════════════════════════

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbAdd(event) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbClearKeys(keys) {
  if (!keys.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    keys.forEach(k => store.delete(k));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ═══ Public API ═════════════════════════════════════════════════════

async function log(name, attrs = {}) {
  if (!isEnabled()) return;
  const event = {
    ts: new Date().toISOString(),
    session: sessionId,
    name,
    attrs: sanitize(attrs),
    ua: navigator.userAgent.slice(0, 120),
    online: navigator.onLine,
    v: document.getElementById('version')?.textContent || 'unknown',
  };
  console.debug('[telemetry]', name, attrs);
  try { await dbAdd(event); } catch (e) { console.warn('telemetry dbAdd failed', e); }
  // Cap buffer size
  const all = await dbAll();
  if (all.length > MAX_BUFFER) {
    const oldest = all.slice(0, all.length - MAX_BUFFER).map(e => e.id);
    await dbClearKeys(oldest);
  }
}

// Scrub attrs: never log PAT, Authorization headers, or full response bodies
function sanitize(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/^(pat|token|authorization|auth|secret|key)$/i.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    if (typeof v === 'string' && /github_pat_|ghp_|sk-ant-|Bearer /i.test(v)) {
      out[k] = '[REDACTED_CONTAINS_SECRET]';
      continue;
    }
    if (typeof v === 'string' && v.length > 500) {
      out[k] = v.slice(0, 500) + `…[+${v.length - 500} chars]`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// Wraps an async fn; logs entry + exit + timing + error
async function timed(name, attrs, fn) {
  const t0 = performance.now();
  await log(`${name}.start`, attrs);
  try {
    const result = await fn();
    await log(`${name}.ok`, { ...attrs, ms: Math.round(performance.now() - t0) });
    return result;
  } catch (e) {
    await log(`${name}.error`, {
      ...attrs,
      ms: Math.round(performance.now() - t0),
      err: String(e?.message || e).slice(0, 300),
      errName: e?.name,
    });
    throw e;
  }
}

// ═══ Flush to ya-plan/telemetry/ ════════════════════════════════════

async function flush(patAccessor) {
  if (!isEnabled()) return { skipped: 'opted-out' };
  if (!navigator.onLine) return { skipped: 'offline' };
  const events = await dbAll();
  if (!events.length) return { skipped: 'empty' };

  const pat = patAccessor?.();
  if (!pat) return { skipped: 'no-pat' };

  // Group by date (ya-plan/telemetry/YYYY-MM-DD.jsonl)
  const byDay = {};
  for (const e of events) {
    const day = e.ts.slice(0, 10);
    (byDay[day] = byDay[day] || []).push(e);
  }

  const flushed = [];
  for (const [day, eventsForDay] of Object.entries(byDay)) {
    const path = `telemetry/${day}.jsonl`;
    try {
      // Fetch existing file to append, or create new
      let existingContent = '';
      let existingSha = null;
      const getUrl = `https://api.github.com/repos/YoAm/ya-plan/contents/${path}?ref=main`;
      const getRes = await fetch(getUrl, {
        headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
      });
      if (getRes.ok) {
        const meta = await getRes.json();
        existingSha = meta.sha;
        existingContent = atob(meta.content.replace(/\n/g, ''));
      }
      // Append new events as JSONL
      const newLines = eventsForDay
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .map(e => JSON.stringify({ ts: e.ts, session: e.session, name: e.name, v: e.v, online: e.online, ua: e.ua, attrs: e.attrs }))
        .join('\n') + '\n';
      const combined = existingContent + newLines;

      const putBody = {
        message: `telemetry: +${eventsForDay.length} events ${day}`,
        content: btoa(unescape(encodeURIComponent(combined))),
        branch: 'main',
      };
      if (existingSha) putBody.sha = existingSha;

      const putRes = await fetch(`https://api.github.com/repos/YoAm/ya-plan/contents/${path}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${pat}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(putBody),
      });
      if (putRes.ok) {
        flushed.push(...eventsForDay.map(e => e.id));
      } else {
        console.warn(`telemetry flush ${day} failed`, putRes.status, await putRes.text());
      }
    } catch (e) {
      console.warn(`telemetry flush ${day} threw`, e);
    }
  }
  if (flushed.length) await dbClearKeys(flushed);
  return { flushed: flushed.length, remaining: events.length - flushed.length };
}

// ═══ Auto-flush timer ═══════════════════════════════════════════════

let flushTimer = null;
function startAutoFlush(patAccessor) {
  stopAutoFlush();
  flushTimer = setInterval(() => flush(patAccessor).catch(() => {}), FLUSH_INTERVAL_MS);
  // Flush on tab becoming hidden (user about to close)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(patAccessor).catch(() => {});
  });
}
function stopAutoFlush() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

// ═══ Global error handlers ═════════════════════════════════════════

window.addEventListener('error', (e) => {
  log('window.error', {
    msg: String(e.message).slice(0, 200),
    filename: e.filename,
    line: e.lineno,
    col: e.colno,
  }).catch(() => {});
});
window.addEventListener('unhandledrejection', (e) => {
  log('unhandledrejection', {
    reason: String(e.reason?.message || e.reason).slice(0, 200),
  }).catch(() => {});
});

// ═══ Exports ════════════════════════════════════════════════════════

window.telemetry = { log, timed, flush, startAutoFlush, stopAutoFlush, isEnabled,
  setEnabled: (v) => localStorage.setItem(TELEMETRY_OFF_KEY, v ? 'false' : 'true'),
  sessionId: () => sessionId,
};
