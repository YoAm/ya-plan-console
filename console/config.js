// console/config.js — consumer wiring for ya-plan console PWA.
// This file is application tier, NOT infra. Plan-context constants are
// expected here per §P4.14. Infra modules read these values as parameters.

window.consoleConfig = {
  // Data repo the console reads/writes
  REPO: { owner: 'YoAm', name: 'ya-plan', branch: 'main' },

  // localStorage key for storing the GitHub PAT.
  // Shared between console and viewer (same origin) so one auth covers both.
  STORAGE_KEY: 'yp_pat_v1',

  // Paths within the data repo
  EVENTS_PATH: 'events/',
  TELEMETRY_PATH: 'telemetry/',
  INBOX_PATH: 'inbox/',
  ENRPS_PATH: 'enrps/',

  // UI identity
  VERSION: 'v2.0',
};
