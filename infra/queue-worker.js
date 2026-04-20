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
      // Create at new path — capture the new sha from the PUT response.
      // This sha is authoritative immediately (unlike ghDir listings which
      // can lag behind PUTs by several seconds due to GitHub edge caching).
      const putResp = await ghPut(toPath, contentB64, message, null);
      const newSha = putResp?.content?.sha || null;
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
      await r.json();  // consume body
      return newSha;
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
        const claimedSha = await moveJob(
          entry.path, entry.sha, claimedPath, jobText,
          `claim: ${filename} (worker ${workerId})`
        );
        return {
          job: window.runnerCore.parseJob(jobText),
          jobText,
          claimedPath,
          filename,
          claimedSha,  // authoritative sha of claimed/<filename>, from PUT response
        };
      } catch (e) {
        // 409/422 usually = someone else claimed it; swallow and continue
        console.warn('claim failed:', e.message);
        return null;
      }
    };

    // Full job processing pipeline.
    const processJob = async (claim) => {
      const { job, jobText, claimedPath, filename, claimedSha } = claim;
      const baseFilename = filename.replace(/\.json$/, '');
      const statusPath = `${paths.status}/${baseFilename}.jsonl`.replace(/\/\//g, '/');
      const status = window.queueStatus.openStatus({ pat, repo: dataRepo, path: statusPath });

      let finalState = 'done';
      let finalMessage = 'completed';
      abortController = new AbortController();

      try {
        await status.append('claimed', { worker_id: workerId, ruling_id: job.ruling_id });

        if (job.substrate === 'compute') {
          // ─── Compute substrate: Pyodide Python execution ───
          setState('fetching_files', claimedPath, { ruling_id: job.ruling_id });
          const spawnRepoUse2 = spawnRepo || dataRepo;
          // script: either inline or fetched from script_file
          let scriptText;
          if (job.script) {
            scriptText = job.script;
          } else {
            scriptText = await ghRaw(job.script_file, spawnRepoUse2);
          }
          const pulledFiles = [];
          for (const p of job.files_to_pull) {
            const text = await ghRaw(p, spawnRepoUse2);
            pulledFiles.push({ path: p, content: text });
          }
          await status.append('files_pulled', { count: pulledFiles.length + 1 });

          setState('dispatching', claimedPath, { ruling_id: job.ruling_id, mode: 'compute' });
          const packages = job.python_packages || [];
          await status.append('pyodide_init', { packages });
          const pyodide = await window.pyodideLoader.ensurePyodide({
            packages,
            onProgress: (stage, detail) => {
              status.append('pyodide_' + stage, detail || {}).catch(() => {});
            },
          });

          await status.append('compute_start', {
            script_len: scriptText.length,
            input_files: pulledFiles.length,
          });

          const result = await window.computeExecutor.runComputeJob({
            pyodide,
            script: scriptText,
            pulledFiles,
            inputVars: job.input_vars || {},
          });

          await status.append('compute_done', {
            ok: !result.error,
            duration_ms: result.durationMs,
            stdout_bytes: result.stdout.length,
            stderr_bytes: result.stderr.length,
            output_files: result.outputFiles.length,
            error_name: result.error?.name || null,
          });

          if (result.error) {
            throw new Error(`Compute script error: ${result.error.name}: ${result.error.message}`);
          }

          // Compose ENRP body from compute result (unless script emitted /output/enrp.md)
          setState('committing', claimedPath, { ruling_id: job.ruling_id });
          const scriptOwnEnrp = result.outputFiles.find(f => f.path === 'enrp.md');
          const enrpBody = scriptOwnEnrp
            ? scriptOwnEnrp.content
            : window.computeExecutor.formatComputeEnrp({
                rulingId: job.ruling_id,
                scriptName: job.script_file || '(inline)',
                result,
                packages,
              });
          const enrpName = window.runnerCore.enrpFilename(job.ruling_id);
          const enrpPath = `${paths.enrp}/${enrpName}`.replace(/\/\//g, '/');
          await ghPut(enrpPath, toBase64(enrpBody), `ENRP: ${job.ruling_id} via runner (compute)`, null);
          await status.append('enrp_committed', { path: enrpPath });

          // Commit output files to multi_file_target if configured
          if (job.multi_file_target) {
            const allowedPrefixes = job.multi_file_target.allowed_path_prefixes || [];
            const targetRepo = job.multi_file_target.repo;
            if (!targetRepo) throw new Error('multi_file_target.repo required');
            // Filter out enrp.md from output files (already committed separately)
            const filesToCommit = result.outputFiles.filter(f => f.path !== 'enrp.md');
            for (const file of filesToCommit) {
              if (allowedPrefixes.length > 0) {
                const allowed = allowedPrefixes.some(p => file.path.startsWith(p));
                if (!allowed) {
                  throw new Error(`Output path '${file.path}' outside allowed prefixes: ${allowedPrefixes.join(', ')}`);
                }
              }
              await window.ghApi.ghPut(
                file.path, toBase64(file.content),
                `${job.ruling_id}: ${file.path}`,
                { pat, ...targetRepo, sha: null }
              );
            }
            await status.append('multifile_committed', {
              count: filesToCommit.length,
              repo: `${targetRepo.owner}/${targetRepo.name}`,
            });
          }
          finalMessage = `compute ENRP ${enrpPath}`;

          // Move claimed → done. This was missing pre-2026-04-20T06Z, causing
          // every successful compute job to stay in claimed/ forever and then
          // get reaped + re-run on a 5-min loop (visible as duplicate ENRPs
          // with different timestamps for the same ruling_id). Uses claimedSha
          // from the original claim PUT — bypasses ghDir edge-cache lag.
          const computeDoneNote = {
            completed_at: new Date().toISOString(),
            worker_id: workerId,
            enrp_path: enrpPath,
            mode: 'compute',
            duration_ms: result.durationMs,
          };
          const computeDoneContent = jobText.replace(/\n*$/, '\n') +
            '\n// ' + JSON.stringify(computeDoneNote) + '\n';
          const computeDonePath = `${paths.done}/${filename}`.replace(/\/\//g, '/');
          try {
            let lastErr = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await moveJob(
                  claimedPath, claimedSha, computeDonePath, computeDoneContent,
                  `done: ${job.ruling_id}`
                );
                lastErr = null;
                break;
              } catch (me) {
                lastErr = me;
                if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt));
              }
            }
            if (lastErr) throw lastErr;
            await status.append('done', { worker_id: workerId, mode: 'compute' });
          } catch (moveErr) {
            // ENRP is already committed — job effectively succeeded. Log the
            // move failure for diagnostics; reaper will retry moving claimed/
            // back to pending/, but since ENRP exists, re-running is wasteful.
            // (Future: reaper could detect ENRP-exists and move to done/ itself.)
            await status.append('done_move_error', {
              worker_id: workerId,
              err_name: moveErr.name,
              err_message: String(moveErr.message).slice(0, 300),
              enrp_path: enrpPath,  // evidence of success for manual cleanup
            }).catch(() => {});
          }
        } else {
          // ─── LLM substrate (existing path) ───
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
          // Use claimedSha from the original claim PUT; no ghDir lookup.
          await moveJob(
            claimedPath, claimedSha, donePath, doneContent,
            `done: ${job.ruling_id}`
          );
          await status.append('done', { worker_id: workerId });
          finalMessage = `ENRP ${enrpPath}`;
        }
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
        // Move claimed → failed using claimedSha (no ghDir lookup)
        try {
          const failedPath = `${paths.failed}/${filename}`.replace(/\/\//g, '/');
          const failedContent = jobText.replace(/\n*$/, '\n') +
            '\n// failed: ' + String(e.message).slice(0, 300) + '\n';
          let lastErr = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await moveJob(
                claimedPath, claimedSha, failedPath, failedContent,
                `failed: ${job.ruling_id}`
              );
              lastErr = null;
              break;
            } catch (me) {
              lastErr = me;
              if (attempt < 3) await new Promise(r => setTimeout(r, 800 * attempt));
            }
          }
          if (lastErr) throw lastErr;
        } catch (moveErr) {
          console.warn('failed-state move failed', moveErr);
          // Record to telemetry so we see this in runner-status/. Without this
          // log, a silent move failure looks identical to 'tab closed before
          // move completed' and job stays in claimed/ forever, visible only
          // to the stale-claim reaper 10 minutes later.
          await status.append('failed_move_error', {
            worker_id: workerId,
            err_name: moveErr.name,
            err_message: String(moveErr.message).slice(0, 300),
            http_status: moveErr.httpStatus,
          }).catch(() => {});
        }
      } finally {
        await status.close().catch(() => {});
        abortController = null;
        setState('idle', null, { lastState: finalState, message: finalMessage });
      }
    };

    // Throttle poll rate when tab backgrounded. Don't stop entirely —
    // mobile Chrome keeps SW + JS alive for a while after screen off, which
    // is enough to drain a queue overnight if Wake Lock is on. If we stopped
    // polling entirely, a single hung job would strand the rest of the queue.
    let lastHiddenPoll = 0;
    const HIDDEN_POLL_INTERVAL_MS = 30000;  // 30s when tab hidden vs pollIntervalMs when visible

    const pollTick = async () => {
      if (stopped || state !== 'idle') return;
      // When tab hidden, throttle — but still poll periodically
      if (document.visibilityState === 'hidden') {
        const now = Date.now();
        if (now - lastHiddenPoll < HIDDEN_POLL_INTERVAL_MS) return;
        lastHiddenPoll = now;
      }

      setState('polling');
      try {
        const jobs = await pollPending();
        if (jobs.length === 0) {
          setState('idle');
          return;
        }
        // Try each pending job in order. If one claim fails (e.g. file
        // already exists in claimed/ from a half-complete atomic move),
        // skip to the next. Don't let one stuck job halt the whole queue.
        for (const entry of jobs) {
          if (stopped) break;
          const claim = await claimJob(entry);
          if (claim) {
            await processJob(claim);
            return;  // processed one; next tick handles the rest
          }
          // claim failed — try next job
        }
        setState('idle');
      } catch (e) {
        console.warn('poll tick error', e);
        setState('idle');
      }
    };

    // Stale-claim reaper: on worker startup, scan claimed/ for jobs with
    // no recent heartbeat and move them back to pending/ so they can be
    // re-processed. 'Recent' = last status.jsonl event within STALE_MS.
    const STALE_MS = 10 * 60 * 1000;  // 10 minutes
    const reapStaleClaims = async () => {
      try {
        const claimed = await ghDir(paths.claimed);
        if (!Array.isArray(claimed) || claimed.length === 0) return;
        const now = Date.now();
        for (const entry of claimed) {
          if (entry.type !== 'file' || !entry.name.endsWith('.json')) continue;
          // Check corresponding status.jsonl for last event timestamp
          const statusName = entry.name.replace(/\.json$/, '.jsonl');
          const statusPath = `${paths.status}/${statusName}`.replace(/\/\//g, '/');
          let lastEventMs = 0;
          try {
            const statusText = await ghRaw(statusPath, dataRepo);
            const lines = statusText.trim().split('\n').filter(Boolean);
            if (lines.length > 0) {
              const last = JSON.parse(lines[lines.length - 1]);
              if (last.ts) lastEventMs = new Date(last.ts).getTime();
            }
          } catch (_) { /* no status file = never started */ }
          if (lastEventMs > 0 && (now - lastEventMs) < STALE_MS) {
            continue;  // recent activity, not stale
          }
          // Move claimed/ → pending/
          const claimedPath = `${paths.claimed}/${entry.name}`.replace(/\/\//g, '/');
          const pendingPath = `${paths.pending}/${entry.name}`.replace(/\/\//g, '/');
          try {
            const jobText = await ghRaw(claimedPath, dataRepo);
            await moveJob(
              claimedPath, entry.sha, pendingPath, jobText,
              `reap stale claim: ${entry.name} (worker ${workerId})`
            );
            console.log('[reaper] moved stale', entry.name, 'back to pending');
          } catch (e) {
            console.warn('[reaper] failed to move', entry.name, ':', e.message);
          }
        }
      } catch (e) {
        console.warn('[reaper] scan failed:', e.message);
      }
    };

    // Reap stale claims on startup, then start polling
    setTimeout(async () => {
      try { await reapStaleClaims(); } catch (_) {}
      pollTimer = setInterval(pollTick, pollIntervalMs);
      pollTick().catch(() => {});
    }, 1000);

    // Also run the reaper periodically (every 5 min). Without this, jobs that
    // get stuck in claimed/ mid-session (crashed tab, network failure during
    // move) stay stuck until the next worker restart. Periodic reaping means
    // the queue self-heals within ~10min no matter what goes wrong.
    const REAPER_INTERVAL_MS = 5 * 60 * 1000;
    let reaperTimer = setInterval(() => {
      if (stopped) return;
      reapStaleClaims().catch(e => console.warn('periodic reap failed', e));
    }, REAPER_INTERVAL_MS);

    return {
      stop: () => {
        stopped = true;
        if (pollTimer) clearInterval(pollTimer);
        if (reaperTimer) clearInterval(reaperTimer);
        if (abortController) abortController.abort();
        setState('stopped');
      },
      status: () => ({ state, currentJob: currentJobPath, workerId }),
      pollNow: () => pollTick(),
    };
  }

  window.queueWorker = { startWorker };
})();
