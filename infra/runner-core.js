// infra/runner-core.js — pure processing primitives for queue-worker
// DOMAIN-BLIND per §P4.14. No I/O, no side effects, no hardcoded paths.
// All I/O orchestration lives in queue-worker.js; this module is data transforms.

(function () {
  'use strict';

  // Parse a job spec from JSON text.
  // Schema (required fields checked):
  //   {
  //     "ruling_id": "AR-027",
  //     "spawn_file": "path/to/spawn.md",
  //     "model": "claude-sonnet-4-20250514",
  //     "max_tokens": 8192,
  //     "files_to_pull": ["..."],           // optional, defaults to []
  //     "multi_file_target": { ... },       // optional
  //     "author": "worker-name-here",       // optional
  //     "created_at": "ISO timestamp"       // optional
  //   }
  //
  // Throws on parse error or missing required fields.
  function parseJob(jsonText) {
    let job;
    try {
      job = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`runner-core.parseJob: invalid JSON (${e.message})`);
    }
    const required = ['ruling_id', 'spawn_file', 'model', 'max_tokens'];
    for (const f of required) {
      if (job[f] == null) throw new Error(`runner-core.parseJob: missing required field '${f}'`);
    }
    if (!Array.isArray(job.files_to_pull)) job.files_to_pull = [];
    return job;
  }

  // Extract multi-file manifest from response text.
  // Convention: ```file:PATH ... ``` fenced blocks.
  // Enforces allowed_path_prefixes — any path not matching is a hard error.
  //
  // Returns: [{ path, content }, ...]
  function parseMultiFileManifest(text, { allowedPathPrefixes = null } = {}) {
    const results = [];
    // Regex matches ```file:PATH\nCONTENT``` blocks. Non-greedy on content.
    const regex = /```file:([^\n`]+)\n([\s\S]*?)\n```/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const path = m[1].trim();
      const content = m[2];
      if (!path) continue;
      if (allowedPathPrefixes && allowedPathPrefixes.length > 0) {
        const allowed = allowedPathPrefixes.some(p => path.startsWith(p));
        if (!allowed) {
          const err = new Error(`Path '${path}' outside allowed prefixes: ${allowedPathPrefixes.join(', ')}`);
          err.disallowedPath = path;
          throw err;
        }
      }
      results.push({ path, content });
    }
    return results;
  }

  // Build messages array for Anthropic API.
  // spawnText = the spawn prompt (from spawn_file).
  // pulledFiles = [{ path, content }, ...] — files fetched per files_to_pull.
  function buildMessages({ spawnText, pulledFiles = [] }) {
    const parts = [spawnText];
    for (const f of pulledFiles) {
      parts.push('\n\n' + '═'.repeat(64) + '\n');
      parts.push(`FILE: ${f.path}\n`);
      parts.push('═'.repeat(64) + '\n');
      parts.push(f.content);
    }
    return [{ role: 'user', content: parts.join('') }];
  }

  // Extract the ENRP envelope from response text.
  // Returns { enrpBody, meta } where enrpBody is the ENRP text to commit.
  // Falls back to raw text if envelope markers not found.
  function extractEnrp(responseText) {
    const envelopeRegex = /═{3,}\s*\n+ENRP[\s—-]+(\w+)\s+(\S+)/;
    const envMatch = responseText.match(envelopeRegex);
    if (!envMatch) {
      return { enrpBody: responseText, meta: { ruling_id: null, node_type: null } };
    }
    const [, nodeType, nodeId] = envMatch;
    const startIdx = responseText.indexOf(envMatch[0]);
    // Find end envelope "ENRP COMPLETE" and the following ═══ line
    const endMarker = /ENRP\s+COMPLETE[\s\S]*?═{3,}\s*/;
    const endMatch = responseText.slice(startIdx).match(endMarker);
    let endIdx = responseText.length;
    if (endMatch) {
      endIdx = startIdx + endMatch.index + endMatch[0].length;
    }
    return {
      enrpBody: responseText.slice(startIdx, endIdx),
      meta: {
        ruling_id: nodeId,
        node_type: nodeType,
      },
    };
  }

  // Filename generator for ENRP commits.
  // Convention: ENRP_<ruling_id>_<ISO timestamp compressed>.md
  function enrpFilename(rulingId, ts) {
    const t = ts || new Date();
    const iso = t.toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';
    return `ENRP_${rulingId}_${iso}.md`;
  }

  // JSONL line builder for status events.
  function statusLine(event, payload = {}) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload,
    });
  }

  window.runnerCore = {
    parseJob,
    parseMultiFileManifest,
    buildMessages,
    extractEnrp,
    enrpFilename,
    statusLine,
  };
})();
