# Reveal in Finder (#18) — design

_2026-07-10. Implements GitHub issue #18. Read with `CLAUDE.md` and
`docs/ROADMAP.md`._

## Goal

Give the user a one-action escape hatch to the real file on disk: open the
selected photo's actual location in the OS file browser (macOS Finder, Windows
Explorer, Linux file manager) so they can do anything the app doesn't yet
support — rename, move manually, inspect in another tool. This is _show me where
this already lives_; it performs **no** file operations (distinct from #5,
Export to `_selected/`).

## Invariants respected

- **Folders on disk are the source of truth.** Reveal only reads a path from the
  index and asks the OS to highlight it; it never writes, moves, or deletes.
- **Never touch the user's photo files.** Reveal launches a file-manager process
  pointed at the file; it does not modify the file or its folder.

## Trigger: right-click context menu

The action is invoked from a **right-click context menu**, not a keyboard
shortcut or a dedicated button. This is deliberately the same menu surface that
issue #25 (multi-select + right-click context menu) will own.

To avoid #25 rebuilding this later, the menu is a small, reusable
`ContextMenu.svelte` component seeded with a **single item** here. Its item list
is data (`[{ label, action, enabled }]`), so #25 extends it by pushing more
items and wiring multi-select — no rewrite. **This design partially lands #25's
menu surface; #25 should build on `ContextMenu.svelte`, not replace it.**

Multi-select (`X` / `toggleSelect` / `selectedIds`) already exists in
`App.svelte`; only the menu surface is new.

## Server

New endpoint `POST /api/reveal/:id` in `server/api.js`, beside `/api/rating`:

1. `getPhotoById(db, Number(req.params.id))` → `404` if the id is unknown (same
   guard `/api/image/:id` uses).
2. `await stat(it.path)` → `404` if the file is absent (offline drive, or moved
   in Finder since the last scan). Reveal is honest about its one hard
   dependency: the file must be present on a mounted volume.
3. Launch the platform file manager with `execFile` — **args array, never a
   shell string** (injection-proof regardless of the path's contents):
   - `darwin` → `execFile("open", ["-R", it.path])`
   - `win32` → `execFile("explorer", ["/select,", it.path])` — Explorer's
     `/select,` syntax highlights the file; Explorer routinely exits non-zero
     even on success, so a non-zero exit is **not** treated as failure on
     Windows.
   - `linux` → `execFile("xdg-open", [dirname(it.path)])` — there is no portable
     "select this file" call on Linux, so open the containing folder. This is a
     genuine platform limitation, documented, not a shortcut.
   - any other platform → `501` `{ ok: false, error: "unsupported platform" }`.
4. Respond `{ ok: true }` once the process spawns; `{ ok: false, error }` with an
   appropriate status otherwise. Fire-and-forget: success means the file manager
   _launched_, not that it stayed open.

No `safeResolve` is needed: the path comes from the trusted SQLite index (via
`getPhotoById`), not from a user-supplied path segment — exactly like
`/api/image/:id`. The id is the only user input, and `getPhotoById` validates
it against the index.

## UI

### API client — `ui/src/lib/api.js`

Add `revealInFinder(id)` → `POST /api/reveal/:id`, returning the parsed
`{ ok, error }` body.

### `ContextMenu.svelte` (new, presentational)

- Props: `x`, `y`, `items` where `items = [{ label, action, enabled }]`.
- Renders `position: fixed` at `(x, y)`, **clamped to the viewport** so it never
  overflows the right or bottom edge.
- Dismisses on: click-away, `Escape`, scroll, and window blur.
- Clicking an enabled item calls its `action` then closes; disabled items are
  inert.
- Emits nothing app-specific — it is generic so #25 can reuse it verbatim.

### `Thumb.svelte`

Add bare `on:contextmenu` forwarding on the inner `<button>` (mirrors the
existing bare `on:click`), so `App.svelte` can listen with
`<Thumb on:contextmenu={...}>`.

### `Loupe.svelte`

Add `on:contextmenu` on the `.stage` that `dispatch("contextmenu", { x, y })`
with the cursor coordinates, so the same menu opens over the full-screen photo.
Loupe stays presentational — it dispatches, it does not call the API.

### `App.svelte` wiring

- State: `contextMenu = { open, x, y, targetIndex }`.
- `onTileContextMenu(e, entry, i)`: `preventDefault()`, set `targetIndex = i`,
  open the menu at `e.clientX/clientY`. In the loupe, the dispatched
  `contextmenu` sets `targetIndex = selected`.
- Menu items: `[{ label: "Reveal in Finder", action: () => reveal(targetIndex),
enabled: <photo resolves to a real id> }]`.
- `reveal(index)`: resolve the photo at `index`; if it has a numeric id, call
  `revealInFinder(id)`. On a non-ok response, show a brief **non-blocking**
  notice (toast/console) — **never `alert()`**, which would freeze the Electron
  `webContents` (project rule).

## Transport rationale (why a server endpoint, not Electron IPC)

The Express server always runs on the user's local machine in **both** modes:
the dev browser at `localhost:5173` proxying `:4321`, and the packaged Electron
app's embedded server. So `open -R` executed server-side reveals in the user's
Finder in both cases, with zero preload/IPC changes, reusing the id→path lookup
the server already owns via `getPhotoById`. An Electron-IPC route would work
only in the packaged app and would duplicate that lookup in `electron/main.js`.

## Testing

- `server/api.test.js` (vitest), with `node:child_process` `execFile` mocked:
  - unknown id → `404`.
  - known id but missing file → `404`.
  - known id + present file on `darwin` → spawns `open` with
    `["-R", <path>]`.
  - per-platform command selection (`darwin` / `win32` / `linux` / other) picks
    the right command and args.
- The right-click UX is verified live in-browser per the App.svelte convention
  in `docs/ROADMAP.md`, not unit-tested.

## Out of scope (deliberate)

- Multi-select-aware reveal (reveal N files) — belongs with #25.
- Additional menu items ("Open with…", "Copy path", export actions) — #25 and #5.
- Highlighting the specific file on Linux (platform limitation).
