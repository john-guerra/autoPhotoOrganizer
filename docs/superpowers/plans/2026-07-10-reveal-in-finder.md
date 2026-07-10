# Reveal in Finder (#18) — implementation plan

Spec: `docs/superpowers/specs/2026-07-10-reveal-in-finder-design.md`.
Branch: `feat/reveal-in-finder`. TDD: write the server test first, watch it fail,
then implement. UI verified live per the App.svelte convention.

## Step 1 — Server endpoint (TDD)

1. In `server/api.test.js`, add a `describe("POST /api/reveal/:id")` block with a
   mocked `node:child_process` `execFile`:
   - unknown id → `404`.
   - known id, missing file (stat throws) → `404`.
   - known id + present file, `process.platform === "darwin"` → `execFile`
     called once with `"open"`, `["-R", <path>]`; response `{ ok: true }`.
   - `win32` → `"explorer"`, `["/select,", <path>]`.
   - `linux` → `"xdg-open"`, `[<dirname>]`.
   - unsupported platform → `501 { ok: false }`.
   Run `npm test` — the reveal tests fail (endpoint absent).
2. Implement `POST /api/reveal/:id` in `server/api.js`:
   - import `execFile` from `node:child_process`, `dirname` from `node:path`
     (check existing imports first — `stat` and `extname` are already imported).
   - resolve id via `getPhotoById`; `stat` the path; dispatch on
     `process.platform`; `execFile(cmd, args)`; respond.
   - Keep launch fire-and-forget; only spawn errors (the `execFile` callback err
     for genuinely-failed spawns, not Explorer's non-zero exit) map to a 500.
   Run `npm test` — green.

**Checkpoint commit:** `feat(reveal): POST /api/reveal/:id server endpoint (#18)`.

## Step 2 — API client

Add `revealInFinder(id)` to `ui/src/lib/api.js` (POST, returns parsed body),
matching the existing fetch helpers there.

## Step 3 — `ContextMenu.svelte` (reusable, generic)

New `ui/src/lib/ContextMenu.svelte`:
- Props `x`, `y`, `items: [{ label, action, enabled }]`.
- `position: fixed`, clamped to `window.innerWidth/innerHeight` (measure after
  mount via `bind:this`, adjust if overflowing).
- Dismiss on click-away (window `mousedown` outside), `Escape` (window keydown),
  scroll (capture), and window `blur`. Dispatch `close` so the parent clears its
  state; also close after invoking an item's `action`.
- Disabled items rendered inert (no action, dimmed).

## Step 4 — Thumb + Loupe event surfaces

- `ui/src/lib/Thumb.svelte`: add bare `on:contextmenu` on the inner `<button>`
  (next to `on:click`).
- `ui/src/lib/Loupe.svelte`: `on:contextmenu` on `.stage` →
  `dispatch("contextmenu", { x: e.clientX, y: e.clientY })`, with
  `e.preventDefault()` so the native menu doesn't also show.

## Step 5 — Wire `App.svelte`

- Import `ContextMenu` and `revealInFinder`.
- State `contextMenu = { open: false, x: 0, y: 0, targetIndex: -1 }`.
- `onTileContextMenu(e, entry, i)`: `preventDefault`, set target `i`, open at
  `clientX/clientY`. Attach `on:contextmenu={(e) => onTileContextMenu(e, entry, i)}`
  to `<Thumb>`.
- Loupe: `on:contextmenu={(e) => openContextMenu(e.detail.x, e.detail.y, selected)}`.
- `reveal(index)`: resolve photo; if numeric id, `await revealInFinder(id)`; on
  `!ok`, non-blocking notice (reuse any existing toast; else `console.warn` +
  a transient status line — no `alert`).
- Render `{#if contextMenu.open}<ContextMenu ... items={[{ label: "Reveal in Finder",
  action: () => reveal(contextMenu.targetIndex), enabled: <resolves to id> }]}
  on:close={() => (contextMenu.open = false)} />`.

**Checkpoint commit:** `feat(reveal): right-click "Reveal in Finder" context menu (#18)`.

## Step 6 — Verify live

`npm run dev`, right-click a grid thumbnail and a loupe photo → Finder opens with
the file highlighted. Verify menu clamps at the viewport edge and dismisses on
Escape/click-away/scroll. Confirm no `alert` path. Then update ROADMAP if needed
and open the PR.

## Risks / notes

- `execFile` mocking: ensure the test mocks the module the endpoint imports
  (`vi.mock("node:child_process")`), and restores `process.platform`
  (defined via `Object.defineProperty`) after each case.
- Explorer non-zero exit must not surface as an error to the client.
