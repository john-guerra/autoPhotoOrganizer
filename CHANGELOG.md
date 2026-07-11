# Changelog

Notable changes to AutoGallery, newest first. Versions follow the scheme in
`CLAUDE.md` (§ Versioning): every change bumps the patch (third) number, the
minor (second) number is bumped only when a new package is generated, and the
`-alpha` suffix stays until a stable release is cut. Entries are short and
user-facing — what you can now do, not how it's built.

## 2.8.9-alpha

- **`{prefix}` naming token for albums** — the folder-naming template now
  supports a `{prefix}` token that starts out as the current folder's name
  (editable in the new **Prefix** field), so e.g. `%Y_{prefix}` gives you
  `2017_Diana` out of the box.
- **Token legend explains every naming token** — hovering (or reading) each
  token button in Auto Albums now shows what it means and an example
  (`%Y` → 4-digit year, `%n` → album number, etc.), plus a quick example under
  the template field.
- **Tab jumps between album names** — while renaming albums before
  materializing, Tab/Shift+Tab now moves straight to the next/previous
  album's name field instead of tabbing through every snapshot thumbnail.

## 2.8.8-alpha

- **Auto Albums, explained and configurable** — the old "Albums" button is now
  "Auto Albums" with a clear tooltip, and entering it opens a friendly setup
  dialog that explains how time-gap grouping works. The split gap now starts at
  a concrete **1 day** with an **Auto** button for the automatic
  (statistical) gap.
- **Custom folder naming for albums** — name albums from a template with date
  tokens (e.g. `%Y/%Y_%m%b_%d` → `2017/2017_01Jan_09`), including nested year
  folders, with a live preview of the resulting path.
- **Album names you type are kept** when you re-adjust the split gap (they no
  longer reset every time the boundaries move).
- **Modals modernised** — Manage Library and the keyboard-shortcuts panel now
  use the native dialog element, so `Esc` closes them, focus is trapped and
  restored, and they can't render half-off-screen. The Library and Add-folder
  menus now close when you click away or press `Esc`.

## 2.8.7-alpha

- **Fixed: two same-named albums no longer merge into one folder on
  materialize** — if two albums resolved to the identical destination name
  (e.g. a template collapsing two clusters to the same nested "2017/DCIM"),
  the server used to silently combine their photos into a single physical
  folder; it now disambiguates server-side (mirroring the Auto-albums
  panel's own collision handling) so each album always lands in its own
  folder.

## 2.8.6-alpha

- **Materialized albums index automatically** — after Auto-albums moves or
  copies photos to disk, the destination is rescanned right away so the new
  dated folders appear in the sidebar tree without a manual rescan.
- **Smart materialize destination + cross-volume warning** — Move now
  defaults the destination to the opened folder (in-place) while Copy
  defaults to the Desktop, and switching Move/Copy updates the default until
  you hand-type a path; a warning appears if a Move destination is on a
  different volume, since that copies every file instead of an instant move
 .

## 2.8.5-alpha

- **New "Folder name" group-by option** — group the feed by each folder's
  leaf name (e.g. `DCIM`) instead of its full path; smart disambiguation for
  same-named folders (e.g. `2017_DCIM`) is tracked separately (#81).

## 2.8.4-alpha

- **Backend groundwork for smart move/copy destination defaults** —
  `/api/system/paths` (home + Desktop) and `/api/system/same-volume` (cheap
  same-device check) are in place ahead of the setup-modal dest-picker wiring
 .

## 2.8.3-alpha

- **Big album exports no longer freeze the app** — organizing or exporting a
  large album now copies files in the background instead of locking up the
  window, so the UI stays responsive (and cancel keeps working) even on huge
  jobs.

## 2.8.2-alpha

- **Clear bursts across a whole selection** — with photos selected, `Shift`+`G`
  now dissolves every burst among them at once, not just the stack under the
  cursor. It's surgical: only the photos you selected leave their stacks (a
  partly-selected burst just shrinks), and loose photos you swept over are left
  alone so they can still auto-group on a later scan. With nothing selected it
  still dissolves the single stack at the cursor.

## 2.8.1-alpha

- **Loupe details panel & filmstrip** — the detail view now shows a right-hand
  panel with filename, dimensions, dates, camera and full EXIF (lens, aperture,
  shutter, ISO, focal length) and rating, plus a filmstrip of neighbouring
  photos along the bottom to jump between shots without leaving the view. Toggle
  each with `I` (details) and `F` (filmstrip); your choices are remembered
  (#27, #28).

## 2.8.0-alpha

- **Packaged build** bundling this round of feed fixes: "Keep only" now scopes
  cleanly to the chosen group (#75), expanding a collapsed group keeps its header
  in place and opens the whole group from the top (#74), and the Alt+←/→ group
  jump lands on the group's first photo in the current sort (#77).

## 2.7.5-alpha

- **Fixed: expanding a group showed only part of it** — a group now opens from
  its first photo and fills in as you scroll down, instead of loading only the
  tail end of the group (follow-up to #74).

## 2.7.4-alpha

- **Fixed: jumping to the next/previous group (Alt+←/→) landed mid-group** — the
  jump now selects the group's first photo in the current sort order, not
  whichever of its photos happened to have the lowest id (#77).

## 2.7.3-alpha

- **Fixed: "Keep only" on a group left the previous group's photos showing** —
  the feed now rebuilds against the scoped filter, so keeping a group narrows to
  exactly that group with no leftover tiles bleeding in from the section above
  it (#75).

## 2.7.2-alpha

- **Expanding a group no longer jumps the view** — opening a collapsed section
  now keeps its header exactly where it was on screen, with the group's photos
  growing downward below it, instead of scrolling off to another spot (#74).

## 2.7.1-alpha

- **Fixed: flicker when expanding a collapsed section** — a group's already-loaded
  thumbnails now reappear instantly instead of flashing a spinner and fading back
  in one by one (#41).

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
