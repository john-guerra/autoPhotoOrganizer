# Agent operational notes

Durable, **project-invariant** knowledge that used to live only in a per-machine
agent memory store — now checked in so it survives `git clone` and reaches CI,
teammates, and any agent (Rec 6 of `AI-CODING-REVIEW-2026-07-24.md`). Genuinely
personal/machine-specific items (real photo-folder paths, etc.) stay in the
gitignored `docs/TEST_FOLDERS.local.md`, not here.

Keep this current: when one of these facts changes, update it in the same commit.

## Testing gotchas

- **Isolate destructive index tests.** Anything that removes folders, resets, or
  materialize-moves must run against a **temp `AUTOGALLERY_HOME`**, never the real
  `~/.autogallery/`. Playwright already points `AUTOGALLERY_HOME` at `e2e/.tmp/home`
  over generated fixtures (see `playwright.config.js`), which is why `resetRatings`
  in `e2e/helpers.js` is safe by construction.
- **`e2e/albums.spec.js` is pre-existingly flaky** (~20–40% on the album-count
  precondition around line 22). Retry before assuming a regression.
- **A test that never failed proves nothing.** Revert the fix, watch the test go
  red, restore. (Also in CLAUDE.md — repeated here because it's the most-skipped
  step.)

## Dev-server & process gotchas

- **The dev server has no watch for `server/` changes.** Edits under `server/`
  need a manual `npm run dev` restart; verify a server fix with `curl` against a
  throwaway server on another port rather than assuming hot-reload.
- **`pkill -f scripts/dev.mjs` kills every worktree's dev server**, including the
  main checkout's. Stop a specific one by its listening-port PID
  (`lsof -ti :4321 | xargs kill`), not by process-name match.

## Release process

- Pushing a `v*` tag triggers `.github/workflows/release.yml` (mac/win/linux
  build → single publish job).
- **Releases are created as GitHub DRAFTS.** Publish with
  `gh release edit <tag> --draft=false` once verified — auto-update can't push a
  build until it's published.
- Stable track carries **no `-alpha` suffix** (since 2.9.0). Patch bumps for
  ongoing work; minor bump only when cutting a packaged build.

## Dependency landmines

- `@john-guerra/fisheye-nav`, `@john-guerra/d3-zoomable-axis`, `multi-auto-select`,
  and `reactive-widget-helper` are the maintainer's **own sibling repos**. Prefer
  **publish + version-bump** over `npm link`: a global `npm link` re-links ALL
  global links and causes collateral breakage across unrelated projects. The
  version + deps that matter live in the **root** `package.json`.
- **`offline-geocode-city@1.0.2` (#154) declares its own build toolchain
  (`@jsheaven/easybuild` → `typescript` ~64MB, plus `dts-bundle-generator`) as a
  runtime `dependency`, not a `devDependency` — a mistake in that package, not
  ours. electron-builder ships the whole production `node_modules` tree (the
  `build.files` allowlist only covers app source, not node_modules pruning), so
  without an exclusion every installer would carry ~64MB it never runs. Fixed by
  negation patterns in `package.json`'s `build.files`
  (`!node_modules/typescript/**`, `!node_modules/@jsheaven/**`,
  `!node_modules/dts-bundle-generator/**`) — verified safe by physically moving
  those three directories out of `node_modules` and confirming `getNearestCity()`
  still works (the package's actual runtime bundle, `dist/index.esm.js` /
  `dist/index.cjs.js`, only needs `lz-ts` and `s2-geometry`). Re-verify this the
  same way if `offline-geocode-city` is ever upgraded — a new version could ship
  a different dependency shape.

## Data-layer traps (verify before editing)

- **Feed date grouping is served by GENERATED expression indexes** that rot
  silently. Never edit the date expressions in `server/db/sort.js` without running
  `queryPlan.test.js` — a mismatch drops the index and the feed silently
  full-scans.
- **A new feed filter needs three layers or it's silently dropped:**
  `filterSpec.js` + `buildFilter` + the `parseFilterParam` allowlist in
  `server/api.js`. Verify with a throwaway API + `curl`.
- **The Library tree must load fully expanded for EVERY grouping** (including
  folder-only). This gate has regressed at least once.

## Where the deep context lives

- Invariants, Svelte/DOM traps, feed-window transactions, usability & testing
  contracts → `CLAUDE.md`.
- Prioritized tech-debt map → `docs/AUDIT-2026-07-13.md` (dated; re-verify against
  the current version before picking work) and `docs/AI-CODING-REVIEW-2026-07-24.md`.
- Backlog → GitHub Issues (`john-guerra/autoPhotoOrganizer`), not `ROADMAP.md`.
