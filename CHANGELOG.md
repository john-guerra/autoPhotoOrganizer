# Changelog

Notable changes to AutoGallery, newest first. Versions follow the scheme in
`CLAUDE.md` (§ Versioning): every change bumps the patch (third) number, the
minor (second) number is bumped only when a new package is generated, and the
`-alpha` suffix stays until a stable release is cut. Entries are short and
user-facing — what you can now do, not how it's built.

## 2.9.3

- **Click to select, click to rate.** Every grid tile and the loupe now have a
  selection circle — click it to add/remove a photo from the selection without
  opening it (it appears on hover and on the focused tile, and stays solid once
  selected). In the loupe you can also click the star row to set a rating
  directly (click the same star again to clear). (usability testing)

## 2.9.2

- **Popups now close like popups.** The Loupe (full-photo view) has a visible ✕
  close button, and the Export panel can be dismissed with Escape, a click
  outside, or its own ✕ — it no longer stays stuck open. The Export panel and
  add-folder popover also stay on-screen when their button sits near a screen
  edge instead of spilling off. (usability testing)

## 2.9.1

- **Clearer first-run and folder controls.** An empty library now shows an
  "Add folder…" button instead of just a hint. The add-folder popover leads with
  a one-click "Choose folder to add…" picker and its manual-path button is now
  labelled "Add & scan". The toolbar "Library" button is now "Folders", and the
  grouping control has a visible "Group by" label. (usability testing)

## 2.9.0

- **First stable release — the `-alpha` pre-release tag is dropped.** AutoGallery
  is out of alpha. This packaged build bundles the recent round of work: dual
  "you are here" timeline markers, star ratings in the loupe filmstrip, undo
  failures now surfaced in the UI (never console-only), the sidebar refreshing
  after undo and after removing a folder, consistent group-label actions with a
  tri-state select-all, and sturdier snapshot-strip thumbnails.

## 2.8.27-alpha

- **The timeline now shows two "you are here" markers instead of one that
  wandered.** An amber marker pins to the photo you're focused on and stays put
  as you scroll; a separate grey eye marker tracks the top of what's currently on
  screen. When they line up they merge into one; scroll away and the eye marker
  splits off. Hover either for its date.

## 2.8.26-alpha

- **The loupe filmstrip now shows star ratings** — each thumbnail carries its
  ★-rating badge (bottom-right), alongside the existing ✓ selection mark, so you
  can see how your neighbours are rated without leaving the current photo.

## 2.8.25-alpha

- **A failed Undo now tells you what happened instead of silently doing
  nothing.** If undoing a move can't even reach the server (e.g. the move
  record is too large, or the connection drops), the jobs strip shows a
  specific message — "the move record was too large to send (N files) — retry
  from the jobs panel" — rather than failing only in the console (#89).

## 2.8.24-alpha

- **The sidebar now refreshes after Undo and after removing a folder from the
  feed.** Undoing a move-materialize (from the jobs strip) puts the folders
  back in the tree, and removing a folder group from the feed drops it from the
  tree right away — previously both left the sidebar showing stale folders until
  the next rescan.

## 2.8.23-alpha

- **Dropped the redundant per-group "Select" button** — the new select-all
  checkbox on each group label already selects (and deselects) the whole group,
  so the label now shows just the checkbox, Keep only, and Remove (issue #88).

## 2.8.22-alpha

- **Every group label now offers the same actions and a select-all checkbox,
  whether the group is expanded, shown as a snapshot strip, or collapsed.**
  Previously a collapsed group only had "Remove" and a snapshot group's actions
  were hidden. Each label gains a tri-state checkbox — empty, a dash when some of
  the group's photos are selected, or filled when all are — and clicking it
  selects or deselects the whole group at once (issue #88).

## 2.8.21-alpha

- **Snapshot-strip thumbnails no longer get stuck broken.** Collapsing groups to
  snapshot strips used to sometimes leave broken-image tiles that stayed broken
  until reload; strips now retry a failed thumbnail, fall back to the embedded
  preview, and only ever show a clear "unavailable" marker instead of a silent
  broken glyph. They also reuse the grid's already-cached thumbnails, so
  collapsing is faster and far less likely to fail (issue #90).

## 2.8.20-alpha

- Cleaned up accessibility warnings across the modals, loupe, sidebars, and
  filters (keyboard/screen-reader affordances; no visible change).

## 2.8.19-alpha

- Timeline capture-time filter upgraded to the latest zoomable-axis widget.

## 2.8.18-alpha

- Compact single-row group-by control keeps the top toolbar to one row (#82).

## 2.8.17-alpha

- New bottom status bar shows library/showing/selected counts, scan status,
  zoom, burst, and sort — freeing the top toolbar for actions (#82).

## 2.8.16-alpha

- **Timeline density reads truer to your shoots** — the date timeline now
  smooths less by default (finer bandwidth, more detail points, honest curve),
  so photo bursts and the quiet gaps between them stay visible instead of being
  blurred together — making album boundaries easier to spot. You can still
  retune it from the gear popover. (#82)

## 2.8.15-alpha

- **Expanding a collapsed group no longer flickers** — re-expanding a section
  you just collapsed now paints its already-loaded thumbnails instantly, instead
  of blanking every tile to a spinner and reloading the whole group over a second
  or two. The images were already in the browser cache the whole time; the tiles
  just weren't reusing them on the re-mount (#41).

## 2.8.14-alpha

- **The "Open a folder…" box now drops down from the Library menu** instead of
  floating in the toolbar — it's anchored right under the button that opens it.
  (Internal: completes the toolbar's move into focused components, issue #42.)

## 2.8.13-alpha

- **Internal: unified the grid focus/reveal logic** (issue #42, Step 2) — the
  seven near-identical `querySelector('[data-id=…]')` focus/scroll sites now go
  through two small shared helpers, so the `preventScroll` and
  not-yet-rendered-tile handling live in one place instead of being re-typed at
  each call. No visible change; fewer places for a focus/scroll bug to hide.

## 2.8.12-alpha

- **Windows installers build again** — the release workflow's electron-builder
  invocation mis-parsed a config flag on the Windows runner, so every Windows
  build failed; the setting moved into the build config and Windows `.exe`
  installers now ship alongside the macOS/Linux ones.
- **Accurate Move warning** — the Auto Albums "Move" note now reads "relocates
  the originals into the album folders (not a copy)", since Move defaults to
  organizing in place rather than moving files out of the folder.
- **Fixed: folders showed as offline on Linux** — the "mounted" check shelled
  out to a macOS-only tool and reported every folder as unavailable on
  Linux/Windows; it now uses a cross-platform presence check.

## 2.8.11-alpha

- **Album naming defaults to the folder you're in** — leave the naming
  template empty and albums are named `<folder>_1`, `<folder>_2`… after the
  folder you opened (or the one you're browsing); the `{prefix}` token is
  gone, replaced by this automatic default.
- **Move/Copy destination defaults to wherever you're looking** — even
  without an explicitly focused folder, Auto Albums now defaults the
  destination (and the naming above) to the folder implied by your current
  view.
- **The Auto Albums how-it-works modal only ever opens once** — previously it
  reopened after every app reload; now it's remembered for good (the ⚙
  Options button still opens it any time).
- **Materializing albums returns you to the normal feed** — after Move/Copy
  finishes and the destination is rescanned, Auto Albums closes automatically
  so you land back in the regular grid with the new folders visible.

## 2.8.10-alpha

- **Opening a photo from Auto Albums no longer loses your work** — clicking a
  photo in the album snapshots opens the loupe as an overlay; pressing `Esc`
  returns you to the album review with your split, names, and materialize setup
  intact (previously it dropped all of it).
- **Live materialize progress** — the jobs panel now shows a running
  "moved N / total" count that updates on every file, instead of a bar that
  only jumped every 50 files.
- **Move defaults to the folder you're viewing** — album subfolders are created
  directly inside the open folder; when no folder is focused the destination
  starts empty instead of a stale remembered path.

## 2.8.9-alpha

- **`{prefix}` naming token for albums** — the folder-naming template now
  supports a `{prefix}` token that starts out as the current folder's name
  (editable in the new **Prefix** field). It's in the default template
  (`%Y/%Y_%m%b_%d_{prefix}` → `2017/2017_01Jan_09_Diana_VR`); an empty prefix
  cleanly collapses the trailing separator to `2017/2017_01Jan_09`.
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
