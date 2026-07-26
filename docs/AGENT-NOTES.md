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
- **ML tests are gated twice, and both gates are deliberate.** `npm test` must
  never download a model or spawn a child, so anything needing real inference
  sits behind `ML_INTEGRATION=1`. The semantic check
  (`server/ml/embeddingSimilarity.test.js`) additionally needs real photographs,
  which cannot live in a public repo — every other image fixture in the tree is
  sharp-generated at test time. Point `AUTOGALLERY_EMBED_FIXTURES` at a local
  folder holding two near-duplicate frames and one clearly different photo:

  ```bash
  AUTOGALLERY_EMBED_FIXTURES=/path/to/folder ML_INTEGRATION=1 \
    npx vitest run server/ml/embeddingSimilarity.test.js
  ```

  Record the path in the gitignored `docs/TEST_FOLDERS.local.md`. Without it the
  test skips **loudly** (a console warning), because a silent skip on the only
  check that the vectors mean anything is indistinguishable from a pass.

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
- **electron-builder ships the whole production `node_modules` tree** — the
  `build.files` allowlist only scopes APP source, it does not prune node_modules.
  So a dependency that mis-declares its own build toolchain as a runtime
  `dependency` lands in every installer. This bit us once: `offline-geocode-city`
  (since removed, #175) dragged in `typescript` (~64MB), `@jsheaven/*`,
  `dts-bundle-generator`, `chokidar` and `csv-parse`, all needing
  `!node_modules/<pkg>/**` negation patterns. **Check `npm ls --omit=dev` when
  adding any dependency**, and if you find build-only packages in the production
  tree, exclude them the same way — then verify by physically moving those
  directories out of `node_modules` and confirming the feature still runs.
  (The current geocoding deps are clean: `all-the-cities` → only `pbf`,
  `i18n-iso-countries` → only `diacritics`, so no exclusions are needed today.)
  A different flavor of the same waste: `world-atlas`/`topojson-client`
  (MiniMap.svelte's loupe minimap, #175 follow-up) are genuinely UI-only —
  Vite bundles the one topojson file they use into its own `dist/assets/`
  chunk at build time, so the packaged app's Node process never touches
  `node_modules/world-atlas` or `node_modules/topojson-client` at runtime.
  Verified by moving both out of `node_modules` after `npm run build` and
  confirming the built `dist/` still served correctly. Excluded in
  `build.files` — the same negation pattern, different root cause (not a
  mis-declared dep, just a package whose only consumer is Vite, not Node).
  Two more landed the same way when the region/departamento level and minimap
  labels shipped: `cities.json` (only its `admin1.json` subpath is ever
  imported — the package's exports map keeps the 17MB main `cities.json` file
  from ever being touched, but the whole package still installs) is the same
  Vite-only case as world-atlas. `smart-labels` is back to the FIRST kind of
  waste — it declares `rollup`/`@rollup/*`/`rollup-plugin-ascii`/
  `rollup-plugin-commonjs`/`rollup-pluginutils`/`terser` (its own bundler
  toolchain, ~9.6MB) as runtime `dependencies` instead of devDependencies,
  same mistake as `offline-geocode-city`. Its actual runtime entry
  (`dist/smartLabels.es.js`) only imports `d3`. Verified the same way as
  world-atlas/topojson-client — moved everything aside post-build, confirmed
  `dist/` still served — before excluding.
- **`electron-rebuild -w onnxruntime-node` (in `rebuild:electron`) is currently
  inert — this is expected, not a #67 regression.** `@electron/rebuild` only
  treats a module as needing a rebuild if it has a `binding.gyp`
  (`node_modules/@electron/rebuild/lib/rebuild.js:98`); `onnxruntime-node` has
  none — it ships prebuilt N-API binaries per platform/arch
  (`bin/napi-v6/{platform}/{arch}/onnxruntime_binding.node`), so the flag is a
  no-op and `npm run rebuild:electron` only ever rebuilds `better-sqlite3`. The
  flag is **kept deliberately** so it starts doing real work if a future
  release of the package ever ships source instead of prebuilt binaries.
  Verified the addon loads correctly under Electron by requiring it directly
  under the real Electron binary with `ELECTRON_RUN_AS_NODE=1` (how
  `OnnxMLService` spawns its child) rather than via a rebuild step — N-API is
  ABI-stable across Node and Electron by design, so no rebuild is needed.
  `asarUnpack` is still required regardless: a `.node` file cannot be loaded
  from inside an asar archive no matter how it was built. Re-verify this note
  if `onnxruntime-node` is ever upgraded across a major version.
- **Place names are versioned, and the version is load-bearing.**
  `photos.gps_checked = 1` is a one-way door meaning "we read this file's EXIF
  GPS", which permanently removes the row from the metadata sweep. That correctly
  avoids re-reading an unchangeable file, but it also freezes the _derived_ city
  and country names. So improving `server/lib/place.js` requires bumping its
  `PLACE_VERSION`; `server/db/places.js`'s `backfillPlaces` then re-derives every
  stale row from the stored lat/lon at DB open (no filesystem access, works with
  the drive unmounted). Skip the bump and existing libraries keep the old wrong
  answer forever with nothing failing — which is exactly how #175 shipped.

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
