// ya-plan console debug module v1
// Composes a debug prompt with full context (version, state, telemetry,
// symptom) so the user can open a new AI session with one copy+paste.
//
// Why not URL prefill: claude.ai/new?q= was removed Oct 2025 due to prompt
// injection (Oasis Security). ChatGPT URL prefill works but is substrate-
// specific. Copy+paste works universally and is inherently safe (user reviews
// prompt before firing).

const REPO_PUBLIC = 'YoAm/ya-plan-console';

async function collectDebugContext(symptomText) {
  const ctx = {
    collectedAt: new Date().toISOString(),
    console: {
      version: document.getElementById('version')?.textContent || 'unknown',
      url: location.href,
      origin: location.origin,
      standalone: window.matchMedia('(display-mode: standalone)').matches,
    },
    session: {
      id: window.telemetry?.sessionId() || 'n/a',
      telemetryEnabled: window.telemetry?.isEnabled() ?? 'n/a',
      online: navigator.onLine,
      ua: navigator.userAgent,
      viewport: `${innerWidth}×${innerHeight}`,
      lang: navigator.language,
    },
    state: {
      patPresent: !!localStorage.getItem('yp_pat_v1'),
      patLength: (localStorage.getItem('yp_pat_v1') || '').length,
      telemetryOptedOut: localStorage.getItem('yp_telemetry_off') === 'true',
      statusText: document.getElementById('status')?.textContent || 'n/a',
    },
    serviceWorker: await collectSwInfo(),
    caches: await collectCacheInfo(),
    recentTelemetry: await collectRecentEvents(30),
    symptom: symptomText || '(not provided)',
  };
  return ctx;
}

async function collectSwInfo() {
  if (!('serviceWorker' in navigator)) return { supported: false };
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    return {
      supported: true,
      count: regs.length,
      states: regs.map(r => ({
        scope: r.scope,
        installing: r.installing?.state || null,
        waiting: r.waiting?.state || null,
        active: r.active?.state || null,
      })),
      controllerActive: !!navigator.serviceWorker.controller,
    };
  } catch (e) {
    return { supported: true, error: String(e.message) };
  }
}

async function collectCacheInfo() {
  if (!('caches' in window)) return { supported: false };
  try {
    const names = await caches.keys();
    const sizes = {};
    for (const n of names) {
      const cache = await caches.open(n);
      const keys = await cache.keys();
      sizes[n] = keys.length;
    }
    return { supported: true, names, entries: sizes };
  } catch (e) {
    return { supported: true, error: String(e.message) };
  }
}

async function collectRecentEvents(n) {
  if (!window.telemetry) return [];
  try {
    const db = await openTelemetryDb();
    return new Promise((resolve) => {
      const tx = db.transaction('events', 'readonly');
      const req = tx.objectStore('events').getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        resolve(all.slice(-n).map(e => ({
          ts: e.ts, name: e.name, v: e.v, online: e.online, attrs: e.attrs,
        })));
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

function openTelemetryDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('yp-telemetry', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function composePrompt(ctx) {
  return `I need help debugging my personal PWA. Please review the context below and help me figure out what's wrong.

## What this app is

"ya-plan console" — a static HTML+JS Progressive Web App that I use as a dashboard for my personal retirement-planning system. Source is public: https://github.com/${REPO_PUBLIC}

Architecture:
- Served from GitHub Pages (HTTPS origin)
- Reads/writes my private repo github.com/YoAm/ya-plan via GitHub's Contents REST API
- Auth: a fine-grained PAT the user pastes once, stored in browser localStorage
- Service Worker caches app shell for offline; API responses never cached
- Strict CSP: script-src 'self', connect-src https://api.github.com (no inline scripts)
- Telemetry module buffers events in IndexedDB, flushes to the private repo

## My symptom

${ctx.symptom}

## Current state snapshot

\`\`\`json
${JSON.stringify(ctx, null, 2)}
\`\`\`

## What I'd like from you

1. Based on the context above, what's the most likely cause of the symptom?
2. If you can narrow it to a specific file/function, point me there (source: https://github.com/${REPO_PUBLIC})
3. What quick diagnostic would confirm the hypothesis? (something I can do on my phone)
4. Suggest the smallest fix.

If you have multiple hypotheses, rank by probability. If the context isn't enough, tell me what additional signal would narrow it down.`;
}

// ═══ UI ═════════════════════════════════════════════════════════════

function showDebugModal() {
  // Lazy-create modal on first click
  let modal = document.getElementById('debugModal');
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('debugSymptom').focus();
    return;
  }
  modal = document.createElement('div');
  modal.id = 'debugModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';

  const inner = document.createElement('div');
  inner.style.cssText = 'background:white;max-width:640px;width:100%;border-radius:8px;padding:16px;max-height:calc(100vh - 40px);overflow-y:auto';

  const close = document.createElement('button');
  close.textContent = '×';
  close.style.cssText = 'float:right;background:#f3f4f6;color:#111;border:none;width:32px;height:32px;border-radius:4px;font-size:20px;cursor:pointer;margin-left:8px';
  close.addEventListener('click', () => modal.style.display = 'none');

  const title = document.createElement('h2');
  title.textContent = 'Debug with AI';
  title.style.cssText = 'margin:0 0 4px 0;font-size:16px;color:#1e3a8a';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = 'font-size:12px;color:#6b7280;margin-bottom:12px';
  subtitle.textContent = 'Describe what is happening. The app adds all the context automatically. You review the prompt before sending.';

  const symptomLabel = document.createElement('label');
  symptomLabel.textContent = 'What is happening?';
  symptomLabel.style.cssText = 'font-size:12px;color:#374151;font-weight:600;display:block;margin-bottom:4px';

  const symptomInput = document.createElement('textarea');
  symptomInput.id = 'debugSymptom';
  symptomInput.rows = 3;
  symptomInput.placeholder = 'e.g. "I pasted my PAT and tapped Connect but nothing happens"';
  symptomInput.style.cssText = 'width:100%;padding:8px;font-family:inherit;font-size:13px;border:1px solid #ccc;border-radius:4px;resize:vertical;box-sizing:border-box';

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'margin-top:12px;display:flex;gap:6px;flex-wrap:wrap';

  const composeBtn = document.createElement('button');
  composeBtn.textContent = 'Compose prompt';
  composeBtn.style.cssText = 'padding:8px 14px;background:#1e3a8a;color:white;border:none;border-radius:4px;font-weight:600;cursor:pointer';

  buttonRow.appendChild(composeBtn);

  const promptContainer = document.createElement('div');
  promptContainer.style.display = 'none';
  promptContainer.style.marginTop = '12px';

  const promptLabel = document.createElement('label');
  promptLabel.textContent = 'Prompt to send (review before firing):';
  promptLabel.style.cssText = 'font-size:12px;color:#374151;font-weight:600;display:block;margin-bottom:4px';

  const promptTextarea = document.createElement('textarea');
  promptTextarea.rows = 12;
  promptTextarea.style.cssText = 'width:100%;padding:8px;font-family:ui-monospace,monospace;font-size:11px;border:1px solid #ccc;border-radius:4px;resize:vertical;box-sizing:border-box';
  promptTextarea.readOnly = true;

  const sendRow = document.createElement('div');
  sendRow.style.cssText = 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.textContent = '📋 Copy';
  copyBtn.style.cssText = 'padding:8px 14px;background:#059669;color:white;border:none;border-radius:4px;font-weight:600;cursor:pointer';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(promptTextarea.value);
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => copyBtn.textContent = '📋 Copy', 2000);
      window.telemetry?.log('debug.copy', { promptLength: promptTextarea.value.length });
    } catch (e) {
      // Fallback: select the text
      promptTextarea.select();
      copyBtn.textContent = 'Select all — ctrl+C';
    }
  });

  // Open in Claude.ai (lands on homepage with copied prompt ready to paste)
  const claudeBtn = document.createElement('button');
  claudeBtn.textContent = 'Claude.ai';
  claudeBtn.style.cssText = 'padding:8px 14px;background:#c15f3c;color:white;border:none;border-radius:4px;font-weight:600;cursor:pointer';
  claudeBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(promptTextarea.value); } catch {}
    window.telemetry?.log('debug.open', { substrate: 'claude' });
    window.open('https://claude.ai/new', '_blank', 'noopener,noreferrer');
  });

  // Open in ChatGPT with ?q= prefill (native support as of 2024, still works)
  const chatgptBtn = document.createElement('button');
  chatgptBtn.textContent = 'ChatGPT';
  chatgptBtn.style.cssText = 'padding:8px 14px;background:#10a37f;color:white;border:none;border-radius:4px;font-weight:600;cursor:pointer';
  chatgptBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(promptTextarea.value); } catch {}
    window.telemetry?.log('debug.open', { substrate: 'chatgpt' });
    // ChatGPT URL prefill still works but has URL length limits
    // Fall back to just opening if prompt is too long
    if (promptTextarea.value.length < 1500) {
      window.open('https://chatgpt.com/?q=' + encodeURIComponent(promptTextarea.value), '_blank', 'noopener,noreferrer');
    } else {
      window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
    }
  });

  // Open in Gemini (no URL prefill)
  const geminiBtn = document.createElement('button');
  geminiBtn.textContent = 'Gemini';
  geminiBtn.style.cssText = 'padding:8px 14px;background:#1a73e8;color:white;border:none;border-radius:4px;font-weight:600;cursor:pointer';
  geminiBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(promptTextarea.value); } catch {}
    window.telemetry?.log('debug.open', { substrate: 'gemini' });
    window.open('https://gemini.google.com/app', '_blank', 'noopener,noreferrer');
  });

  sendRow.appendChild(copyBtn);
  sendRow.appendChild(claudeBtn);
  sendRow.appendChild(chatgptBtn);
  sendRow.appendChild(geminiBtn);

  const note = document.createElement('div');
  note.style.cssText = 'margin-top:8px;font-size:11px;color:#6b7280';
  note.textContent = 'Tapping a substrate copies the prompt and opens a new tab. Paste with ⌘V / ctrl+V / long-press → Paste.';

  promptContainer.appendChild(promptLabel);
  promptContainer.appendChild(promptTextarea);
  promptContainer.appendChild(sendRow);
  promptContainer.appendChild(note);

  composeBtn.addEventListener('click', async () => {
    composeBtn.disabled = true;
    composeBtn.textContent = 'Composing…';
    try {
      const ctx = await collectDebugContext(symptomInput.value.trim());
      const prompt = composePrompt(ctx);
      promptTextarea.value = prompt;
      promptContainer.style.display = '';
      window.telemetry?.log('debug.composed', { promptLength: prompt.length, hasSymptom: !!symptomInput.value.trim() });
    } catch (e) {
      alert('Failed to compose debug bundle: ' + e.message);
    } finally {
      composeBtn.disabled = false;
      composeBtn.textContent = 'Regenerate prompt';
    }
  });

  inner.appendChild(close);
  inner.appendChild(title);
  inner.appendChild(subtitle);
  inner.appendChild(symptomLabel);
  inner.appendChild(symptomInput);
  inner.appendChild(buttonRow);
  inner.appendChild(promptContainer);
  modal.appendChild(inner);
  document.body.appendChild(modal);

  // Click outside to close
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

  symptomInput.focus();
  window.telemetry?.log('debug.opened', {});
}

window.debugWithAI = { showDebugModal, collectDebugContext, composePrompt };
