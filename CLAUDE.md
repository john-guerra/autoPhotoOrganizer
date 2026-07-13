# AutoGallery v2 — agent guide

Fast, local-first photo triage. Plug in an SD card → instant grid → keyboard-fast
culling → best photos organized into dated album folders. Built for a photographer
who returns from trips with thousands of JPEGs/videos (occasional RAW) and finds
Lightroom too slow.

**Start here: `docs/ROADMAP.md`** — current status, v0.2 backlog, working
agreements (including read-only test folders and moderate use of browser
verification), and decisions already made.

## Two invariants (do not violate)

1. **Folders on disk are the source of truth.** There is never an owning catalog.
   The app reads and writes real folders; users can move files with Finder and the
   app catches up on rescan.
2. **The SQLite index is a rebuildable, persistent cache on the INTERNAL disk**
   (`~/.autogallery/`), keyed by content hash and tracking the source volume per
   folder. It is a speed layer AND an offline mirror: with the external drive
   unmounted, previews/metadata/ratings still browse from cache (Lightroom
   smart-previews style, with an "offline" badge). Ratings live in SQLite so
   rating works offline; only export/moves/resizes require the drive mounted.

## Performance thesis

- **Never fully decode a RAW during culling.** Extract the camera's embedded JPEG
  preview (RAW) or the EXIF/embedded preview (JPEG) via exiftool daemon mode.
- **Incremental rescans** key on path + mtime + size; unchanged files are skipped.
- **Grid appears while scanning continues** (progressive render).
- **Loupe keeps a ±N decoded prefetch window** so back/forth navigation is instant.

## Architecture

- **Backend: Node.js.** All decode/extract/measure work sits behind the
  `ProcessingService` interface (`server/processing/`) so engines can be swapped
  (Node native → WASM → Python ML sidecar) without touching scanner/index/UI.
  MVP engine uses exiftool-vendored (daemon), sharp/libvips, ffmpeg.
- **Frontend: Svelte + d3 (Vite).** Virtualized grid, loupe, keyboard-first stars
  1–5 (single keystroke + auto-advance), d3 timeline for album boundaries.
- **Album clustering** is a pure, framework-free module (`server/albums/`) ported
  from the legacy time-gap algorithm.

## Commands

- `npm run dev` — Express API (`:4321`) + Vite UI (`:5173`) concurrently.
- `npm test` — vitest run.
- `npm run build` — Vite build to repo-root `dist/` (served by Express in prod).
- `npm run format` — prettier.

## Repo map

- `server/` — Express API + `ProcessingService` + `albums/` clustering.
- `ui/` — Vite + Svelte frontend (config in `ui/vite.config.js`, `vite ui`).
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
- **Svelte + d3** on the frontend.
- Every file-serving endpoint MUST route user paths through
  `server/lib/safeResolve.js` (path-traversal guard — the legacy app was flagged).

## A fixed bug gets a test that would have caught it

Full guide: `docs/TESTING.md`. The rules that matter most:

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
  fs/IO belongs off the main event loop — see the materialize async work).
- **Confirm or make-undoable anything destructive.** Prefer soft-delete + a
  visible undo affordance over a hard, unrecoverable action (and over a hard
  failure).
- When you add or touch an action, ask: _if this fails, does the user find out,
  and do they know what to do?_ If not, it isn't done.

## Committing

- **Commit often — every stable state is a checkpoint.** The moment the app
  builds, tests pass, and a slice works, commit it as a small, focused commit.
  Frequent known-good points make it cheap to bisect a regression or roll back,
  and keep the working tree from piling up into one big unreviewable batch.
  Prefer many small checkpoint commits over one large one. (Branch/merge flow:
  see `docs/ROADMAP.md`.)
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
- **New logic that replaces/merges the feed window (`items`) must not
  hand-roll another copy of the `fetchingBefore`/`fetchingAfter`/`feedEpoch`
  guard pattern.** Six near-identical copies of this pattern already caused
  two shipped bugs (issues #35, #36, #39) — route through whatever shared
  helper exists from the modularization work tracked in issue #42 (or, if
  that hasn't landed yet, flag the duplication in review rather than adding a
  seventh copy).
