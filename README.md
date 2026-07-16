# AutoGallery

Fast, local-first photo triage. Plug in an SD card, get an instant grid, cull
with the keyboard, and organize the best shots — without the slowness of
Lightroom or a dead app like Picasa.

Two principles drive the design:

1. **Folders on disk are the source of truth.** There is no owning catalog —
   AutoGallery reads and writes real folders, and catches up automatically if
   you move files around in Finder.
2. **The index is a rebuildable, persistent cache on your internal disk**, so
   you can browse previews, metadata, and ratings even with the external
   drive unmounted (offline). Only export/moves/resizes need the drive
   mounted.

## Features

- **Instant grid** — a justified (Flickr-style) layout that appears while
  scanning continues in the background; virtualized so DOM node count stays
  flat regardless of folder size (tested at 10,000+ photos).
- **Keyboard-first culling** — star ratings (`1`–`5`, `0` clears) with
  auto-advance, arrow-key grid navigation, a loupe (detail view) with
  prefetch for instant back/forth.
- **Burst stack detection** — photos taken within a configurable time gap are
  automatically grouped into collapsible stacks with a peeking-photos visual;
  press `C` to manually override which photo is the cover.
- **Auto albums** — cluster a shoot into albums by the pauses between shots,
  preview the boundaries, then move or copy the keepers into dated folders
  (photos and videos together).
- **Filter & organize** — filter the feed by rating, orientation, or camera;
  group by folder, day, month, year, camera, or kind; sort by date, rating,
  size, or name.
- **Timeline scrubber** — a D3 date histogram of the working set; brush a
  range to narrow the feed to a trip or a day.
- **Tree & fisheye sidebars** — navigate the library hierarchy, with the group
  you're currently in marked so you never lose your place; right-click a
  section header for the same actions the folder tree offers.
- **Missing-files review** — when a photo leaves disk, AutoGallery tells you and
  opens a panel to relocate it (keeping its rating, albums, and tags) or dismiss
  it; simple moves are relocated automatically.
- **Reveal in Finder** and a native OS folder picker in the desktop app.
- **A library of scanned folders**, persisted across sessions, with an
  offline badge for folders on a removable drive that isn't currently
  mounted.
- **Runs two ways**: as a local dev server in your browser, or as a native
  desktop app (Mac/Windows/Linux) with a real OS folder picker.

## Status

v2 is stable and in active use (currently **2.16.x**, built on **Svelte 5
(runes)** with an up-to-date dependency stack). Shipped so far: folder scanning,
thumbnail generation with an on-disk cache, star ratings, the loupe, the
justified + virtualized grid, burst-stack detection with manual cover override,
auto-album clustering with move/copy into dated folders, feed filtering and
grouping, a D3 timeline scrubber, tree + fisheye sidebars, missing-files review,
a persisted folder library with offline browsing, and Electron packaging with a
native folder picker. See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for the full
status and backlog (tracked in
[GitHub Issues](https://github.com/john-guerra/autoPhotoOrganizer/issues)).

The two previous generations of the app are archived under
[`legacy/`](./legacy/) for reference — **do not run them** (they contain
known insecure patterns, including the Electron anti-patterns this rewrite
deliberately avoids). They exist to port the album-clustering algorithm into
v2.

## Quick start

Requires Node.js >= 22.

```bash
npm install
npm run dev
```

This starts the Express API on <http://localhost:4321> and the Vite UI on
<http://localhost:5173>. Open the UI, paste in (or type) a folder path, and
scan.

### Running as a desktop app

```bash
npm run electron:dev
```

Opens the same app in a real Electron window, with a native "Choose
Folder…" button (native OS dialog) instead of typing a path.

To build an installable package for your platform:

```bash
npm run electron:build:mac   # local smoke-test build (macOS) → release/
npm run electron:build       # mac + win + linux (needs Wine for Windows, when run from macOS)
```

Builds land in `release/` (e.g. `AutoGallery-2.16.1.dmg`).

### Running a packaged build without code signing

AutoGallery is **not signed** with a paid Apple Developer ID or Windows
code-signing certificate (Apple notarization / Windows signing aren't set up —
see
[`docs/superpowers/specs/2026-07-06-electron-packaging-design.md`](./docs/superpowers/specs/2026-07-06-electron-packaging-design.md)).
Each OS therefore warns you the first time you open it. These are one-time steps
per download — here's how to run it anyway on each platform.

**macOS** (`.dmg` / `.zip`) — the app is only _ad-hoc_ signed
(`codesign --sign -`, which is required so the kernel doesn't kill it on Apple
Silicon, but can't vouch for who built it):

- **Right-click** (or Control-click) `AutoGallery.app` → **Open** → **Open** in
  the dialog. First launch only; after that it opens normally by double-click.
- If macOS says **"AutoGallery is damaged and can't be opened"** (what a
  quarantined download shows on Apple Silicon), clear the quarantine flag, then
  open it:
  ```bash
  xattr -cr /Applications/AutoGallery.app
  ```
  (`-c` clears extended attributes, `-r` recurses into the bundle; the
  `com.apple.quarantine` flag is what triggers the block.)
- Or go to **System Settings → Privacy & Security**, find the blocked-app
  notice, and click **Open Anyway**.

**Windows** (`.exe`, NSIS installer) — unsigned, so Microsoft SmartScreen steps
in:

- When you see **"Windows protected your PC"**, click **More info → Run anyway**.

**Linux** (`.AppImage`) — no signing concept; just make it executable:

```bash
chmod +x AutoGallery-2.16.1.AppImage
./AutoGallery-2.16.1.AppImage
```

If it complains about FUSE, either install `libfuse2` or run it with
`./AutoGallery-2.16.1.AppImage --appimage-extract-and-run`.

### Other commands

```bash
npm test       # run the test suite (vitest)
npm run build  # build the UI to dist/ (served by Express in production)
npm run format # prettier
```

## Keyboard shortcuts

| Key               | Action                                                 |
| ----------------- | ------------------------------------------------------ |
| `←` `→` `↑` `↓`   | Move selection in the grid                             |
| `Home` / `End`    | Jump to first / last photo                             |
| `Enter` / `Space` | Open the loupe (or expand/collapse a burst stack)      |
| `Esc`             | Close the loupe / collapse the expanded stack          |
| `1`–`5`           | Rate the selected photo (auto-advances)                |
| `0`               | Clear the rating                                       |
| `C`               | Set/unset the current photo as its burst stack's cover |
| `+` / `-`         | Zoom the grid density                                  |

## Architecture

- **Backend: Node.js.** All photo decode/extract work sits behind a
  `ProcessingService` interface (`server/processing/`), so the engine can be
  swapped (native → WASM → Python ML sidecar) without touching the
  scanner, index, or UI. `server/albums/` is a pure, framework-free module
  for time-gap-based album clustering.
- **Frontend: Svelte + D3 (Vite).** Virtualized grid, loupe, keyboard-first
  rating, D3 timeline for album boundaries.
- **Desktop shell: Electron.** `electron/main.js` (ES modules) wraps the
  same Express server unmodified; `electron/preload.cjs` stays CommonJS
  (Electron's sandboxed preload loader can't run ESM — verified directly).
  Security: `contextIsolation`, no `nodeIntegration`, sandboxed, exposing
  exactly one `contextBridge` method for the native folder picker.
- **Persistence:** everything AutoGallery writes lives under
  `~/.autogallery/` on your internal disk — a rebuildable cache/index, never
  the source photo folders. Ratings, cover choices, the metadata cache, the
  thumbnail cache, and the scanned-folders library are all stored there.

See [`CLAUDE.md`](./CLAUDE.md) for the full set of conventions and
invariants, and
[`docs/superpowers/specs/2026-07-06-photo-triage-design.md`](./docs/superpowers/specs/2026-07-06-photo-triage-design.md)
for the original design doc (architecture, performance strategy, and the
Phase 2 plan for faces / CLIP search / ML pick prediction).

## Testing

```bash
npm test
```

Tests are colocated as `*.test.js` next to their sources under `server/`
and `ui/src/`, using [Vitest](https://vitest.dev/). Layout and windowing
logic are pure functions, unit-tested against synthetic data; the server
API is tested end-to-end against a real ephemeral-port Express instance
with real generated images (no mocks).

## License

MIT — see [`LICENSE`](./LICENSE).
