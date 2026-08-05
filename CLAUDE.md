# AutoGallery v2 — agent guide

Fast, local-first photo triage. Plug in an SD card → instant grid → keyboard-fast
culling → best photos organized into dated album folders. Built for a photographer
who returns from trips with thousands of JPEGs/videos (occasional RAW) and finds
Lightroom too slow.

**Start here:**

- **Current status** → `CHANGELOG.md` (newest first) + open
  [GitHub Issues](https://github.com/john-guerra/autoPhotoOrganizer/issues). The
  app is a stable `2.17.x` release.
- **Working agreements & decisions already made** → `docs/ROADMAP.md` (its
  "Where the project was" log is prototype history, not current status).
- **Filing or working a GitHub issue?** → the `working-issues` skill
  (`.claude/skills/`). Every report John makes becomes an issue with a priority;
  and since several agents work this repo at once, check an issue is unclaimed
  before starting and take your version number with `claim-version.sh` rather
  than hand-picking the next patch.
- Cross-agent summary → `AGENTS.md`.

### The three binding docs, imported rather than linked

These are instructions, not background. They are `@`-imported so they are in
context from the first token — **a doc an agent has to choose to open is a doc
that gets skipped**, which is exactly how faces (#166/#167) shipped breaking
three rules this repo had already settled (#221, #222, #223).

@docs/UI-CONTRACTS.md
@docs/AGENT-NOTES.md
@docs/TESTING.md

`docs/ROADMAP.md` and everything under `docs/superpowers/specs/` stay plain
links on purpose: they are history and reasoning — the **why** — not standing
rules, and importing them would cost every session for something you should read
only when you need it.

## Two invariants (do not violate)

1. **Folders on disk are the source of truth.** There is never an owning catalog.
   The app reads and writes real folders; users can move files with Finder and the
   app catches up on rescan.
2. **The SQLite index is a rebuildable, persistent cache on the INTERNAL disk**
   (`~/.autogallery/`), tracking the source volume per folder. It is a speed layer
   AND an offline mirror: with the external drive unmounted, previews/metadata/
   ratings still browse from cache (Lightroom smart-previews style, with an
   "offline" badge). Ratings live in SQLite so rating works offline; only
   export/moves/resizes require the drive mounted.

   Scan/feed **identity is path + mtime + size**, not content hash — that key is
   unchanged. Separately, `content_hash` (SHA-1) is now hashed for the WHOLE
   library: `hashAllPending` (`db/hashing.js`) runs after every scan, idle-gated
   (`whenIdle`) and to completion, marking unreadable files `hash_attempted` so it
   always terminates; the next scan of any folder finishes the backlog. So
   backup-coverage / cross-drive dedup (#12/#86) and missing-file
   relocation-by-content (#129) now have real data to work with. (Before 2.17.8
   only ~50 rows were ever hashed and `backupCoverage` was inert.)

## Performance thesis

- **Never fully decode a RAW during culling** — the goal. **NOT IMPLEMENTED.**
  `extractPreview` uses `exifr.thumbnail()` (the ~160px EXIF IFD1 thumbnail), which
  _throws_ for RAW; `exiftool-vendored` is not a dependency and the embedded
  `PreviewImage`/`JpgFromRaw` extraction was never built. The loupe points its
  `<img>` at `/api/image/:id` — the original file — so a RAW is currently
  downloaded whole and cannot be decoded by the browser at all. Trust the code
  over this bullet; see `docs/AUDIT-2026-07-13.md` (P1/3) for the fix.
- **Incremental rescans** key on path + mtime + size; unchanged files are skipped.
- **Grid appears while scanning continues** (progressive render) — implemented in
  2.12.13 (`waitForJob`'s `onProgress` + `crossedStep`), and only while the feed is
  empty, so a scan never reloads the grid under a browsing user.
- **Loupe keeps a ±N decoded prefetch window** so back/forth navigation is instant.

## Architecture

- **Backend: Node.js.** All decode/extract/measure work sits behind the
  `ProcessingService` interface (`server/processing/`) so engines can be swapped
  (Node native → WASM → Python ML sidecar) without touching scanner/index/UI.
  The engine uses **exifr** (metadata + EXIF thumbnail), sharp/libvips (resize),
  and ffmpeg/ffprobe (video thumbs, probe, playback transcode). It does **not**
  use exiftool — an earlier version of this file said "exiftool-vendored (daemon)"
  and that was never true of the shipped code.
- **Frontend: Svelte + d3 (Vite).** Virtualized grid, loupe, keyboard-first stars
  1–5 (single keystroke + auto-advance), d3 timeline for album boundaries.
- **Album clustering** is a pure, DOM-free **client** module
  (`ui/src/lib/albums.js`, unit-tested by `albums.test.js`) ported from the legacy
  time-gap algorithm. It runs client-side so the tuning slider re-clusters
  instantly with no round trip; the server only copies the id-groups it produces
  (materialize). It imports d3 for gap statistics, so it is DOM-free but not
  dependency-free. (There is no `server/albums/` code — an earlier `server/albums/
README.md` claimed there was; it was removed as inaccurate.)

## Commands

- `npm run dev` — Express API (`:4321`) + Vite UI (`:5173`) concurrently.
- `npm test` — vitest run.
- `npm run build` — Vite build to repo-root `dist/` (served by Express in prod).
- `npm run format` — prettier.

## Repo map

- `server/` — Express API + `ProcessingService`.
- `ui/` — Vite + Svelte frontend (config in `ui/vite.config.js`, `vite ui`);
  album clustering is the pure client module `ui/src/lib/albums.js`.
- `docs/superpowers/specs/` — design docs (the **why**; some are cited from
  source, so don't move them). Start with `2026-07-06-photo-triage-design.md`.
- `docs/superpowers/completed_plans/` — build plans whose feature has shipped.
  History, **not instructions**: the code is now a better answer than the plan.
  See `docs/superpowers/README.md`.
- `legacy/` — **do-not-run** reference only (two prior generations; known insecure
  patterns). Read it to port the album-clustering algorithm; never execute it.

## Conventions

- **ESM** everywhere (`"type": "module"`).
- **No TypeScript** for now — plain JS with JSDoc types. Revisit only if decided
  explicitly later.
- **Tests: vitest**, colocated as `*.test.js` next to sources under `server/`.
- **Prettier** for formatting.
- **Svelte + d3** on the frontend. **Migrating to Svelte 5 (runes) + latest
  dependencies is in progress — see `docs/svelte-5-migration.md`** for runes best
  practices, the measured migration surface, the dependency-update map, and the
  staged plan. Until a component is converted it stays Svelte 4 (`export let`, `$:`,
  `createEventDispatcher`); a component is all-runes or all-legacy, never half.
- Every file-serving endpoint MUST route user paths through
  `server/lib/safeResolve.js` (path-traversal guard — the legacy app was flagged).
- **Prefer the latest stable version** of a library or framework when adding a
  new dependency or bumping an existing one — don't pin behind older majors
  out of caution. Stale deps are how `npm audit` findings and unpatched CVEs
  accumulate silently. If a transitive dependency carries a known
  vulnerability and no direct dependency has shipped a fix yet, add a scoped
  `overrides` entry in `package.json` (see the `adm-zip`/`onnxruntime-node`
  entry) rather than leaving the finding open or downgrading.

### Four traps that each cost an afternoon

Svelte + the DOM, in this app specifically. None of these fail loudly; each one
silently does nothing, or hangs the tab.

- **A `$:` statement must never depend on a `bind:this` element.** Svelte's
  `safe_not_equal` reports every OBJECT as changed even when it is the identical
  object, so a reactive block whose dependencies include a DOM node re-fires on
  every flush, forever, each run scheduling the next — the tab locks up hard.
  Drive that work imperatively from the handler instead (see `ToolGroup.svelte`'s
  popover). Only primitives belong in a `$:` condition.
- **`in:`/`out:` transitions are LOCAL**, so they are suppressed when an ancestor
  block is created in the same update — which is exactly what a feed refresh does.
  A transition on anything inside the feed needs `|global`, or it never plays at
  all. (And then it needs a guard: the grid is virtualized, so a `|global` intro
  replays every time the element scrolls back into view. See `foldMs` in
  `App.svelte`.)
- **Never re-lay-out from inside a `ResizeObserver` callback.** It raises
  "ResizeObserver loop completed with undelivered notifications" — an uncaught
  error that (rightly) fails `trackPageErrors`. Defer the work a frame
  (`requestAnimationFrame`), as `ToolbarRow.svelte` does.
- **Destroying a `<video>` does NOT stop it downloading.** Removing the element
  — which `{#key item.id}` does on every loupe navigation — stops the picture
  and nothing else: the media loader stays alive until garbage collection.
  Chrome allows **six connections per origin** and `/api/image/:id` answers an
  open-ended `bytes=N-` by streaming the whole rest of the file, so a PLAYING
  clip holds its connection continuously. Ten arrow presses through a video
  folder therefore exhaust the pool: the clip you are on cannot get a
  connection (black frame, `readyState` 0) and `/api/health` cannot be SENT, so
  the app reports the server lost while the server answers in 1 ms. Call
  `releaseVideo(el)` from the action's `destroy` (`ui/src/lib/releaseVideo.js`)
  — `pause()`, `removeAttribute("src")`, `load()`, all three, in that order.
  This is #305, and it survived two fixes aimed at the transcode path before
  the trace log showed that path was never entered.

## A fixed bug gets a test that would have caught it

Full guide: `docs/TESTING.md` (imported above). The rules that matter most:

- **Fix a bug → add a test at the tier that would have CAUGHT it**, in the same
  commit. If pure logic was wrong, that's a vitest test next to the source. If the
  code was right and the _app_ was still wrong — a stale Svelte binding, a label
  clipped at the wrong end, something that only misbehaves once real data loads —
  no unit test can see it, and it belongs in `e2e/` (Playwright).
- **A test that never failed proves nothing.** Before you commit it, revert the fix
  and watch the test go red, then restore. If it stays green, it isn't testing your
  fix — it's decoration. (This is the single cheapest way to avoid a suite that is
  green for the wrong reasons.)
- **Assert on what the user gets, not on how it's built.** "These two groups don't
  render identically", not "labelParts returns 4 parts". Selectors live in
  `e2e/helpers.js`, never inline in a spec, so a markup change is a one-line fix.
- **Be economical: one clever fixture beats five specs.** Prefer extending the shared
  fixture with a single structure that exercises many behaviours at once over
  bolting on a bespoke setup per bug. (The nested `Cards/Cam 1` + `Cards/Cam 10`
  pair covers nesting, a photo-less ancestor, _and_ two names that differ by one
  character — three shipped bugs, one fixture.)
- **Keep the pyramid.** e2e is slow; don't test in the browser what a vitest test can
  prove. Reach for e2e when the bug lives in the seam between modules, the DOM, or
  the load order — which is exactly where this app's shipped bugs keep coming from.
- **`trackPageErrors(page)` in every spec.** It's free, and it alone would have caught
  three of the five bugs that reached a user in the 2.9.x round.

## The three contracts every feature inherits

Full text, with the shapes and the reference implementations → **@docs/UI-CONTRACTS.md**
(imported above, so it is already in context). The three rules, and the one
question that decides each:

1. **Scope — _can the user run this on their selection?_** Every operation over
   photos offers **All / Visible / Selected** with live counts, the cost
   estimate tracking the choice, and an empty scope refused specifically rather
   than silently widened to the whole library. One shared control, not one per
   feature. Reference: `MlSettings.svelte`'s `data-testid="ml-scope"`.
2. **Locus of control — _can the user walk away and stop it?_** Anything that
   can run longer than a moment is a **job**: visible in the JobsPanel from the
   main interface, proportional progress whenever the total is knowable,
   genuinely cancellable, and summarized on completion (`summarize()` needs a
   branch for the type). A cancellation is an outcome, not a failure. Turning an
   awaited request into a job is not a wrapper — the route returns `{jobId}` and
   the caller stops awaiting a result.
3. **Placement — _does it show the user photos?_** Then it is a **view** in the
   main area, not a control in a settings panel. Panels hold settings (which
   model, download it, the licence, forget everything). Anything with a
   selection, a rating, or a photo in it belongs where those already work. The
   registry and its boundary are #155: **App stays the data owner** and a view
   never touches `items`.

These are not new. Each was settled once — #215/#206, #208/#161, #207/#155 —
and then re-broken by the next feature, because the rule lived only in a closed
issue. Breaking one is an incomplete change, the same way a feature with no
error handling is incomplete.

## Usability (never fail silently)

Every user-facing action must tell the user what is happening. A console error
is **not** user feedback.

- **Surface every failure the user can trigger** as a visible, specific,
  actionable message in the UI — never a silent no-op or console-only error.
  A `413`, a rejected job, an unmounted drive: the user sees _what happened_
  and _what to do next_, not a dead button. If an operation can fail, its
  caller renders the error (the existing pattern: `result.error` inline, the
  status line for transient state).
- **Prefer specific over generic.** "Undo failed: the move record was too large
  to send (N files) — retry from the jobs panel" beats "Error".
- **Long or async operations show progress and completion**, not a frozen
  control — route them through the JobsPanel; never block the UI thread (heavy
  fs/IO belongs off the main event loop — see the materialize async work). Heavy
  CPU counts too: a synchronous O(n²) pass is a server that answers nothing, and
  the user cannot tell a wedge from a crash. Yield, and check the abort signal
  at the yield point (`clusterFaces` in `server/ml/faceClusters.js`). Full
  contract → **contract 2 above**.
- **Confirm or make-undoable anything destructive.** Prefer soft-delete + a
  visible undo affordance over a hard, unrecoverable action (and over a hard
  failure).
- When you add or touch an action, ask: _if this fails, does the user find out,
  and do they know what to do?_ If not, it isn't done.

## Every report becomes an issue

**When John reports a bug, asks for a feature, or describes an annoyance, file a
GitHub issue for it** — even when he didn't ask you to, and even when you fix it
in the same breath. The conversation is gone tomorrow; the tracker is the backlog.

Search for a duplicate first (`gh issue list --search "<keywords>" --state all`),
then propose a priority and confirm it in one question rather than filing
unprioritized — `priority: critical | high | medium | low` (MoSCoW: must-now /
must-this-cycle / should / could), `medium` being the default. Don't set a
milestone; they're vestigial here.

Full ladder, filing template, and the parallel-agent claim protocol → the
**`working-issues` skill** in `.claude/skills/`.

## Committing

- **Commit often — every stable state is a checkpoint.** The moment the app
  builds, tests pass, and a slice works, commit it as a small, focused commit.
  Frequent known-good points make it cheap to bisect a regression or roll back,
  and keep the working tree from piling up into one big unreviewable batch.
  Prefer many small checkpoint commits over one large one.
- **`testing` is the trunk; `main` is the release line.** Branch off
  `origin/testing`, open the PR with `--base testing`. `package.json` and
  `CHANGELOG.md` advance on `testing`; `main` stays at the last released
  version until John validates a batch and merges it forward, then tags `v*`.
  Never merge to `main` or push a `v*` tag yourself. Full protocol (and the
  reason `claim-version.sh` reads its base from `testing`, not `main`) → the
  `working-issues` skill; rationale → `docs/ROADMAP.md`.
- **Commit proactively — don't wait to be asked.** Whenever there's a stable
  version or a significant change (a fix verified, a feature slice landed, a
  refactor at a green state), commit it right then so we always have
  checkpoints. Do not pause to ask permission to commit at these points; just
  make the checkpoint commit. Only hold off if the work is mid-flight and
  known-broken.

## Keyboard shortcuts

This is a keyboard-first app: a shortcut nobody can find does not exist.

- **Every new (or changed, or removed) keyboard shortcut MUST be documented in
  the help menu — `ui/src/lib/ShortcutsOverlay.svelte` — in the same commit that
  adds it.** The overlay is a plain `groups` array of `{ keys, label }` rows, so
  this is one line; put it in the group it belongs to (Rating & selection,
  Navigation, View, …), and add a new group only if none fits.
- The `label` describes **what the user gets**, not the handler ("Jump to the
  next group", not "call jumpFromGroup"). Note modifiers and any mode-specific
  behaviour (e.g. "auto-advances in loupe").
- A shortcut added to `onKeydown` without a matching overlay row is an
  **incomplete change**, the same way a feature without user-visible error
  handling is (see Usability above).

## Versioning

- **Every change bumps the app version in `package.json`.** The version shows
  in the title bar (`App.svelte` reads it via Vite's `__APP_VERSION__` define)
  and drives electron-updater releases, so it doubles as the human-visible
  changelog anchor.
  - **Patch** (`x.y.Z+1`) — the default for **all** ongoing work: every fix,
    feature, or enhancement bumps the third number (e.g. Reveal in Finder,
    manual burst stacks, a bug fix — all patch bumps).
  - **Minor** (`x.Y+1.0`) — bumped **only when we generate a new package**
    (cut a packaged/distributable build — e.g. an `electron:build:mac` /
    release artifact). Rolls the patch number back to `0`.
  - **Major** (`X+1.0.0`) — breaking changes or removed capabilities.
- **Stable releases carry no pre-release suffix.** As of `2.9.0` the app is out
  of alpha: ongoing work bumps the patch on a plain `x.y.z` version (e.g.
  `2.9.0` → `2.9.1`), and the next packaged build cuts the next minor
  (`2.10.0`). Only add a `-alpha`/`-beta` suffix when deliberately cutting a
  pre-release for testing (electron-updater keeps stable and pre-release users
  on separate tracks). Bump in the **same commit/PR that closes the issue**,
  not as a separate housekeeping commit.
- **Update `CHANGELOG.md` in that same commit.** Add a new `## <version>` entry
  (newest first) with a clean, short, user-facing line per feature/fix — what
  the user can now do, not how it's implemented — most notable first, with the
  issue number in parens. This is the human-readable companion to the version
  number.

## Agent tool usage

- When driving the app with claude-in-chrome for verification, prefer
  `browser_batch` to run a sequence of clicks/types/navigations/screenshots in
  one call instead of one tool call per action — much faster than issuing them
  individually.
- **Never modify, move, rename, or delete anything inside the user's actual
  photo folders** (the real files on disk/SD cards/external drives) unless the
  user has explicitly asked for that specific action in that conversation. This
  is independent of and stricter than the read-only test-folder convention
  above — it applies to all of the user's photo libraries, not just the
  designated test folders. The `~/.autogallery/` SQLite cache is safe to
  inspect/rebuild freely per the second invariant above.
- If a feature ever needs to delete a photo (export cleanup, dedup, etc.), it
  must soft-delete — move the file into a recoverable trash location, never a
  hard/permanent delete — so the user can always recover it.

## Debugging discipline (learned the hard way — see issues #36–#39)

- **For any data-ordering/display bug, verify the raw API response before
  proposing a client-side fix.** A multi-day chase of a "group-jump lands on
  the wrong photo" bug spent most of its time on client-side theories
  (scroll-anchor, race conditions, burst-clustering) before `curl`ing the
  actual `/api/feed?before=N&focusId=X` response and discovering the server's
  "before" seek was returning items _after_ the focus point too — a bug no
  amount of client-side reasoning could have found. Check the lowest layer
  first, especially when the client is "correctly" rendering data it was
  handed.
- **Verify a fix against the exact reported scenario, live, before claiming
  it's fixed.** A fix that resolves a _similar_ case (e.g. a rapid-fire
  concurrency repro) is not the same as verifying the user's _actual_ repro
  steps. This project's existing "manual browser verification for App.svelte"
  convention (see `docs/ROADMAP.md`) exists for this reason — a passing test
  suite plus a plausible-looking screenshot is not sufficient for anything
  touching feed-window ordering or state.
- **New logic that replaces or extends the feed window (`items`) must not
  hand-roll another copy of the `fetchingBefore`/`fetchingAfter`/`feedEpoch`
  guard pattern.** The guard exists because a scroll-triggered fetch started
  against the OLD window can resolve _after_ a rebuild and splice its stale
  page into the NEW `items` — duplicate rows, therefore duplicate Svelte keys,
  therefore `{#each}` throws and the grid "freezes". Six hand-copied versions
  of it caused two shipped bugs (issues #35, #36, #39).

  It has since been consolidated (issue #42) into **two** transactions, and
  every feed-window change belongs in one of them:

  - **Replace** the window (filter/sort/groupBy change, fold, jump-to-group) →
    `withFeedTransaction(body)` in `App.svelte`. It flushes (`await tick()`,
    because `displayFilter` is a `$:` derived value that does not exist yet when
    the handler sets `filter`), bumps the epoch, and holds BOTH fetching flags
    for the whole duration. `body` gets the epoch it owns and **must re-check
    `epoch !== feedEpoch` after every await** before touching shared state.
  - **Extend** the window (infinite scroll) → `loadMore(direction)`, which owns
    its own guard because it appends rather than replaces.

  If a new case fits neither, extend one of those two — do not open a third.
