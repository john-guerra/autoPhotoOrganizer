# AutoGallery — AI-Coding Readiness & Engineering Review

**Date:** 2026-07-24 · **Version reviewed:** v2.17.5 · **Method:** five independent
read-only audit agents, each covering one dimension, synthesized here.

Reviewed against the 2026 state-of-the-art brief
(`aiCoding_Course/docs/research/ai_coding_course_sota_2026.md`): the **harness**
lens (`Agent = Model + Harness`), spec-driven development (Fowler's
spec-first → spec-anchored → spec-as-source), verification-first culture, OWASP
LLM/Agentic + slopsquatting supply-chain, and HCI/approval-fatigue/inclusive
oversight. Nothing was modified during the review.

> Companion document: `docs/AI-CODING-READINESS-CHECKLIST.md` — the reusable,
> project-agnostic checklist distilled from this review.

---

## Bottom line

AutoGallery is **well above the 2026 AI-era baseline** — one of the better-instrumented
single-developer codebases for agentic work. The `CLAUDE.md` harness, bidirectional
spec↔code citations, 995 green tests with a real two-tier pyramid, a clean Svelte 5
migration, and a hardened security posture are all strong. Weaknesses cluster into
four themes, none of them a live exploit or a broken build:

1. **Portability** — the best knowledge lives *outside* the repo (Claude-only,
   invisible to CI / teammates / other agents).
2. **Doc freshness at the "start here" entry points** — the navigation surface has
   drifted, in a project that is otherwise honest about drift.
3. **One monolithic file getting worse** — `App.svelte` is 6,125 lines and *grew 34%*
   since it was first flagged.
4. **The keyboard-first app leaves screen-reader users behind**, and the headline RAW
   feature is a stub the current stack cannot deliver.

### Scorecard

| Dimension | Grade | One-line verdict |
|---|---|---|
| Harness readiness (agent-guide, guardrails) | **A−** | Excellent CLAUDE.md; knowledge isn't portable |
| SDD / agile process | **B+** | Real spec-anchored loop; `plans/` & ROADMAP have drifted |
| Code quality & testing | **B+** | 995 green tests, consolidated guards; App.svelte decaying |
| Security & CI/CD | **A−** | Hardened + injection-aware; no Dependabot/CodeQL |
| Usability (sighted) | **A** | "Never fail silently" is real and thorough |
| Accessibility (AT users) | **C** | Zero `aria-live`; fake-modal Loupe; mismatched grid ARIA |
| Stack suitability | **A−** | Right engines; RAW-preview goal unbuildable as assembled |

---

## ✅ Done correctly

**Harness / agent-guide (`Agent = Model + Harness`)**
- `CLAUDE.md` is a real harness asset, not boilerplate: it encodes traps *with the
  mechanism* (`$:`-on-`bind:this` → `safe_not_equal`; `|global` transition
  suppression; ResizeObserver loops), ties the consolidated feed-window guard to
  issue numbers (#35/#36/#39/#42), and carries a "verify the lowest layer first"
  debugging discipline drawn from a real multi-day bug chase.
- Layered, concrete guardrails: two invariants (folders are truth; SQLite is a
  rebuildable cache), a "never touch the user's real photo folders" rule *stricter*
  than the read-only-test convention, mandatory soft-delete, and a required
  `safeResolve.js` on file endpoints.
- **Honest about its own drift** — CLAUDE.md openly flags where docs lied (exiftool
  never used; RAW preview not built; content-hash inert) and tells the agent "trust
  the code over this bullet."

**Spec-driven development (spec-anchored)**
- The `docs/superpowers/specs/` → `plans/` → `completed_plans/` split is real, and
  citations run **both directions**: 15+ source files cite their spec by path, and
  the README marks which specs are "overtaken."

**Verification-first culture**
- `npm test`: **995 tests / 74 files, all green** (~20s). Server unit-test ratio is
  >1:1. 26 Playwright e2e specs cover the seams the app ships bugs in.
  `docs/TESTING.md` is honest ("619 unit tests stayed green while five bugs shipped").
- The feed-window guard is **structurally consolidated** — `withFeedTransaction` at 3
  sites, `loadMore` owns the one append-guard, no fourth hand-rolled copy. The bug
  class behind #35/#36/#39 is closed, not patched.
- Svelte 5 runes migration is **complete**: 0 `$:` (was 69), 1 `export let`
  remaining, 0 `createEventDispatcher`.

**Security & CI/CD (OWASP / slopsquatting lens)**
- Electron hardened: `contextIsolation:true`, `nodeIntegration:false`,
  `sandbox:true`, minimal `contextBridge` preload (`electron/main.js:38-43`).
- **Path traversal structurally avoided** — image endpoints serve by DB-looked-up
  `id` (`Number()`-coerced), not user paths; the one user-path *write* routes through
  `safeResolve`. Server binds loopback only.
- Injection-aware release YAML (refs via env vars, never inline `${{ }}`); two-phase
  draft release; lockfile committed; `npm ci` everywhere; **0 production
  vulnerabilities**; deps within a patch of latest.

**Usability & stack**
- "Never fail silently" is thorough for sighted users — nearly every `catch` sets a
  specific, actionable status/error; partial success reported honestly
  ("Revealed 1 of N"). `ShortcutsOverlay` parity with `onKeydown` holds.
  `Modal.svelte` is a textbook accessible native `<dialog>`.
- Stack is fit-for-purpose: better-sqlite3 (114k rows → ~1ms feeds via expression
  indexes), sharp/libvips (`UV_THREADPOOL_SIZE=16` tuned), ffmpeg-static, and a
  sound (non-speculative) `ProcessingService` seam.

---

## ⚠️ Needs improvement

**Portability — the best knowledge isn't in the repo** *(harness gap)*
- The agent memory system (release process, flaky specs, destructive-test isolation,
  local-linked packages) lives in `~/.claude/.../MEMORY.md` — **invisible to
  `git clone`, CI, teammates, and non-Claude agents.**
- **No `AGENTS.md`, no `.mcp.json`, no committed `.claude/settings.json` or
  skills/agents.** Zero portable surface for non-Claude agents; the
  delegate-to-cheaper-models and claude-in-chrome verification workflows are tribal
  knowledge, not checked-in assets.

**Doc freshness at the entry points** *(SDD drift)*
- `docs/ROADMAP.md` is CLAUDE.md's "**Start here**" but is ~30 versions stale — still
  narrating v0.1/v0.2 prototype status while the app is at 2.17.5.
- `plans/` violates its own lifecycle: `feed-scrubber.md` shipped and
  `skeleton-in-reserve.md` was built-then-reverted, yet both still sit in `plans/`.
  `completed_plans/` and `AUDIT-2026-07-13.md` are ~5 versions behind shipped work.

**Code decay concentrated in one file**
- `App.svelte` is **6,125 lines and grew ~34%** since the audit that named it the
  app's most bug-productive module (#124). Half of CLAUDE.md's most dangerous traps
  exist *because* everything lives here.
- **Documented-but-wrong seams:** `server/albums/README.md` advertises a "pure,
  framework-free" module, but that folder holds only the README — the real code is
  `ui/src/lib/albums.js` and it **imports d3**. `ProcessingService.js:8` still claims
  `exiftool-vendored`. `content_hash`/`backupCoverage` are inert yet guarded by a
  green test (a "green for the wrong reason" trap).

**The headline RAW feature can't be built on the current stack** *(stack-vs-goal)*
- "Never fully decode a RAW during culling" needs an embedded-JPEG-preview
  *extractor* — the stack has **none** (`exifr.thumbnail()` returns a ~160px thumb and
  throws on many RAWs; sharp can't decode most RAW; no `exiftool-vendored`/libraw/dcraw
  anywhere). The Loupe points `<img>` at `/api/image/:id` (the original), so a RAW is
  downloaded whole (25–50 MB) and can't be decoded by the browser at all.

**Accessibility — the keyboard-first app under-serves AT users** *(HCI gap)*
- **Zero `aria-live` in the entire `ui/src` tree.** `StatusBar.svelte` renders
  `{error||status}` in a plain `<span>` — all the "never fail silently" work is
  announced to sighted users only.
- The **Loupe is a fake modal**: `role="dialog" aria-modal="true"` on a plain div with
  no focus-move-in, trap, or restore. The correct fix (`Modal.svelte`'s native
  `<dialog>`) already exists one file over.
- The **grid ARIA is mismatched**: `role="listbox"` with `<button>` children lacking
  `role="option"`/`aria-selected`/`aria-activedescendant`.
- `prefers-reduced-motion` guarded in only **2 of ~8** transition-heavy components.

**Security & CI process gaps** *(none are live exploits)*
- **No Dependabot, no CodeQL, no scheduled `npm audit` gate** — the manual currency
  discipline has no automated backstop. *(Medium)*
- `safeResolve` uses string-containment, not `realpath` — a symlinked write
  destination could escape the promised root. *(Low; user picks the folder)*
- No CSP; no Electron `setWindowOpenHandler`/`will-navigate` deny. *(Low,
  defense-in-depth)*
- Minor: committed `.DS_Store` files, 4× duplicated `headerCounts={}` reset,
  `express.json({limit:"50mb"})`.

---

## 🎯 Recommendations — prioritized roadmap

**Quick wins (effort S)**
1. **Make the status bar a live region** — `role="status" aria-live="polite"` (+
   `assertive` on `error`) in `StatusBar.svelte`. One line; makes all the
   never-fail-silently work audible to AT users. Highest value-to-effort here.
2. **Refresh or demote `docs/ROADMAP.md`'s status section** and repoint CLAUDE.md's
   "Start here."
3. **Reconcile `plans/`** — move `feed-scrubber.md` to `completed_plans/`,
   annotate/delete `skeleton-in-reserve.md`.
4. **Add `.github/dependabot.yml` + CodeQL default setup + a prod-tree `npm audit` CI
   gate.**
5. **Fix small drift:** `ProcessingService.js:8` docstring, 4× `headerCounts` dup,
   `git rm` the `.DS_Store`s + gitignore.

**Medium (this month)**
6. **Add `AGENTS.md` + committed `.claude/settings.json`, and port durable
   `MEMORY.md` items into a checked-in `docs/AGENT-NOTES.md`.** Keep personal paths in
   the gitignored local doc.
7. **Give the Loupe real modal semantics** (rebuild on `Modal.svelte`'s `<dialog>` or
   add trap + focus-restore) and **fix the grid ARIA contract**.
8. **Add `exiftool-vendored` behind `ProcessingService.extractPreview`** — extract
   `PreviewImage`/`JpgFromRaw`, cache to disk, route thumb + Loupe RAW branches
   through it (~1 day; ship behind real RAW test material — 0 RAW files exist to test
   against today).
9. **Resolve the albums architecture drift** (move server-side per README, or delete
   the README and correct CLAUDE.md).
10. **Decide content-hash:** finish it (loop on `remaining` behind `whenIdle()`) or
    delete the column + its green test.
11. **Broaden `prefers-reduced-motion`**; restore visible `:focus-visible` on ring-less
    inputs.

**Larger (prioritize — long-term lever)**
12. **Extract the feed-window state machine + selection/undo out of `App.svelte` into
    framework-free `ui/src/lib/` modules (#124).** Converts the most bug-productive
    logic from slow-Playwright-only into plain vitest and caps a file growing
    34%/cycle. Do it *surgically* behind the existing `withFeedTransaction` seam — not
    a rewrite.

**Deliberately NOT recommended** (respecting a working single-dev app): Tauri rewrite,
DuckDB/LMDB, canvas/WebGL grid, custom-protocol backend. Real options, but unearned
against measured need — revisit only if memory footprint or scroll perf becomes a
user-reported problem.

---

## Mapping to the SOTA brief

- **Harness thesis** ("port knowledge into the harness") → CLAUDE.md is exemplary, but
  the memory system isn't yet a *repo* asset. → Rec 6.
- **Verification-first** → already strong; the `aria-live` gap (Rec 1) is the one place
  verification doesn't reach a whole user class.
- **Functional-but-insecure / GitClear code-decay data** → shows here as
  *maintainability* decay concentrated in `App.svelte`. → Rec 12.
- **Slopsquatting / lockfile-in-CI** → already done right; Rec 4 adds the automated
  backstop the brief calls standard.
- **HCI / approval-fatigue / inclusive oversight** → the UX over-serves power users and
  under-serves AT users. → Recs 1, 7, 11.
