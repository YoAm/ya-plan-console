// infra/auth.js — PAT authentication plumbing
// DOMAIN-BLIND per §P4.14. No hardcoded storage keys, no hardcoded repo targets.
// Callers supply { storageKey } and { expectedRepo: { owner, name } }.
//
// Design note: this module handles the PAT fetch-validate-store lifecycle.
// UI concerns (alerts, telemetry logs) stay in consumer space — callers wrap
// saveAuth() with their own try/catch and handle typed errors.

(function () {
  'use strict';

  function assertStorage({ storageKey }) {
    if (!storageKey) throw new Error('auth: storageKey required');
  }

  // Returns stored PAT string, or null if none present.
  function loadPat({ storageKey }) {
    assertStorage({ storageKey });
    return localStorage.getItem(storageKey);
  }

  // Validates PAT against expectedRepo via GitHub API preflight.
  // On success: stores PAT in localStorage under storageKey, returns { ok, info }.
  // On failure: throws typed error for caller to handle.
  //
  // Error types (check error properties):
  //   e.httpStatus — GitHub returned non-2xx; e.body holds response
  //   e.wrongRepo  — GitHub returned a different repo than expected; e.got holds actual
  //   (generic)    — network/DNS/etc; e.name and e.message are standard
  async function saveAuth(val, { storageKey, expectedRepo }) {
    assertStorage({ storageKey });
    if (!val) throw new Error('auth: PAT value required');
    if (!expectedRepo || !expectedRepo.owner || !expectedRepo.name) {
      throw new Error('auth: expectedRepo { owner, name } required');
    }
    const { owner, name } = expectedRepo;

    // Preflight: confirm PAT has access to expected repo
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${name}`,
      {
        headers: {
          'Authorization': `Bearer ${val}`,
          'Accept': 'application/vnd.github+json',
        },
      }
    );

    if (!r.ok) {
      const body = await r.text();
      const err = new Error(`HTTP ${r.status}`);
      err.httpStatus = r.status;
      err.body = body;
      throw err;
    }

    const info = await r.json();
    if (info.full_name !== `${owner}/${name}`) {
      const err = new Error(`Wrong repo: expected ${owner}/${name}, got ${info.full_name}`);
      err.wrongRepo = true;
      err.got = info.full_name;
      throw err;
    }

    // Preflight passed — store
    localStorage.setItem(storageKey, val);
    return { ok: true, info };
  }

  function logout({ storageKey }) {
    assertStorage({ storageKey });
    localStorage.removeItem(storageKey);
  }

  window.auth = { loadPat, saveAuth, logout };
})();
