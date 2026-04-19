// ya-plan console event composition v1
// Lets Yonti record structured events without editing markdown. Each event
// type has a schema (fields, labels, defaults). Form renders dynamically,
// composes YAML front matter + markdown body, commits to ya-plan/events/.
//
// Per Playbook §P10.8 v1 slugs:
//   harel_trigger_confirmed, reno_complete, meitav_cp_confirmation_received,
//   document_added_to_chat, close_item, other

// ═══ Event schemas ═════════════════════════════════════════════════════

const EVENT_TYPES = [
  {
    slug: 'harel_trigger_confirmed',
    label: 'Harel trigger confirmed',
    description: 'You called מזכירות and learned the collective trigger date.',
    relates_to: '147',
    type: 'real_world_event',
    fields: [
      { id: 'trigger_month', label: 'Trigger month (YYYY-MM)', type: 'month', required: true, placeholder: '2026-06', help: 'First month the collective activates.' },
      { id: 'source', label: 'Source (who told you)', type: 'text', required: true, placeholder: 'מזכירות, רותי' },
      { id: 'notes', label: 'Additional notes (optional)', type: 'textarea', required: false },
    ],
    body: (f) => `Harel collective triggers ${f.trigger_month}-01 (derived M depends on KIB_MO=M3).\n\nSource: ${f.source}.${f.notes ? '\n\nNotes: ' + f.notes : ''}`,
  },

  {
    slug: 'reno_complete',
    label: 'Renovation complete',
    description: 'Renovation is done. Record final numbers so SSOT can update.',
    relates_to: null,
    type: 'real_world_event',
    fields: [
      { id: 'completion_date', label: 'Completion date', type: 'date', required: true },
      { id: 'final_cost', label: 'Final total cost (₪)', type: 'number', required: true, placeholder: '65000' },
      { id: 'funding_source', label: 'Funded from', type: 'select', required: true, options: ['cash_buffer', 'portfolio_withdrawal', 'mixed', 'other'] },
      { id: 'notes', label: 'Notes (overruns, issues, etc.)', type: 'textarea', required: false },
    ],
    body: (f) => `Renovation complete ${f.completion_date}.\n\nFinal cost: ₪${Number(f.final_cost).toLocaleString()}.\nFunded from: ${f.funding_source}.${f.notes ? '\n\nNotes: ' + f.notes : ''}\n\nSSOT §11 #173 and engine reno capex model can update per normal PM workflow.`,
  },

  {
    slug: 'meitav_cp_confirmation_received',
    label: 'Meitav CP confirmation received',
    description: 'Meitav sent the written per-employer confirmation for CP חרטה.',
    relates_to: '145',
    type: 'real_world_event',
    fields: [
      { id: 'received_date', label: 'Received date', type: 'date', required: true },
      { id: 'reference', label: 'Reference number (if any)', type: 'text', required: false },
      { id: 'content_summary', label: 'Summary of what it confirms', type: 'textarea', required: true, placeholder: 'Per-employer eligibility confirmed for sev funds at Employer X' },
    ],
    body: (f) => `Meitav CP confirmation received ${f.received_date}.${f.reference ? '\n\nReference: ' + f.reference : ''}\n\nSummary:\n${f.content_summary}\n\nUnlocks #145 CP חרטה execution (LW-082 path).`,
  },

  {
    slug: 'document_added_to_chat',
    label: 'Document uploaded to Claude',
    description: 'You added a document to Claude chat. Tell PM what to look for.',
    relates_to: null,
    type: 'document_notification',
    fields: [
      { id: 'doc_type', label: 'Document type', type: 'select', required: true, options: ['161_form', 'insurance', 'pension', 'tax', 'bank_statement', 'payslip', 'other'] },
      { id: 'filename_hint', label: 'Filename or partial filename', type: 'text', required: false, placeholder: 'e.g. 161_Report_meitav8.pdf' },
      { id: 'what_for', label: 'What PM should do with it', type: 'textarea', required: true, placeholder: 'Cross-reference employer X sev balance against LW-084' },
    ],
    body: (f) => `Document added to Claude chat.\n\nType: ${f.doc_type}\n${f.filename_hint ? 'Filename hint: ' + f.filename_hint + '\n' : ''}\nAsk: ${f.what_for}\n\nPM: look in /mnt/project/ or /mnt/user-data/uploads/ on next session.`,
  },

  {
    slug: 'close_item',
    label: 'Close an item',
    description: 'Mark a §11 item resolved. PM will close on next session.',
    relates_to: null, // captured in form
    type: 'real_world_event',
    fields: [
      { id: 'item_id', label: 'Item id (§11 #)', type: 'text', required: true, placeholder: '147' },
      { id: 'resolution', label: 'Resolution', type: 'textarea', required: true, placeholder: 'Why this is now resolved.' },
    ],
    body: (f) => `Close §11 #${f.item_id}.\n\nResolution:\n${f.resolution}`,
    relatesResolver: (f) => f.item_id, // dynamic relates_to from form
  },

  {
    slug: 'other',
    label: 'Other event',
    description: 'Free-form event for anything not covered above.',
    relates_to: null,
    type: 'real_world_event',
    fields: [
      { id: 'title', label: 'Title', type: 'text', required: true, placeholder: 'What happened, in 6 words' },
      { id: 'body', label: 'Details', type: 'textarea', required: true, rows: 6 },
      { id: 'relates_to', label: 'Relates to §11 item (optional)', type: 'text', required: false, placeholder: 'e.g. 147' },
    ],
    body: (f) => `${f.title}\n\n${f.body}`,
    relatesResolver: (f) => f.relates_to || null,
  },
];

// ═══ YAML frontmatter composer ═════════════════════════════════════════

function yamlEscape(v) {
  if (v == null) return 'null';
  const s = String(v);
  if (/[:#\[\]\{\}\n'"]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function composeMarkdown(eventType, fieldValues) {
  const relates_to = eventType.relatesResolver ? eventType.relatesResolver(fieldValues) : eventType.relates_to;
  const meta = {
    type: eventType.type,
    event: eventType.slug,
    recorded_at: new Date().toISOString(),
    relates_to: relates_to || null,
    author: 'yonti',
  };
  const frontmatter = Object.entries(meta).map(([k, v]) => `${k}: ${yamlEscape(v)}`).join('\n');
  const body = eventType.body(fieldValues);
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

// ═══ Commit ═══════════════════════════════════════════════════════════

async function commitEvent(eventType, fieldValues, pat) {
  const now = new Date();
  const yyyymmdd = now.toISOString().slice(0, 10);
  // 4-char random suffix
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(2)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const filename = `${yyyymmdd}_${eventType.slug}_${rand}.md`;
  const path = `events/${filename}`;
  const content = composeMarkdown(eventType, fieldValues);
  const contentB64 = btoa(unescape(encodeURIComponent(content)));

  const r = await fetch(`https://api.github.com/repos/YoAm/ya-plan/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `event: ${eventType.slug}`,
      content: contentB64,
      branch: 'main',
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
  return { filename, path, commit: await r.json(), content };
}

// ═══ UI ═══════════════════════════════════════════════════════════════

function showEventModal(eventType, patAccessor, onSuccess) {
  // Remove any existing modal
  const existing = document.getElementById('eventModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'eventModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';

  const inner = document.createElement('div');
  inner.style.cssText = 'background:white;max-width:560px;width:100%;border-radius:8px;padding:16px;max-height:calc(100vh - 40px);overflow-y:auto';

  const close = document.createElement('button');
  close.textContent = '×';
  close.style.cssText = 'float:right;background:#f3f4f6;color:#111;border:none;width:32px;height:32px;border-radius:4px;font-size:20px;cursor:pointer;margin-left:8px';
  close.addEventListener('click', () => modal.remove());

  const title = document.createElement('h2');
  title.textContent = eventType.label;
  title.style.cssText = 'margin:0 0 4px 0;font-size:16px;color:#1e3a8a';

  const subtitle = document.createElement('div');
  subtitle.style.cssText = 'font-size:12px;color:#6b7280;margin-bottom:12px';
  subtitle.textContent = eventType.description;

  // Form
  const form = document.createElement('div');
  const fieldEls = {};

  for (const f of eventType.fields) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:10px';

    const label = document.createElement('label');
    label.style.cssText = 'display:block;font-size:12px;color:#374151;font-weight:600;margin-bottom:3px';
    label.textContent = f.label + (f.required ? ' *' : '');
    if (f.help) {
      const help = document.createElement('div');
      help.style.cssText = 'font-size:10px;color:#6b7280;font-weight:400;margin-bottom:3px';
      help.textContent = f.help;
      row.appendChild(label);
      row.appendChild(help);
    } else {
      row.appendChild(label);
    }

    let input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = f.rows || 3;
    } else if (f.type === 'select') {
      input = document.createElement('select');
      input.innerHTML = f.options.map(o => `<option value="${o}">${o}</option>`).join('');
    } else {
      input = document.createElement('input');
      input.type = f.type === 'month' ? 'month' : f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text';
    }
    input.id = `event_field_${f.id}`;
    input.placeholder = f.placeholder || '';
    input.style.cssText = 'width:100%;padding:8px;font-family:inherit;font-size:13px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box';

    // Smart defaults
    if (f.type === 'date' && !input.value) input.value = new Date().toISOString().slice(0, 10);

    fieldEls[f.id] = input;
    row.appendChild(input);
    form.appendChild(row);
  }

  // Preview + commit buttons
  const previewBtn = document.createElement('button');
  previewBtn.textContent = 'Preview event';
  previewBtn.style.cssText = 'padding:8px 14px;background:#1e3a8a;color:white;border:none;border-radius:4px;font-weight:600;cursor:pointer;margin-right:6px';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 14px;background:#f3f4f6;color:#111;border:none;border-radius:4px;cursor:pointer';
  cancelBtn.addEventListener('click', () => modal.remove());

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'margin-top:12px';
  buttonRow.appendChild(previewBtn);
  buttonRow.appendChild(cancelBtn);

  // Preview area (hidden until Preview clicked)
  const previewArea = document.createElement('div');
  previewArea.style.display = 'none';
  previewArea.style.marginTop = '14px';

  const previewLabel = document.createElement('label');
  previewLabel.style.cssText = 'font-size:12px;color:#374151;font-weight:600;display:block;margin-bottom:3px';
  previewLabel.textContent = 'Preview (file to be committed):';

  const previewText = document.createElement('pre');
  previewText.style.cssText = 'background:#f9fafb;padding:10px;border-radius:4px;font-family:ui-monospace,monospace;font-size:11px;white-space:pre-wrap;border:1px solid #e5e7eb;max-height:200px;overflow-y:auto';

  const commitBtn = document.createElement('button');
  commitBtn.textContent = 'Commit to ya-plan';
  commitBtn.style.cssText = 'padding:8px 14px;background:#059669;color:white;border:none;border-radius:4px;font-weight:600;cursor:pointer;margin-top:8px';

  const commitStatus = document.createElement('div');
  commitStatus.style.cssText = 'margin-top:8px;font-size:12px';

  previewArea.appendChild(previewLabel);
  previewArea.appendChild(previewText);
  previewArea.appendChild(commitBtn);
  previewArea.appendChild(commitStatus);

  previewBtn.addEventListener('click', () => {
    // Collect values
    const values = {};
    let missing = [];
    for (const f of eventType.fields) {
      const v = fieldEls[f.id].value.trim();
      if (f.required && !v) missing.push(f.label);
      values[f.id] = v;
    }
    if (missing.length) {
      alert('Missing required fields:\n- ' + missing.join('\n- '));
      return;
    }
    // Compose markdown preview
    const md = composeMarkdown(eventType, values);
    previewText.textContent = md;
    previewArea.style.display = '';
    previewArea._values = values;
    window.telemetry?.log('event.previewed', { slug: eventType.slug });
  });

  commitBtn.addEventListener('click', async () => {
    const pat = patAccessor?.();
    if (!pat) { commitStatus.textContent = '❌ Not connected.'; commitStatus.style.color = '#dc2626'; return; }
    commitBtn.disabled = true;
    commitBtn.textContent = 'Committing…';
    commitStatus.textContent = '';
    const t0 = performance.now();
    try {
      const result = await commitEvent(eventType, previewArea._values, pat);
      commitStatus.innerHTML = `✅ Committed: <a href="${result.commit.content.html_url}" target="_blank" rel="noopener" style="color:#1e3a8a">${result.filename}</a>`;
      commitStatus.style.color = '#059669';
      commitBtn.textContent = 'Committed';
      window.telemetry?.log('event.committed', {
        slug: eventType.slug,
        ms: Math.round(performance.now() - t0),
        filename: result.filename,
        sha: result.commit.commit.sha,
      });
      // Close modal after short delay, refresh dashboard
      setTimeout(() => {
        modal.remove();
        if (typeof window.refresh === 'function') window.refresh();
        onSuccess?.(result);
      }, 1500);
    } catch (e) {
      commitStatus.innerHTML = `❌ ${escapeHtml(e.message)}`;
      commitStatus.style.color = '#dc2626';
      commitBtn.disabled = false;
      commitBtn.textContent = 'Commit to ya-plan';
      window.telemetry?.log('event.commit_failed', {
        slug: eventType.slug,
        ms: Math.round(performance.now() - t0),
        err: String(e.message).slice(0, 300),
      });
    }
  });

  inner.appendChild(close);
  inner.appendChild(title);
  inner.appendChild(subtitle);
  inner.appendChild(form);
  inner.appendChild(buttonRow);
  inner.appendChild(previewArea);
  modal.appendChild(inner);
  document.body.appendChild(modal);

  // Click outside to close
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Focus first field
  const firstField = eventType.fields[0];
  if (firstField) fieldEls[firstField.id]?.focus();

  window.telemetry?.log('event.opened', { slug: eventType.slug });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══ Buttons card populator ═════════════════════════════════════════

function renderEventButtons(container, patAccessor) {
  container.innerHTML = '';
  for (const eventType of EVENT_TYPES) {
    const btn = document.createElement('button');
    btn.textContent = eventType.label;
    btn.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:6px;background:#f9fafb;color:#111;border:1px solid #e5e7eb;border-radius:4px;font-size:13px;cursor:pointer';
    btn.addEventListener('click', () => showEventModal(eventType, patAccessor));
    btn.addEventListener('mouseover', () => { btn.style.background = '#e0e7ff'; });
    btn.addEventListener('mouseout', () => { btn.style.background = '#f9fafb'; });
    container.appendChild(btn);
  }
}

window.eventsCompose = { renderEventButtons, showEventModal, EVENT_TYPES };
