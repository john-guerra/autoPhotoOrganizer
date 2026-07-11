# Changelog

Notable changes to AutoGallery, newest first. Versions follow the scheme in
`CLAUDE.md` (§ Versioning): each fixed issue bumps `package.json` by the change's
gravity, keeping the `-alpha` suffix until a stable release is cut. Entries are
short and user-facing — what you can now do, not how it's built.

## 2.7.0-alpha

- **Manual burst stacks**: select photos in one folder/day and right-click →
  "Create stack" to force them into a single stack even when their timestamps
  are too far apart to auto-group; right-click a mis-detected stack →
  "Dissolve stack" to break it apart, and those photos stay separate on future
  scans. Both choices persist. Keyboard: <kbd>G</kbd> groups the selection,
  <kbd>Shift</kbd>+<kbd>G</kbd> dissolves the stack at the cursor (#24).

## 2.6.0-alpha

- **Click to select, double-click to open** — a single click in the grid now
  selects a photo instead of jumping into the loupe; the loupe opens on a
  double-click or a second click on the already-selected photo, so you can click
  through the grid to pick shots without it taking over (#72).

## 2.5.0-alpha

- **Video support** — videos are scanned alongside photos, shown in the grid
  with a poster frame, a ▶ badge, and their duration, and play with scrubbing in
  the loupe (streamed on demand, so large clips open instantly) (#69).

## 2.4.2-alpha

- **Fixed: couldn't type an exact split gap** in Auto-albums — clicking the gap
  value now opens an editable field that keeps focus, so you can type e.g. `6h`,
  `2d`, `90m` and press Enter (#70).

## 2.4.1-alpha

- **Fixed: "Keep only" / "Select" on a group left earlier photos showing** when
  the feed was sorted by Created or Modified — the group scope now follows the
  same date the feed grouped by, so it narrows to exactly that section (#71).

## 2.4.0-alpha

- **Rename a folder from the feed** — double-click a folder's section header to
  rename it; the real folder on disk is renamed and the index follows (#68).

## 2.3.0-alpha

- **AutoAlbums: name your album folders** — edit each album's folder name before
  materializing, instead of accepting the auto-generated date (#68).
- **Materialize in place** — when you've opened a folder, the materialize
  destination now defaults to that folder, so "Move" organizes it into dated
  subfolders in one click (#68).

## 2.2.1-alpha

- **Fixed: packaged app failed to launch** with a `NODE_MODULE_VERSION`
  mismatch — the native database module was built for the wrong runtime. Builds
  (and CI releases) now rebuild it for Electron correctly (#67).

## 2.2.0-alpha

- **Open a folder** — focus the whole app (feed, tree, counts, albums) on a
  single folder and its subfolders, while the library total stays unscoped
  (#66).

## 2.1.0-alpha

- **Keyboard shortcuts overlay** — press `?` (or the topbar `?` button) to see
  every shortcut, grouped by grid and loupe (#26).
- **App version in the title** — the browser tab / Electron window title and the
  topbar now show the running version.

## 2.0.0-alpha

- **Reveal in Finder** — right-click a photo to open its real location in the OS
  file browser (#18).
- **Dev server picks a free port** — `npm run dev` no longer crashes when 4321
  is busy, and the packaged app no longer squats the dev port (#65).
- Initial v2 alpha: local-first triage — fast folder scan, justified virtualized
  grid, keyboard-first star rating, loupe with prefetch, time-gap album
  clustering, and Electron packaging.
