// infra/queue-worker.js — queue worker main loop
// DOMAIN-BLIND per §P4.14. All paths, repo, API key passed by caller.
//
// v1 constraints (documented, not enforced mechanically):
// - single worker per tab (if you open 2 tabs, both may claim distinct jobs;
//   atomic moves via If-Match prevent double-processing same job)
// - no stale claim reaper in v1 (manual PM reap via git mv pending <- claimed)
// - no visibility-based throttling (worker keeps polling while page open)
// - polling only; no WebSocket, no SSE

(function () {
  'use strict';

  // Start a worker.
  //
  // Args:
  //   pat                     — GitHub PAT for the data repo
  //   dataRepo                — { owner, name, branch } for queue data repo
  //   paths                   — { pending, claimed, done, failed, status, enrp }
  //                             all relative to dataRepo root; status/enrp
  //                             are directories, worker appends per-job files
  //   apiKeyAccessor          — function returning current Anthropic API key
  //   pollIntervalMs          — e.g. 60000
  //   workerId                — stable identifier for this worker instance
  //   onStateChange           — (state, jobPath, detail) → void
  //   spawnRepo               — { owner, name, branch } — where spawn files live
  //                             (usually same as dataRepo, but decoupled)
  //   fetchSpawnFile          — async (spawnPath) → text. Caller provides
  //                             (uses window.ghApi internally; caller can override
  //                             for testing or custom fetch logic).
  //
  // Returns: { stop, status }
  //   stop()   — clears timer, aborts in-flight dispatch
  //   status() — { state, currentJob }
  function startWorker(opts) {
    const {
      pat, dataRepo, paths, apiKeyAccessor,
      pollIntervalMs, workerId, onStateChange,
      spawnRepo,
    } = opts;

    if (!pat) throw new Error('queue-worker: pat required');
    if (!dataRepo) throw new Error('queue-worker: dataRepo required');
    if (!paths) throw new Error('queue-worker: paths required');
    if (!apiKeyAccessor) throw new Error('queue-worker: apiKeyAccessor required');
    if (!workerId) throw new Error('queue-worker: workerId required');

    let state = 'idle';
    let currentJobPath = null;
    let abortController = null;
    let pollTimer = null;
    let stopped = false;

    const repoArgs = () => ({ pat, ...dataRepo });

    const setState = (newState, jobPath = null, detail = null) => {
      state = newState;
      currentJobPath = jobPath;
      if (onStateChange) {
        try { onStateChange(state, jobPath, detail); } catch (e) { console.warn('onStateChange threw', e); }
      }
    };

    // Fetch file text via infra/gh-api.js (must be loaded before this module).
    const ghRaw = async (path, repo) => {
      return await window.ghApi.ghRaw(path, { pat, ...repo });
    };
    const ghDir = async (path) => {
      return await window.ghApi.ghDir(path, repoArgs());
    };
    const ghPut = async (path, contentB64, message, sha) => {
      return await window.ghApi.ghPut(path, contentB64, message, { ...repoArgs(), sha });
    };
    const toBase64 = (s) => window.ghApi.toBase64(s);

    // Atomic move: delete old path, create new path with same content.
    // GitHub's PUT API doesn't support true rename; we do it as delete+put.
    // For race safety, we use If-Match sha on the delete via separate API.
    // v1: simpler — just PUT new location, then DELETE old.
    // If PUT succeeds but DELETE fails, job exists in both states briefly;
    // next poll will skip because job is already in claimed/.
    const moveJob = async (fromPath, fromSha, toPath, contentText, message) => {
      const contentB64 = toBase64(contentText);
      // Create at new path
      await ghPut(toPath, contentB64, message, null);
      // Delete old path
      const r = await fetch(
        `https://api.github.com/repos/${dataRepo.owner}/${dataRepo.name}/contents/${fromPath}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${pat}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: `remove ${fromPath}`,
            sha: fromSha,
            branch: dataRepo.branch,
          }),
        }
      );
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`DELETE ${fromPath} failed: ${r.status} ${body.slice(0, 200)}`);
      }
      return await r.json();
    };

    // Fetch the job list from pending/.
    const pollPending = async () => {
      try {
        const entries = await ghDir(paths.pending);
        const jobs = (Array.isArray(entries) ? entries : [])
          .filter(e => e.type === 'file' && e.name.endsWith('.json'))
          .sort((a, b) => a.name.localeCompare(b.name));
        return jobs;
      } catch (e) {
        if (e.message && e.message.includes('404')) return [];
        throw e;
      }
    };

    // Claim a job: read content, move to claimed/.
    // Returns { job, jobPath, fromSha, claimedPath } on success, null if lost race.
    const claimJob = async (entry) => {
      try {
        const jobText = await ghRaw(entry.path, dataRepo);
        const filename = entry.name;
        const claimedPath = `${paths.claimed}/${filename}`.replace(/\/\//g, '/');
        await moveJob(
          entry.path, entry.sha, claimedPath, jobText,
          `claim: ${filename} (worker ${workerId})`
        );
        return {
          job: window.runnerCore.parseJob(jobText),
          jobText,
          claimedPath,
          filename,
        };
      } catch (e) {
        // 409/422 usually = someone else claimed it; swallow and continue
        console.warn('claim failed:', e.message);
        return null;
      }
    };

    // Full job processing pipeline.
    const processJob = async (claim) => {
      const { job, jobText, claimedPath, filename } = claim;
      const baseFilename = filename.replace(/\.json$/, '');
      const statusPath = `${paths.status}/${baseFilename}.jsonl`.replace(/\/\//g, '/');
      const status = window.queueStatus.openStatus({ pat, repo: dataRepo, path: statusPath });

      let finalState = 'done';
      let finalMessage = 'completed';
      abortController = new AbortController();

      try {
        await status.append('claimed', { worker_id: workerId, ruling_id: job.ruling_id });

        // Fetch spawn file + files_to_pull
        setState('fetching_files', claimedPath, { ruling_id: job.ruling_id });
        const spawnRepoUse = spawnRepo || dataRepo;
        const spawnText = await ghRaw(job.spawn_file, spawnRepoUse);
        const pulledFiles = [];
        for (const p of job.files_to_pull) {
          const text = await ghRaw(p, spawnRepoUse);
          pulledFiles.push({ path: p, content: text });
        }
        await status.append('files_pulled', { count: pulledFiles.length + 1 });

        // Build payload, dispatch
        setState('dispatching', claimedPath, { ruling_id: job.ruling_id });
        const messages = window.runnerCore.buildMessages({ spawnText, pulledFiles });
        const apiKey = apiKeyAccessor();
        if (!apiKey) throw new Error('No Anthropic API key available');

        await status.append('dispatch_start', { model: job.model, max_tokens: job.max_tokens });
        const result = await window.anthropicApi.dispatch({
          apiKey,
          model: job.model,
          maxTokens: job.max_tokens,
          messages,
          signal: abortController.signal,
          onHeartbeat: (h) => status.append('heartbeat', h).catch(() => {}),
        });

        await status.append('dispatch_ok', {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          stop_reason: result.stopReason,
        });

        // Extract + commit ENRP
        setState('committing', claimedPath, { ruling_id: job.ruling_id });
        const { enrpBody, meta } = window.runnerCore.extractEnrp(result.content);
        const enrpName = window.runnerCore.enrpFilename(job.ruling_id);
        const enrpPath = `${paths.enrp}/${enrpName}`.replace(/\/\//g, '/');
        await ghPut(
          enrpPath,
          toBase64(enrpBody),
          `ENRP: ${job.ruling_id} via runner`,
          null
        );
        await status.append('enrp_committed', { path: enrpPath });

        // Parse + commit multi-file manifest if spec'd
        if (job.multi_file_target) {
          const allowedPrefixes = job.multi_file_target.allowed_path_prefixes || [];
          const targetRepo = job.multi_file_target.repo;
          if (!targetRepo) throw new Error('multi_file_target.repo required');
          const manifest = window.runnerCore.parseMultiFileManifest(result.content, {
            allowedPathPrefixes: allowedPrefixes,
          });
          for (const file of manifest) {
            await window.ghApi.ghPut(
              file.path, toBase64(file.content),
              `${job.ruling_id}: ${file.path}`,
              { pat, ...targetRepo, sha: null }
            );
          }
          await status.append('multifile_committed', {
            count: manifest.length,
            repo: `${targetRepo.owner}/${targetRepo.name}`,
          });
        }

        // Move claimed → done with result summary appended
        const resultNote = {
          completed_at: new Date().toISOString(),
          worker_id: workerId,
          enrp_path: enrpPath,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        };
        const doneContent = jobText.replace(/\n*$/, '\n') + '\n// ' + JSON.stringify(resultNote) + '\n';
        const donePath = `${paths.done}/${filename}`.replace(/\/\//g, '/');
        const claimedDir = await ghDir(paths.claimed);
        const claimedEntry = claimedDir.find(e => e.name === filename);
        if (claimedEntry) {
          await moveJob(
            claimedPath, claimedEntry.sha, donePath, doneContent,
            `done: ${job.ruling_id}`
          );
        }
        await status.append('done', { worker_id: workerId });
        finalMessage = `ENRP ${enrpPath}`;
      } catch (e) {
        console.error('processJob error', e);
        await status.append('error', {
          worker_id: workerId,
          err_name: e.name,
          err_message: String(e.message).slice(0, 500),
          http_status: e.httpStatus,
        }).catch(() => {});
        finalState = 'failed';
        finalMessage = e.message;
        // Move claimed → failed
        try {
          const claimedDir = await ghDir(paths.claimed);
          const claimedEntry = claimedDir.find(e => e.name === filename);
          if (claimedEntry) {
            const failedPath = `${paths.failed}/${filename}`.replace(/\/\//g, '/');
            const failedContent = jobText.replace(/\n*$/, '\n') +
              '\n// failed: ' + String(e.message).slice(0, 300) + '\n';
            await moveJob(
              claimedPath, claimedEntry.sha, failedPath, failedContent,
              `failed: ${job.ruling_id}`
            );
          }
        } catch (moveErr) {
          console.warn('failed-state move failed', moveErr);
        }
      } finally {
        await status.close().catch(() => {});
        abortController = null;
        setState('idle', null, { lastState: finalState, message: finalMessage });
      }
    };

    const pollTick = async () => {
      if (stopped || state !== 'idle') return;
      if (document.visibilityState === 'hidden') return;  // skip while tab hidden

      setState('polling');
      try {
        const jobs = await pollPending();
        if (jobs.length === 0) {
          setState('idle');
          return;
        }
        const claim = await claimJob(jobs[0]);
        if (!claim) {
          setState('idle');
          return;
        }
        await processJob(claim);
      } catch (e) {
        console.warn('poll tick error', e);
        setState('idle');
      }
    };

    // Start polling
    pollTimer = setInterval(pollTick, pollIntervalMs);
    // Immediate first poll after a short delay (allow UI to render)
    setTimeout(() => { pollTick().catch(() => {}); }, 1000);

    return {
      stop: () => {
        stopped = true;
        if (pollTimer) clearInterval(pollTimer);
        if (abortController) abortController.abort();
        setState('stopped');
      },
      status: () => ({ state, currentJob: currentJobPath, workerId }),
      pollNow: () => pollTick(),
    };
  }

  window.queueWorker = { startWorker };
})();
