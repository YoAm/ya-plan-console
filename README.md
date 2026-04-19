# ya-plan-console

Public stub repo hosting the browser-side dashboard for [ya-plan](https://github.com/YoAm/ya-plan) (private).

## What it is

Static HTML + vanilla JS. Opens in any browser. Reads `ya-plan` state via GitHub's
Contents REST API using a PAT stored in the browser's localStorage.

No build step. No framework. No npm. Deliberately simple.

## What's here (v1, read-only)

- Plan KPIs (P50, P5, P(fail), FLOOR) from `ya-plan/report_data_v110.json`
- Open HIGH items from `ya-plan/SSOT.md` §11
- Recent commits from `ya-plan/main`
- Recent ENRPs from `ya-plan/enrps/`
- Pending events from `ya-plan/events/`

## Roadmap (v2+)

- Event composition UI (forms → commits to `ya-plan/events/`)
- WebAuthn/biometric PAT encryption (Android fingerprint unlock)
- Offline-first via IndexedDB cache
- Cross-substrate paste-bridge (optional — fires Claude.ai prompt, commits response)

## Deployment

GitHub Pages from `main`. Visit `https://<owner>.github.io/ya-plan-console/`.

## Auth model (v1)

User pastes a GitHub PAT scoped to `ya-plan` with Contents R/W + Metadata R.
PAT is stored in browser localStorage. Single-user, single-device.

Better options (v2):
- Encrypted at rest via WebCrypto (passphrase-derived key)
- WebAuthn-wrapped key (device biometric)
- Ephemeral session-only (paste each time)

## License

Private use only. Not a general-purpose tool.
