# Security

This repo hosts a client-side dashboard. It is public by necessity (GitHub
Pages free tier). It **contains no secrets**. The real data lives in the
private `ya-plan` repo; the dashboard reads that repo via a PAT stored in the
visitor's browser localStorage.

## Threat model

| Threat | Severity | Mitigation |
|---|---|---|
| PAT phishing (fake console URL) | HIGH | Bookmark the real URL; HTTPS prevents domain spoofing |
| Malicious commit to this repo (exfil JS) | HIGH | Single-writer repo; GitHub 2FA; commit signing recommended |
| XSS via content from private ya-plan | MED | All dynamic content HTML-escaped (`esc()` in app.js); CSP defense-in-depth |
| PAT leak to ya-plan-console accidentally committed | HIGH | No PATs in this repo; GitHub push protection enabled |
| Supply-chain via CDN | N/A | No CDN dependencies; vanilla JS only |
| Rate-limit DoS of private repo | LOW | Attacker needs PAT; without PAT, reads public zero |
| Browser extension reads localStorage PAT | OUT-OF-SCOPE | User's device hygiene |

## Invariants enforced in code

- No `eval()`, no `new Function()`, no inline event handlers on dynamic content
- All GitHub-returned strings escaped via `esc()` before `innerHTML`
- All URLs rendered in anchors sanitized via `safeUrl()` — only `http(s):` allowed
- Content Security Policy restricts scripts to `'self'`, connections to `api.github.com` only
- Service Worker does NOT cache `api.github.com` responses — always network-first
- PAT never sent anywhere except `api.github.com/*` (verifiable via CSP `connect-src`)

## What's deliberately public in this repo

- Repo name: `ya-plan-console`
- Sibling private repo name: `ya-plan`
- Owner: `YoAm`
- Schema shape of `ya-plan/report_data_v110.json` (field names only, no values)
- The existence of an SSOT, events, ENRPs directory structure

None of the above is secret. Attackers still need a valid PAT to read contents
of the private repo.

## Disclosure

Found an issue? Open a private security advisory on the ya-plan-console repo.
