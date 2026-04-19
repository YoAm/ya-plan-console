// infra/gh-api.js — GitHub Contents API wrapper
// DOMAIN-BLIND per §P4.14. No hardcoded repo names, no plan context.
// All callers supply { pat, owner, name, branch } explicitly.

(function () {
  'use strict';

  const API = 'https://api.github.com';

  function headers(pat) {
    return {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github+json',
    };
  }

  function assertRepo({ pat, owner, name, branch }) {
    if (!pat) throw new Error('gh-api: pat required');
    if (!owner) throw new Error('gh-api: owner required');
    if (!name) throw new Error('gh-api: name required');
    if (!branch) throw new Error('gh-api: branch required');
  }

  // Fetch file text via Contents API. Files up to 1MB.
  // Returns UTF-8 decoded string (handles non-ASCII correctly).
  async function ghRaw(path, { pat, owner, name, branch }) {
    assertRepo({ pat, owner, name, branch });
    const r = await fetch(
      `${API}/repos/${owner}/${name}/contents/${path}?ref=${branch}`,
      { headers: headers(pat) }
    );
    if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}: ${await r.text()}`);
    const data = await r.json();
    if (data.encoding !== 'base64') throw new Error(`Unexpected encoding: ${data.encoding}`);
    const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function ghJson(path, opts) {
    const txt = await ghRaw(path, opts);
    return JSON.parse(txt);
  }

  // List directory contents via Contents API.
  async function ghDir(path, { pat, owner, name, branch }) {
    assertRepo({ pat, owner, name, branch });
    const r = await fetch(
      `${API}/repos/${owner}/${name}/contents/${path}?ref=${branch}`,
      { headers: headers(pat) }
    );
    if (!r.ok) throw new Error(`GitHub ${r.status} for dir ${path}`);
    return await r.json();
  }

  // Most recent commits on branch.
  async function ghCommits(n, { pat, owner, name, branch }) {
    assertRepo({ pat, owner, name, branch });
    const r = await fetch(
      `${API}/repos/${owner}/${name}/commits?sha=${branch}&per_page=${n}`,
      { headers: headers(pat) }
    );
    if (!r.ok) throw new Error(`GitHub ${r.status} for commits`);
    return await r.json();
  }

  // Create or update a file via Contents API.
  // contentB64 must be pre-encoded (callers own unicode→base64 conversion).
  // Returns { commit, content } per GitHub API.
  async function ghPut(path, contentB64, message, { pat, owner, name, branch, sha }) {
    assertRepo({ pat, owner, name, branch });
    const body = {
      message: message || `Update ${path}`,
      content: contentB64,
      branch: branch,
    };
    if (sha) body.sha = sha;  // required for updates to existing files
    const r = await fetch(
      `${API}/repos/${owner}/${name}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          ...headers(pat),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    if (!r.ok) {
      const errBody = await r.text();
      throw new Error(`GitHub PUT ${r.status}: ${errBody.slice(0, 300)}`);
    }
    return await r.json();
  }

  // Helper: convert JS string to base64 (handling unicode).
  function toBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  window.ghApi = { ghRaw, ghJson, ghDir, ghCommits, ghPut, toBase64 };
})();
