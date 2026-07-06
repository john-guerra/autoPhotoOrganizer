# Electron packaging shell + native folder picker — Design

Status: Approved, ready for implementation plan
Date: 2026-07-06

## Context & problem

Two problems turned out to be the same problem:

1. **Issue #7 (Folder selector UI)** — `ui/src/App.svelte`'s path input is a
   raw text field. No browser API (`<input type="file" webkitdirectory>`,
   `showDirectoryPicker()`, drag-and-drop) can hand JavaScript an absolute
   OS filesystem path — that sandboxing is intentional and applies equally
   to all of them. Since the server runs exiftool/sharp/ffmpeg directly
   against real files (the "folders on disk are the source of truth"
   invariant in `CLAUDE.md`), a picker that only yields browser-sandboxed
   file handles doesn't help — it would mean uploading photos through the
   browser instead of reading them zero-copy off disk, which breaks the
   performance thesis outright.
2. **Distribution to other users is now a hard requirement.** Today,
   running this app means `git clone` + `npm install` + `npm run dev` in a
   terminal — not viable for a non-technical end user regardless of how
   folder selection works. Some form of packaged, installable app (Mac +
   Windows) is needed.

Electron solves both at once: its main process is a genuine Node.js
process, so it can run the existing Express server unmodified and expose a
real native OS folder dialog to the renderer.

## Decision: Electron shell wraps the existing app unchanged

This is **not** a rewrite. `server/` (Express app, `ProcessingService`,
album clustering, `safeResolve.js`) and `ui/` (Svelte + Vite) stay exactly
as they are. Electron adds one new, small layer: a main process that starts
the existing Express server (`createApp()` from `server/index.js`, already
loopback-only) and opens a `BrowserWindow` pointed at it.

### Alternatives considered and rejected

- **Tauri.** Native shell is Rust, not Node — there is zero Rust anywhere
  in this codebase, and the existing backend is deeply Node-specific
  (exiftool-vendored, sharp, ffmpeg bindings). Porting it to Rust is a
  large rewrite for no offsetting benefit; running Node as a Tauri
  "sidecar" process instead keeps the rewrite-avoidance but gives up
  Tauri's main advantage (small bundle, no bundled Chromium) while adding
  a second runtime and a new language to the toolchain.
- **Bundle the Node server as a single executable (`pkg` / Node's SEA
  feature) + auto-open the default browser.** Avoids Chromium's ~150 MB
  footprint, but reinvents native dialogs, menus, and auto-update from
  scratch, and reads as "a background process with a browser tab," not a
  real app — worse fit for distributing to non-technical users, which is
  the explicit goal.
- **Custom in-app directory browser** (`fs.readdir`-based tree popover) and
  **shelling out to a per-OS native dialog** (`osascript` on Mac,
  PowerShell's `FolderBrowserDialog` on Windows) were both explored before
  packaging became a hard requirement. Both are superseded now:
  `dialog.showOpenDialog` gives one native, cross-platform picker API for
  free once Electron exists, so building or maintaining either alternative
  adds cost with no remaining benefit.

## Security model — do not repeat legacy's mistakes

`legacy/2024-electron-standalone/main.js` (read as reference only, never
run) used `nodeIntegration: true`, no `contextIsolation`, and forced
DevTools open — full Node and filesystem access exposed directly to
whatever content the renderer loads. This is precisely the pattern
`CLAUDE.md` flags as "known insecure patterns," and the new shell must not
repeat it.

New shell's `webPreferences`:

```js
{
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: path.join(__dirname, "preload.js"),
}
```

No `remote` module. `preload.js` exposes exactly one method via
`contextBridge`, matched to the one native capability the renderer actually
needs:

```js
contextBridge.exposeInMainWorld("autogallery", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
```

Main process handles `pick-folder` by calling
`dialog.showOpenDialog({ properties: ["openDirectory"] })` and returning the
chosen absolute path, or `null` on cancel. Every other existing feature
(scan, thumbnails, ratings, cover choices) continues to go through the
existing HTTP API to the Express server exactly as today — Electron does
not introduce a second communication channel for those, and the loopback-only
bind (`127.0.0.1`, already in `server/index.js`) is unchanged.

## Dev mode vs. packaged mode

- **Dev (unchanged):** `npm run dev` still runs Express + Vite concurrently
  exactly as today; John keeps verifying at `localhost:5173` in an ordinary
  browser — this is explicitly the fast feedback loop the working
  agreements protect, and Electron must not get in its way.
- **Electron dev:** a new `npm run electron:dev` starts the same two
  processes and additionally opens an Electron `BrowserWindow` pointed at
  `http://localhost:5173` (Vite's dev server, which already proxies `/api`
  to Express per `ui/vite.config.js`) — used only when specifically
  exercising the Electron shell (native picker, packaging smoke-test), not
  for everyday UI iteration.
- **Packaged (prod):** Electron's main process calls `createApp().listen()`
  directly (the same code path that serves the built `dist/` today) and the
  `BrowserWindow` loads `http://127.0.0.1:PORT`. No `file://` loading, no
  divergent prod code path in `server/` or `ui/`.

## Folder picker integration (closes #7)

`App.svelte`'s topbar keeps the manual path `<input>` — useful for power
users, automation, and non-Electron dev-mode browsing where no native
dialog exists — and gains a "Choose Folder…" button next to it. The button
is feature-detected (`window.autogallery?.pickFolder`), so it only appears
when running inside the Electron shell:

```js
async function chooseFolder() {
  const path = await window.autogallery?.pickFolder();
  if (path) {
    dir = path;
    doScan();
  }
}
```

## Library: tracked folders with offline detection

Per the original ask ("keep track of the folders/albums in the current
library... supports removable drives"): a small persisted list of
previously-scanned absolute paths, stored the same way `ratings.json` and
`coverChoices.json` already are (`~/.autogallery/library.json`), so it
follows the existing "cache root on the internal disk" pattern rather than
introducing a new storage mechanism.

- Each entry: `{ path, name, lastScannedAt }`.
- "Choose Folder…" (or typing a path and scanning) adds/updates an entry,
  de-duplicated by absolute path.
- The topbar's folder control shows this list (e.g. a dropdown below the
  input/button); each entry checks `fs.existsSync(path)` — via a small
  `/api/library` endpoint, since the renderer cannot stat paths itself —
  and shows an **offline** badge when the path doesn't currently resolve
  (SD card unmounted). This directly mirrors the offline-mirror language
  already established for the SQLite cache in `CLAUDE.md`'s second
  invariant — same mental model, applied to the folder list instead of the
  metadata cache.
- Clicking a non-offline entry sets `dir` and scans it, same as today.
- No removal UI in this first cut (see Out of scope) — entries are additive
  only for now.

## Packaging & distribution

- `electron-builder` for both build config and installers: `dmg`/`zip` +
  notarization for macOS, `nsis` for Windows, `AppImage` for Linux.
  Linux is the cheapest of the three to add — no notarization, no
  code-signing required — so it's included from the start rather than
  deferred.
- `electron-updater`, publishing to GitHub Releases (the repo is already
  hosted there) — avoids standing up separate update infrastructure.
  `electron-updater` supports all three platforms against the same
  GitHub Releases provider.
- `dialog.showOpenDialog` (the folder picker) is natively cross-platform,
  including Linux (GTK/Qt dialogs under the hood) — no extra code needed
  for the picker itself beyond what's already specified above.
- Real costs to accept, not solved by this doc: an Apple Developer Program
  membership is required for macOS notarization, and a Windows
  code-signing certificate is needed to avoid SmartScreen warnings (a
  self-signed cert works but keeps the warning). Both are account/billing
  decisions for John to make when packaging is actually built, not a
  technical blocker. Linux has no equivalent cost.
- App icon, exact `electron-builder` config per platform, and CI for
  building all three targets are implementation-plan detail, not design
  detail.

## Testing

- `server/` and `ui/` component logic are unaffected and keep their
  existing vitest coverage.
- The Electron main process (dialog invocation, IPC wiring) is not
  meaningfully unit-testable under vitest — verified manually by running
  `electron:dev` and confirming the native dialog opens, returns a path,
  and triggers a scan.
- New: a `/api/library` route (list entries + resolve offline status) gets
  the same vitest coverage style as the rest of `server/api.js`.

## Out of scope

- Removing/editing library entries, reordering, or showing per-entry photo
  counts — first cut is additive-only; a fast-follow once the basic list
  is in daily use.
- Auto-update rollout mechanics (staged rollout, release channels) beyond
  wiring `electron-updater` to GitHub Releases.
- Any change to the multi-folder "library feed view" backlog item (#16) —
  this library list is a flat recents/shortcuts list, not that browsing
  experience.
