// ya-plan console inbox v1 — PM → PWA message channel
// Polls github.com/YoAm/ya-plan/contents/inbox-pwa/ every 60s while active.
// For each new file: parse YAML, surface UI, call onMessage handler, then
// move file to inbox-pwa/_processed/ via Contents API.

const INBOX_PATH = 'inbox-pwa';
const POLL_INTERVAL_MS = 60000;

let pollTimer = null;
let onMessageCallback = null;
let getPatFn = null;

async function ghGet(path, pat) {
  const url = `https://api.github.com/repos/YoAm/ya-plan/contents/${path}?ref=main`;
  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}`);
  return await r.json();
}

async function ghPut(path, contentBase64, message, sha, pat) {
  const body = { message, content: contentBase64, branch: 'main' };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/YoAm/ya-plan/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${path} → ${r.status} ${await r.text()}`);
  return await r.json();
}

async function ghDelete(path, sha, message, pat) {
  const r = await fetch(`https://api.github.com/repos/YoAm/ya-plan/contents/${path}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, sha, branch: 'main' }),
  });
  if (!r.ok) throw new Error(`DELETE ${path} → ${r.status}`);
  return await r.json();
}

function parseFrontmatter(text) {
  // Parse YAML front matter (---\nkey: value\n...\n---\n<body>)
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) {
      let val = m[2].trim();
      if (val === 'null') val = null;
      if (val === 'true') val = true;
      if (val === 'false') val = false;
      meta[m[1]] = val;
    }
  }
  return { meta, body: match[2] };
}

async function poll() {
  const pat = getPatFn?.();
  if (!pat) return;

  try {
    const items = await ghGet(INBOX_PATH, pat);
    if (!items) return; // dir doesn't exist yet
    const files = items.filter(i => i.type === 'file' && i.name.endsWith('.md') && i.name !== 'README.md');

    if (files.length === 0) return;

    window.telemetry?.log('inbox.poll', { pending: files.length });

    for (const file of files) {
      try {
        const detail = await ghGet(`${INBOX_PATH}/${file.name}`, pat);
        if (!detail) continue;
        const text = new TextDecoder('utf-8').decode(
          Uint8Array.from(atob(detail.content.replace(/\n/g, '')), c => c.charCodeAt(0))
        );
        const parsed = parseFrontmatter(text);
        const msg = {
          filename: file.name,
          sha: detail.sha,
          meta: parsed.meta,
          body: parsed.body.trim(),
          path: file.path,
        };

        // Surface UI + call handler
        await handleMessage(msg, pat);

        // Move to _processed/
        await movePath(file, text, pat);
      } catch (e) {
        console.error('inbox message error', file.name, e);
        window.telemetry?.log('inbox.error', { filename: file.name, err: String(e.message).slice(0, 200) });
      }
    }
  } catch (e) {
    // Silent — don't spam errors if offline or transient
    console.debug('inbox poll soft-fail:', e.message);
  }
}

async function movePath(file, text, pat) {
  const newPath = `${INBOX_PATH}/_processed/${file.name}`;
  const contentBase64 = btoa(unescape(encodeURIComponent(text)));
  // Create at new path
  await ghPut(newPath, contentBase64, `inbox: process ${file.name}`, null, pat);
  // Delete from old path
  await ghDelete(file.path, file.sha, `inbox: moved ${file.name} to _processed`, pat);
  window.telemetry?.log('inbox.processed', { filename: file.name });
}

async function handleMessage(msg, pat) {
  const { meta, body, filename } = msg;
  const type = meta.type || 'notification';
  const severity = meta.severity || 'info';
  const slug = meta.slug || 'unknown';

  window.telemetry?.log('inbox.received', { slug, type, severity });

  // Auto-handled slugs first
  if (slug === 'refresh_please' && window.refresh) {
    showToast('PM requested refresh — refreshing…', 'info');
    setTimeout(() => window.refresh?.(), 500);
    return;
  }

  if (slug === 'redeploy_hint') {
    showToast('New ya-plan-console version available — tap ⟳ to reload.', 'warn');
    return;
  }

  // Default: surface as a toast/banner
  showMessageBanner(msg);
  onMessageCallback?.(msg);
}

function showToast(text, severity) {
  const toast = document.createElement('div');
  const bg = severity === 'error' ? '#dc2626' : severity === 'warn' ? '#d97706' : '#1e3a8a';
  toast.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:${bg};color:white;padding:10px 16px;border-radius:6px;z-index:2000;font-size:13px;max-width:90%;box-shadow:0 2px 8px rgba(0,0,0,0.2)`;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function showMessageBanner(msg) {
  // Persistent banner user must dismiss (for important messages)
  const existing = document.getElementById('inboxBanner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'inboxBanner';
  const bg = msg.meta.severity === 'error' ? '#fee2e2' : msg.meta.severity === 'warn' ? '#fef3c7' : '#dbeafe';
  const bd = msg.meta.severity === 'error' ? '#dc2626' : msg.meta.severity === 'warn' ? '#d97706' : '#1e3a8a';
  banner.style.cssText = `margin:10px 12px;padding:10px;border-radius:6px;background:${bg};border-left:4px solid ${bd};font-size:13px`;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';

  const title = document.createElement('strong');
  title.textContent = `📬 ${msg.meta.slug || 'Message from PM'}`;
  header.appendChild(title);

  const dismiss = document.createElement('button');
  dismiss.textContent = '×';
  dismiss.style.cssText = 'background:none;border:none;font-size:18px;cursor:pointer;color:#6b7280;padding:0 4px';
  dismiss.addEventListener('click', () => banner.remove());
  header.appendChild(dismiss);

  const bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'white-space:pre-wrap;word-wrap:break-word';
  bodyEl.textContent = msg.body;

  const meta = document.createElement('div');
  meta.style.cssText = 'margin-top:6px;font-size:11px;color:#6b7280;font-family:ui-monospace,monospace';
  meta.textContent = `${msg.meta.recorded_at || '?'} · type:${msg.meta.type || '?'}`;

  banner.appendChild(header);
  banner.appendChild(bodyEl);
  banner.appendChild(meta);

  // Insert at top of main
  const main = document.querySelector('main');
  if (main) main.insertBefore(banner, main.firstChild);
}

function startPolling(patAccessor, onMessage) {
  getPatFn = patAccessor;
  onMessageCallback = onMessage;
  stopPolling();
  // Initial poll (1s delay so dashboard loads first)
  setTimeout(() => poll(), 1000);
  pollTimer = setInterval(() => poll(), POLL_INTERVAL_MS);
  // Also poll on tab becoming visible (catches messages that arrived while hidden)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

window.inbox = { startPolling, stopPolling, pollNow: () => poll(), showToast };
