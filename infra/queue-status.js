// infra/queue-status.js — status.jsonl append writer
// DOMAIN-BLIND per §P4.14. All paths/repo passed by caller.
//
// v1: unbatched writes. Each append = one ghPut. Acceptable at the
// rates expected (heartbeats every 5s, events sparse). v2 can add
// batching if rate limits become a problem.

(function () {
  'use strict';

  // Open a status writer.
  //
  // Args:
  //   pat, repo     — data repo coords (passed by caller)
  //   path          — full path to status file (e.g. 'runner-status/foo.jsonl')
  //
  // Returns: { append(event, payload), close() }
  //   append(event, payload) — writes one JSONL line, returns Promise
  //   close()                — no-op for v1 (hook for v2 batched flush)
  function openStatus({ pat, repo, path }) {
    if (!pat) throw new Error('queue-status: pat required');
    if (!repo) throw new Error('queue-status: repo required');
    if (!path) throw new Error('queue-status: path required');

    let currentSha = null;      // sha of current file (null if file doesn't exist yet)
    let currentContent = '';    // current file content (to append to)
    let writeQueue = Promise.resolve();  // serialize writes to avoid races

    const initPromise = (async () => {
      try {
        const r = await fetch(
          `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${repo.branch}`,
          {
            headers: {
              'Authorization': `Bearer ${pat}`,
              'Accept': 'application/vnd.github+json',
            },
          }
        );
        if (r.ok) {
          const data = await r.json();
          currentSha = data.sha;
          if (data.content) {
            const bytes = Uint8Array.from(
              atob(data.content.replace(/\n/g, '')),
              c => c.charCodeAt(0)
            );
            currentContent = new TextDecoder('utf-8').decode(bytes);
          }
        }
        // 404 = file doesn't exist, sha stays null (create on first write)
      } catch (e) {
        // Network or parse error — log but don't fail; first write will error if problem persists
        console.warn('queue-status init:', e.message);
      }
    })();

    const append = (event, payload = {}) => {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...payload,
      });
      // Serialize: each write waits for prior write to complete
      writeQueue = writeQueue.then(async () => {
        await initPromise;
        currentContent += (currentContent.endsWith('\n') || currentContent === '' ? '' : '\n') + line + '\n';
        const contentB64 = btoa(unescape(encodeURIComponent(currentContent)));
        const body = {
          message: `status: ${event}`,
          content: contentB64,
          branch: repo.branch,
        };
        if (currentSha) body.sha = currentSha;
        const r = await fetch(
          `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${pat}`,
              'Accept': 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          }
        );
        if (!r.ok) {
          const errBody = await r.text();
          console.warn(`queue-status.append: ${r.status} ${errBody.slice(0, 200)}`);
          return;  // Don't throw — status append failure shouldn't kill the worker
        }
        const result = await r.json();
        currentSha = result.content?.sha || currentSha;
      });
      return writeQueue;
    };

    const close = () => writeQueue;  // caller awaits to flush pending

    return { append, close };
  }

  window.queueStatus = { openStatus };
})();
