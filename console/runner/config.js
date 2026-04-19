// console/runner/config.js — consumer wiring for the runner PWA subpath.
// Plan context lives here; infra/ modules read these as arguments.

window.runnerConfig = {
  // Anthropic API key stored separately from GitHub PAT
  ANTHROPIC_KEY_STORAGE_KEY: 'anthropic_api_key_v1',

  // Worker instance identifier (generated once, stable across reloads)
  WORKER_ID_STORAGE_KEY: 'yp_worker_id_v1',

  // Default model + token settings
  DEFAULT_MODEL: 'claude-sonnet-4-20250514',
  DEFAULT_MAX_TOKENS: 8192,
  AVAILABLE_MODELS: [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-3-5-sonnet-20241022',
  ],

  // Poll cadence — 60s is conservative; 30s if you want snappier pickup
  POLL_INTERVAL_MS: 60000,

  // Data repo where queue lives (and where spawn files live, ENRPs commit to)
  DATA_REPO: { owner: 'YoAm', name: 'ya-plan', branch: 'main' },

  // Queue directory structure within DATA_REPO
  QUEUE_PATHS: {
    pending: 'spawn-queue/pending',
    claimed: 'spawn-queue/claimed',
    done: 'spawn-queue/done',
    failed: 'spawn-queue/failed',
    status: 'runner-status',
    enrp: 'enrps',
  },

  // Opt-in flag — worker only runs if user has enabled it
  WORKER_ENABLED_STORAGE_KEY: 'yp_worker_enabled_v1',
};
