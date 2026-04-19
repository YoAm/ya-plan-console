# ya-plan-console (monorepo)

Two sibling PWAs plus shared infrastructure, deployed from a single GitHub Pages site.

```
/              → landing router (this README & index.html)
/infra/        → domain-blind shared modules (gh-api, auth, telemetry, …)
/console/      → ya-plan console PWA — infrastructure operations
/viewer/       → ya-plan viewer PWA — plan dashboard (pending AR-027)
```

## Deploy URLs

- `https://yoam.github.io/ya-plan-console/` → router (two buttons)
- `https://yoam.github.io/ya-plan-console/console/` → console PWA
- `https://yoam.github.io/ya-plan-console/viewer/` → viewer PWA (404 until AR-027 lands)

## Boundary rule (§P4.14 domain-swap test)

Files under `infra/` are **domain-blind**: no hardcoded repo names, no user
identity, no storage keys, no Hebrew, no plan-specific terms. Every
plan-touching value (repo owner/name, storage key, author, paths) is passed
by the consumer as an argument. An `infra/*.js` module must work identically
if dropped into a film-production planning PWA with a different config.

Files under `console/` and (future) `viewer/` are **application tier**:
plan-specific constants live in each app's local `config.js`. Each app
imports infra modules via relative paths (`../infra/…`).

## Migration path (future)

Each subdirectory can split into its own repo via:

```
git subtree split --prefix=infra   -b infra-repo
git subtree split --prefix=console -b console-repo
git subtree split --prefix=viewer  -b viewer-repo
```

Three commits, same history preserved per subdir. No rewrite.

## History

- v2.0 (2026-04-19, AR-025) — monorepo restructure with infra/console/viewer split
- v1.7 (2026-04-19) — event composition in `events-compose.js`
- v1.6 → v1.0 — debug, telemetry, health, inbox, base console
