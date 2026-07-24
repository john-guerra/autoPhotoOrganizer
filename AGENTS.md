# AGENTS.md

Cross-agent entry point for AutoGallery (works with Codex, Cursor, Copilot, and
any agent that reads `AGENTS.md`). **The authoritative, detailed guide is
[`CLAUDE.md`](./CLAUDE.md)** — read it first; it holds the invariants, the
hard-won Svelte/DOM traps, the feed-window transaction rules, and the testing and
usability contracts. This file is the short, tool-agnostic summary.

## What this is

Fast, local-first photo triage. Plug in an SD card → instant grid → keyboard-fast
culling → best photos organized into dated album folders. Svelte 5 (runes) + Vite

- d3 UI (`ui/`), Node/Express backend (`server/`), packaged with Electron.

## Two invariants (do not violate)

1. **Folders on disk are the source of truth.** There is never an owning catalog;
   the app reads/writes real folders and catches up on rescan.
2. **The SQLite index (`~/.autogallery/`) is a rebuildable cache + offline
   mirror**, keyed on path + mtime + size. Ratings live there so rating works
   offline; only export/moves need the drive mounted.

## Hard guardrails

- **Never modify, move, rename, or delete anything inside the user's real photo
  folders** unless explicitly asked in that conversation. Deletions must
  soft-delete (recoverable trash), never a hard delete.
- **Every file-serving endpoint routes user paths through
  `server/lib/safeResolve.js`** (path-traversal guard).
- **Never touch the real `~/.autogallery/` in tests** — use a temp
  `AUTOGALLERY_HOME` (see `docs/AGENT-NOTES.md`).

## Commands

- `npm run dev` — Express API (`:4321`) + Vite UI (`:5173`).
- `npm test` — vitest (unit). `npm run test:e2e` — Playwright.
- `npm run build` — Vite build. `npm run format` — prettier.

## Working agreement

- **Tests:** a fixed bug gets a test at the tier that would have caught it
  (vitest for pure logic, Playwright `e2e/` for DOM/seam/load-order bugs), in the
  same commit — and prove it fails without the fix.
- **Usability:** never fail silently; every user-triggerable failure surfaces a
  visible, specific, actionable message.
- **Keyboard-first:** every new/changed shortcut is documented in
  `ui/src/lib/ShortcutsOverlay.svelte` in the same commit.
- **Versioning:** every app change bumps `package.json` version + adds a
  `CHANGELOG.md` entry (see CLAUDE.md § Versioning).

See also: `docs/AGENT-NOTES.md` (operational notes), `docs/ROADMAP.md` (working
agreements), `docs/TESTING.md`, and the AI-coding review + readiness checklist in
`docs/`.
