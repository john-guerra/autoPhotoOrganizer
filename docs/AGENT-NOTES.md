# Agent operational notes

Durable, **project-invariant** knowledge that used to live only in a per-machine
agent memory store — now checked in so it survives `git clone` and reaches CI,
teammates, and any agent (Rec 6 of `AI-CODING-REVIEW-2026-07-24.md`). Genuinely
personal/machine-specific items (real photo-folder paths, etc.) stay in the
gitignored `docs/TEST_FOLDERS.local.md`, not here.

Keep this current: when one of these facts changes, update it in the same commit.

## Testing gotchas

- **Run `npm ci` in a new worktree BEFORE trusting a test result.** A fresh
  `git worktree add` gives you an empty `node_modules/`, and Node's resolution
  then walks up and finds the parent checkout's — so every import works and the
  suite looks fine. The one test that notices is
  `server/ml/asarPackaging.test.js`, which asserts
  `existsSync(cwd/node_modules/onnxruntime-node)` and correctly reports false.
  It reads like a real regression in the ML layer and is not one. (Cost ~15
  minutes chasing a rename that had nothing to do with it, 2026-07-27.)
- **The e2e index is wiped by the WEB SERVER COMMAND, not by `buildFixture`, and
  the ordering is load-bearing.** Playwright starts `webServer` BEFORE
  `globalSetup`, and `buildFixture` used to `rm -rf` the whole `e2e/.tmp` —
  including the `index.db` the server had already opened. SQLite carried on
  through the open file descriptor, so the suite worked perfectly, but the
  database existed at **no path at all** and nothing outside the server process
  could read or seed it. That was invisible for a long time because nothing
  needed to. `playwright.config.js`'s `webServer.command` now clears
  `e2e/.tmp/home` before `npm run dev` starts, and `buildFixture` clears only
  the photos — same freshness guarantee, real file. This is what lets
  `seedFaces` write rows no API can create (#232).

- **A spec that seeds global state must clean it up, or it breaks specs it has
  never heard of.** `seedFaces` leaves people in the index for the rest of the
  RUN, and enough of them make both `PersonFilter` and the Face Map's switcher
  button render — two extra toolbar controls. The toolbar folds by WIDTH (see
  below), so that pushed unrelated groups into the overflow popover and turned
  `tagFilter` and `timelineKeepFilter` red. Hence `clearFaces` in `afterAll`.

  **It happened again, worse, and the trigger is the part worth remembering: a
  feature can turn an existing, previously harmless spec into a leaking one.**
  #212 made the "keep only" working set survive a reload — correct behaviour,
  and the entire point of the fix. Three specs had been scoping the app and
  cleaning up after none of it, which cost nothing only because the UI used to
  forget an ids scope on the next `openApp`. The moment the server became the
  source of truth, each of them started leaving a **three-photo library** behind
  it: **36 tests red across files they have never heard of**, including
  `culling.spec.js` (@p0). Both PRs were individually green — the specs that
  leaked and the change that made leaking matter were never in one tree until
  they merged.

  The fix is structural, in `openApp`: **it clears the working set by default**,
  exactly as it already clears localStorage. Per-spec cleanup was tried first
  and is the wrong shape — it fixed one of the three, took the failure count
  from 36 to 26, and looked done. The next spec to scope the app would have
  reintroduced it.

  Four things that generalise:

  - **`openApp` clears the scope; `preserveScope: true` opts out.** Only
    `keepOnlyPersist.spec.js` needs it, because it exists to assert the scope
    survives a reload. Opting out skips harness cleanup only — localStorage is
    still wiped, so the scope still has to come back from the server unaided.
  - **`openApp` is not a complete net: `burst.spec.js` and
    `filmstripBurst.spec.js` never call it**, and `burst` runs immediately after
    the leaking `albums.spec.js`. So a spec that scopes the app ALSO clears in
    `afterAll`. Belt and braces, and the braces have a known hole.
  - **The leak had no grep signature.** `albums.spec.js` never says "keep only" —
    Auto Albums **auto-scopes to the selection**, so it writes `keep_scope` as a
    side effect. `grep -rln keepOnly e2e/*.spec.js` found the other two and
    missed the one doing most of the damage. What found it was bisecting the
    suite; treat greps as a first pass, not an audit.
  - **When a change makes state durable, bisect the suite rather than reasoning
    about it.** Running the same batch against the commit before the merge
    (61/61 green vs 10 red) settled in two runs what an afternoon of log-reading
    had not. Both halves of a merge can be green; only their combination is the
    thing under test.

- **Isolate destructive index tests.** Anything that removes folders, resets, or
  materialize-moves must run against a **temp `AUTOGALLERY_HOME`**, never the real
  `~/.autogallery/`. Playwright already points `AUTOGALLERY_HOME` at `e2e/.tmp/home`
  over generated fixtures (see `playwright.config.js`), which is why `resetRatings`
  in `e2e/helpers.js` is safe by construction.

  **This is now ENFORCED for vitest, and it had to be (#293).** The rule above
  was a convention held up by one `beforeEach` per file, and `cacheRoot()`
  fell back to the real `~/.autogallery` whenever the variable was missing —
  silently, returning a valid path. Three ways to miss it, all of them quiet:
  a new test file that forgets the hook; a `getDb()` at module scope, which
  runs before any hook; or the window after an `afterEach` has deleted the
  variable, since vitest reuses a worker across files. Whether a given run
  touched the real database came down to **file execution order**.

  `cacheRoot()` now THROWS when `process.env.VITEST` is set and
  `AUTOGALLERY_HOME` is not, with the `beforeEach` to copy in the message.
  Turning it on immediately found a live instance: `server/index.test.js`
  (added by #282, 2.19.26) called `createApp()` with no scratch root, so every
  `npm test` had been running `applySchema` and `migrateLegacyJsonIfNeeded`
  against the developer's real index. Nothing ever failed — which is the
  entire problem, and the reason a convention was not good enough.

  **Corollary: never add a schema migration and assume tests cannot reach a
  real library.** Before this guard, a `DROP TABLE` in a migration plus one
  test file missing its hook was all it took.

- **`e2e/albums.spec.js` flakes were CI-only, and both causes are now fixed**
  (2.18.23). Kept here because the two mechanisms recur elsewhere:
  - _Album-count precondition._ Album detection gap-clusters on
    `COALESCE(taken_at, …, mtime)`, but enrichment is LAZY — only rendered
    thumbnails get their EXIF read. Un-enriched photos fall back to build-time
    mtimes milliseconds apart and collapse into one album, so the count varied
    with paint timing. Fix: `enrichAll` before `openApp` (same rule as
    `places.spec.js`).
  - _`trackPageErrors` vs. a deliberately stubbed error response._ Chromium
    logs ANY non-2xx as its own `console.error`, even one the test injected on
    purpose; whether that async event beats the final `expect(errors)` is a
    race that slow runners lose. Fix: filter out the error the test itself
    caused, as `culling.spec.js` already did — never assert a bare `[]` in a
    test that stubs a failure.
  - Note both were **unreproducible locally** (20+ clean runs each) — a green
    local run does not clear a CI-only flake in this file.
- **Never edit `server/` while an e2e run is in flight.** The e2e web server is
  `npm run dev`, whose server half runs under `node --watch --watch-path=server`
  — so saving any file there RESTARTS it mid-suite, and whichever request lands
  in that window fails with a proxy `ECONNREFUSED` and a 502. It reads as a
  product bug in a spec that has nothing to do with what you were editing
  (observed 2026-07-31: `ml-settings.spec.js` asserting 400, receiving 502,
  while a pipeline route was being added in another window). The log gives it
  away — `[server] Restarting 'server/index.js'` immediately before the failure
  — but only if you look, and the obvious reading is that your change broke
  something. Either wait for the run, or work on `ui/` (Vite HMR is fine).

- **A test that never failed proves nothing.** Revert the fix, watch the test go
  red, restore. (Also in CLAUDE.md — repeated here because it's the most-skipped
  step.)
- **`npm test` can be GREEN on code plain `node` refuses to load.** Vitest runs
  everything through Vite's SSR transform, which rewrites `import { x } from …`
  into `__vite_ssr_import_0__.x` — so no local binding named `x` exists, and a
  file that _also_ declares its own `function x()` has no collision. Under real
  Node that same file is a hard `SyntaxError: Identifier 'x' has already been
declared` at import time. It cost a cycle in #221: 1,549 unit tests passed
  while the API server would not boot at all, and only the e2e suite (which
  starts the real server with `node`) caught it. Vite silently preferring the
  _local_ declaration also means the shared import you thought you wired up may
  never have been called. After moving a function between server modules, run
  `node -e "import('./server/path/mod.js')"` — it takes a second and it is the
  only cheap check that the module is loadable as shipped.
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

  Faces (#166) work the same way, and additionally need the weights present
  under `~/.autogallery/models/insightface/<pack>/`:

  ```bash
  AUTOGALLERY_FACE_FIXTURES=/path/to/photos/with/people ML_INTEGRATION=1 \
    npx vitest run server/ml/faceIntegration.test.js
  # AUTOGALLERY_FACE_PACK=buffalo_l to check the other pack (default buffalo_s)
  ```

  Point it at a folder with **dozens** of photos, not three — the first
  assertion needs enough images to distinguish "finds faces sometimes" from
  "fires on everything", which is what a wrong anchor stride looks like.
  `faceDetect.test.js` drives the same pipeline against fake sessions and runs
  in `npm test`, but a fake detector emitting the layout the decoder expects
  cannot catch a decoder that agrees with it and disagrees with the real
  graph. Only this file can.

## Native modules: better-sqlite3's ABI is a one-way switch

- **`npm run electron:build:*` leaves better-sqlite3 built for ELECTRON, and
  every Node process then dies.** The build script is
  `rebuild:electron → build → rebuild:node`; if that last step does not run
  (interrupted, failed, or the build was killed), the binary left behind is
  `node_modules/better-sqlite3/bin/darwin-arm64-148/` — 148 is Electron 43's
  `NODE_MODULE_VERSION`. Node 24 wants 137, so `npm run dev`, the e2e suite and
  every unit test that opens a DB fail with
  `Could not locate the bindings file`. Fix: **`npm run rebuild:node`**.
- **`require("better-sqlite3")` is NOT a check for this.** It only loads the JS
  wrapper; the native binding is not touched until `new Database()`. A require
  that succeeds tells you nothing, and reading "it loads fine" as "the ABI is
  right" cost a wrong diagnosis (2026-07-28). The real check is one line:

  ```bash
  node -e "const D=require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); console.log('node ABI ok')"
  ```

- **`npm run electron:dev` needs NO rebuild.** In dev mode Electron only loads
  the Vite URL (`electron/main.js`, `isDev`); the Express server stays a
  separate NODE process, so it wants the Node ABI exactly like `npm run dev`.
  Only a PACKAGED build runs the server inside Electron.
- **`electron:dev` and `npm run dev` cannot both run.** `electron:dev` starts
  its own server + Vite; with 5173 taken Vite silently moves to 5174 while
  Electron's dev URL stays 5173, so the window loads nothing and the only clue
  is a port line buried in the log.

## The toolbar folds by WIDTH, and it is closer to the edge than it looks

- Adding ONE control to the toolbar can push an unrelated group into the
  overflow popover. `PersonFilter.svelte` documents this ("two extra controls
  in GridControls once pushed the whole Group group into an overflow popover at
  ordinary window sizes") and #223 hit it again: a third view-switcher button
  made `.group-by` and `.seg-toggle` disappear at 1280px.
- **It reproduced only in CI.** The local suite passed 151/151 at the same
  viewport — this sits right on the threshold, so a slower runner folds and a
  fast one does not. A green local run does not clear it; check the CI e2e.
- The registry's answer is `offerable(ctx)` in `views/registry.js`: a view says
  when it is worth a permanent slot (People earns one once people exist).
  Prefer that to another always-on control.

## Dev-server & process gotchas

- **Never pipe a long-running server into `head`/`tail`.** `npm run dev 2>&1 |
tail -6` never terminates (the server never closes the pipe), so the Bash tool
  times out and kills the WRAPPER shell — while `npm → concurrently → vite/node`
  is orphaned and reparented, holding its port. One session accumulated 29 of
  these across 24 hours, on ports 5173–5182, and a stale one silently serves the
  version it was started with (see the `__APP_VERSION__` note below). Use
  `run_in_background` instead, which the harness can actually stop.
- **`kill $PIDS` DOES NOTHING in zsh, and reports success.** This shell is zsh,
  which — unlike bash — does **not** word-split unquoted parameter expansions.
  A space-separated PID string is passed as ONE argument, so `kill` sees an
  illegal pid; with stderr suppressed it looks exactly like a permissions
  problem, and `for p in $PIDS` fails the same way. Pipe to `xargs -n1 kill`
  (shell-agnostic) or use `${=PIDS}` / an array. Cost two failed cleanup
  attempts that were misread as sandbox restrictions, 2026-07-27.

- **The dev server has no watch for `server/` changes.** Edits under `server/`
  need a manual `npm run dev` restart; verify a server fix with `curl` against a
  throwaway server on another port rather than assuming hot-reload.
- **`pkill -f scripts/dev.mjs` kills every worktree's dev server**, including the
  main checkout's. Stop a specific one by its listening-port PID
  (`lsof -ti :4321 | xargs kill`), not by process-name match.
- **Abandoned dev servers pile up, and an old one will happily serve you stale
  code.** Vite auto-increments its port, so several sessions leave listeners on
  5173, 5174, 5175… all rooted in the same worktree. They answer 200, and they
  even serve files added minutes ago — but each one baked `__APP_VERSION__` at
  ITS config load, and holds its own module graph. Opening "the app" on 5173
  after bumping the version therefore shows the OLD version in the title bar and
  can run pre-edit code, with nothing anywhere reporting an error.

  **Read the version in the title bar before trusting anything you see**, and
  treat a mismatch with `package.json` as "wrong server", not a caching hiccup.
  The reliable move is to start your own on an explicit port
  (`npx vite ui --port 5199 --strictPort`) and verify that port's title. Check
  age with `lsof -nP -iTCP:<port> -sTCP:LISTEN` plus `ps -o etime= -p <pid>`
  before killing: a listener may belong to another agent's worktree, or to a
  packaged Electron the user is actually using.

- **Never background `npm run dev` through a pipe** (`npm run dev | head -60`).
  `head` exits after its lines and SIGPIPEs the pipeline — which killed the Vite
  half while Express kept running on 4321, leaving a half-dead dev server whose
  log was empty. Redirect to a file instead.

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
- **The ML worker DOES spawn from a packaged build — verified end-to-end, not
  reasoned about** (#203). The chain looked risky enough to gate a release:
  `OnnxMLService` spawns `process.execPath .../app.asar/server/ml/worker/index.js`
  with `ELECTRON_RUN_AS_NODE=1`, so an **ESM** entry has to load from inside an
  asar archive, resolve relative and bare imports there, and reach a native
  addon that must live outside it. Every link works. Measured on
  `2.18.32`/darwin-arm64 against a real `electron:build:mac` artifact: the
  packaged binary spawned the real worker, `health` returned
  `ort 1.27.0, providers cpu,webgpu,coreml`, and a real `embed` returned 2×768
  SigLIP vectors on the `cpu` EP. **No `asarUnpack` change is needed** — the
  pre-emptive `server/ml/worker/**` entry #203 proposed would have been dead
  weight. Three findings worth not rediscovering:
  - **`"type": "module"` is not what makes it work.** Electron 43 ships Node 24,
    whose unflagged module-syntax detection reparses an ESM `.js` as ESM even
    with no `type` field, warning `MODULE_TYPELESS_PACKAGE_JSON` and parsing
    twice. Keep the flag for the warning and the startup cost; do not credit it
    with correctness.
  - **The ESM loader honours the asar→`app.asar.unpacked` redirect**, not just
    `require`. That is the path `@huggingface/transformers` reaches
    `onnxruntime-node` by, and it was the one genuinely unverified link.
  - **The `onnxruntime-node` entry in `asarUnpack` is anchored, and silently
    fragile because of it.** It does not match a nested copy under
    `@huggingface/transformers/node_modules/`. Today npm dedupes the root's
    1.27.0 with transformers' 1.24.3 request into one top-level install, so it
    hits. If those ranges ever go disjoint, npm nests a second copy, the glob
    stops covering the one actually loaded, and the `.node` ships sealed inside
    the asar with nothing in the build complaining.

  `server/ml/asarPackaging.test.js` pins all of this: config assertions always
  run, and a live probe packs a miniature asar and runs an ESM entry out of it
  under the real Electron binary (skipping loudly if that binary is absent).
  Verification is **darwin/arm64 only** — see #136 for the arch matrix.

- **`worker_threads` DOES resolve from inside `app.asar` — verified, and the
  #203 verification does not cover it.** The projection worker (#232) is a
  different path from the ML worker: that one is a spawned
  `ELECTRON_RUN_AS_NODE` child (a plain Node process), whereas this is a Worker
  created _inside_ the process — and in a packaged build the Express server
  runs inside Electron's main process. So the open question was whether
  Electron's asar interception reaches a fresh worker isolate's module loader.
  It does: an ESM worker entry at `/…/app.asar/server/projection/worker.js`
  starts, and its relative and bare imports both resolve. Pinned by the
  `worker_threads resolves from inside an asar (#232)` probe in
  `server/ml/asarPackaging.test.js`, which packs a miniature asar and runs it
  under the real Electron binary (skipping loudly if that binary is absent).
  Verified darwin/arm64, 2026-07-28.

  **There is deliberately no `server/projection/**` entry in `asarUnpack`.**
  #203's own conclusion was that its pre-emptive entry "would have been dead
  weight"; if the probe ever goes red, adding that one line is the fix.

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

## There is a trace log. READ IT before theorising (#314)

The app records what it and the server were doing, always on, on the user's
disk and sent nowhere. Reach for it FIRST on any "it stalled" / "it lost the
server" / "this is slow" report — it exists because #305 survived two fixes
aimed at causes nobody had measured.

```bash
curl -s 'http://127.0.0.1:4321/api/debug/trace?limit=2000' | jq .   # live
ls -t ~/.autogallery/logs/                                          # past runs
```

- **Channels**: `http` (one line per request, on socket CLOSE — so `aborted`
  means the BROWSER gave up, `done` means we answered), `loop` (event-loop
  delay), `proc` (child spawns, with a live count), `job`, `app`, and `ui:*`
  for anything the browser recorded.
- **`?since=` is a SEQUENCE number, not a timestamp.** Two events routinely
  share a millisecond.
- Off under vitest unless `AUTOGALLERY_TRACE=1`; `AUTOGALLERY_TRACE=0` disables
  it anywhere.
- The user gets the path from Settings (`,`) → Diagnostics → Copy log location,
  which flushes the pending batch first.

**The one measurement that pays for the whole thing** is `loop.maxMs`. "Lost
the connection to the AutoGallery server" is a CLIENT verdict — `/api/health`
did not answer within 4 s — and it has two causes that look identical: the
server could not get round to answering, or the browser never sent the
request. If the loop was late it is the server; if the loop was fine through
the whole outage, no amount of server-side capping will ever help. Nothing
recorded that number before #314, which is exactly how #305 got two fixes
aimed at the wrong half of the system.

**A long-lived stream is logged only when it ENDS**, since the line is written
on close. A video playing for ten minutes is invisible for ten minutes — read
`inflight` on neighbouring lines to see it, not the absence of its own.

## Not every video transcodes, and the ones that don't are a different bug

`playbackPlan` (`server/lib/videoPlayback.js`) returns **`direct`** for
`.mp4/.m4v/.mov/.webm` carrying h264 4:2:0 — the loupe is then pointed at
`/api/image/:id`, the original file, and **no job, no ffmpeg, and no
`TRANSCODE_SLOTS` are involved at all**. Screen recordings are all like this:
`2025_09Sep_12_WebDev_Online_Lectures` is 75 `.mov / h264 / yuv420p` files,
several of them 400–750 MB.

So a fix to the transcode path is inert for that entire class of library. Both
of #305's first two fixes were, and the trace log is what showed it: eleven
`ui:video ask` events in 50 ms, every one answered `ready: true`, zero
transcode jobs. **Check which branch of `playbackPlan` the reported files take
before touching the conversion machinery.**

## `gh issue list --search` misses issues that exist. Grep the full list.

**Do not trust `--search` as a duplicate check.** #314 was filed as a duplicate
of #96 — which had asked for the same trace log three weeks earlier — after
`gh issue list --search` returned nothing for it **twice**. It happened again
during the #323 audit: a search for `documentation stale docs plans version`
returned zero rows while four documents were demonstrably stale.

GitHub's search index is not the issue list; it lags, it stems words its own
way, and it silently returns an empty set rather than an error. The check that
actually works costs one more command:

```bash
gh issue list --state all --limit 200 --json number,title,state \
  -q '.[] | select(.title|test("<your keywords>";"i")) | "\(.number) \(.state) \(.title)"'
```

`--search` is a fine first pass. It is not an audit, and "search found nothing"
is not evidence that nothing is there — the same shape as the greps that missed
the `keep_scope` leak above.

## Never write a comment or a doc that claims a test you did not write

Caught in the 2.20.1 review: `e2e/diagnostics.spec.js` carried a comment
referencing a refusal-path assertion **nobody had written**. This is the same
family as a `.replace()` whose anchor never matches, or `kill $PIDS` in zsh —
an operation that silently does nothing and reports success. The cost is worse
than the missing test, because the comment actively stops the next agent from
adding it.

Before writing "covered by X" anywhere, run X and read the output.

## A cancelled CI job looks exactly like a failed one

`gh pr checks` renders a **cancelled** job as `fail`, and `--log-failed`
returns nothing at all because there is no log — so it reads as a test that
broke, and you go hunting for the test. There is no test. It never started.

The honest signal is only in the jobs API:

```bash
gh api repos/{owner}/{repo}/actions/jobs/<id> \
  -q '"\(.status) / \(.conclusion) — steps: \(.steps|length)"'
# completed / cancelled — steps: 0    <- never ran; this is not your code
```

`steps: 0` means no runner ever picked it up. During the 2026-08-06 Actions
outage this cost a real detour: `e2e` on PR #324 reported `fail` having
executed **zero** steps, while CodeQL failed in `Set up job` with
`Failed to resolve action download info: Service Unavailable`. Neither had
anything to do with the diff. **Check githubstatus before diagnosing a red
board you cannot explain** — and note the incident escalated for an hour after
it opened, so "it was fine ten minutes ago" is not evidence.

## CI on `testing` is a real gate now, and nobody watches it

Branch protection requires `check` and `e2e` (#330). Four consequences:

- **Never poll CI.** `gh pr merge --auto --merge`, then end your turn. GitHub
  merges when green. The expensive thing was never CI's 11 minutes — it was an
  agent blocking on them, which costs 30–50k tokens and buys nothing.
- **The post-merge close-out is a workflow**, not your job —
  `.github/workflows/pr-closeout.yml` handles `wip` → `needs-validation` and
  releases the claim tag. Do not duplicate it by hand; two agents racing the
  same tag deletion is how a live claim gets destroyed.
- **`strict` is deliberately FALSE.** Your PR does not need rebasing onto the
  current `testing` to merge. Turning it on would make every merge invalidate
  every other open PR and re-run its CI — with several agents here, a queue of
  11-minute waits behind whoever merged last.
- **CodeQL is advisory, not required.** That is #290, still undecided, and it
  also fails for pure infrastructure reasons (above).

## Where the deep context lives

- Invariants, Svelte/DOM traps, feed-window transactions, usability & testing
  contracts → `CLAUDE.md`.
- Prioritized tech-debt map → `docs/AUDIT-2026-07-13.md` (dated; re-verify against
  the current version before picking work) and `docs/AI-CODING-REVIEW-2026-07-24.md`.
- Backlog → GitHub Issues (`john-guerra/autoPhotoOrganizer`), not `ROADMAP.md`.
