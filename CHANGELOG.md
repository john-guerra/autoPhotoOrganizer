# Changelog

Notable changes to AutoGallery, newest first. Versions follow the scheme in
`CLAUDE.md` (§ Versioning): every change bumps the patch (third) number, the
minor (second) number is bumped only when a new package is generated, and the
`-alpha` suffix stays until a stable release is cut. Entries are short and
user-facing — what you can now do, not how it's built.

## 2.10.1

- **Critical-path UI tests.** Rating a photo — the thing the app is for — is now
  covered end to end: 1–5 and 0 survive a reload, loupe stars survive a reload, a
  rating lands on the photo you meant and not its neighbour, and typing digits in
  a text box can't silently re-rate. Nested groups are covered too: folding a
  child, folding a parent, and snapshotting a parent are each a crash that shipped
  during 2.9.x, and each is now a test (#101).
- **Every keyboard shortcut is in the help menu.** ⌘/Ctrl+A (select everything
  shown) was missing from `?`, and Alt+←/→ now says what it really does — jumps to
  the previous/next group, and at the edges to the first/last photo.
- **Docs:** `docs/TESTING.md` — the two test tiers, what belongs in each, and how
  to write a spec that fails for the right reason.

## 2.10.0

- First packaged build of the usability round: selection circles, clickable
  stars, ⌘A, a media-type filter, reveal a whole selection, a resizable tree
  sidebar that starts expanded, VS Code-style group folding, dendrogram nesting,
  a compact Group by, selection actions in the status bar, and an export that can
  **move** files instead of copying (undoable).
- **Reliability:** a loud banner when the backend dies, with auto-reconnect that
  puts you back where you were; uncaught errors now surface in the app instead of
  only the console; fixed the crash when collapsing a nested group.

## 2.9.25

- **Automated UI testing (developer-facing).** The project now has a second test
  tier: real browser, real clicks (Playwright), on a throwaway library of its own.
  `npm run test:unit` (fast) / `npm run test:e2e` (UI) / `npm run test:all`. The
  first six tests each lock in a bug that actually shipped during this batch.

## 2.9.24

- **Fixed: collapsing a group in the feed threw an error** (a regression
  introduced by the 2.9.21 performance change).

## 2.9.23

- **Shift-folding a big group now says it's working** instead of looking frozen,
  and a second click can't start a competing fold.
- **Fixed: expanding the tree could silently stop part-way** if a folder's
  children were already being fetched.

## 2.9.22

- **Reconnecting no longer sends you back to the top.** After the server restarts,
  the app reloads around the photo you were on instead of jumping to the start of
  the library.
- **Reveal failures are now shown as errors**, not as a status message that the
  next action wipes out — including "too many files to reveal at once".
- **Windows: revealing several files now admits it only highlights one** (Explorer
  can't select more), instead of reporting that it revealed them all.

## 2.9.21

- **Faster feed rendering with many collapsed groups.** Working out how each group
  is drawn was re-scanning the whole collapsed list (with a JSON compare) several
  times per header on every render — noticeable after Collapse-all or folding a
  big tree. It's now a single lookup.

## 2.9.20

- **Fixed: "Remove" did nothing on folder-name groups.** The button was offered
  (2.9.13) but the handler only accepted full-path folder groups, so clicking it
  silently did nothing. It now works — and says so if a group isn't a folder.
- **Fixed: clicking a folded group in the tree jumped to the wrong place.** If the
  group was showing a snapshot (or collapsed), the feed skipped it and landed on
  the next group's photos. It now lands on the group itself.
- **The tree sidebar starts fully expanded**, so the library map is visible
  without unfolding it node by node.

## 2.9.19

- **Fixed: hovering a group title blew the header up.** Hovering a section header
  made it grow to five times its height, shoving the photos down and clipping the
  first row. A CSS cleanup in 2.9.18 had accidentally eaten the `opacity: 1`
  hover rule for the header's action buttons, so they inherited the empty-state's
  `padding: 4rem` instead. (usability testing)

## 2.9.18

- **A group now always has exactly one label.** Collapsing or snapshotting a group
  used to replace its header with a different row that drew its own duplicate
  label — which is why a snapshot ignored the group's indentation. Now the header
  stays put and only its icon changes; the snapshot strip is just content beneath
  it, indented under its own group like the photos are. (usability testing)
- **How a group's photos are drawn is now pluggable** — grid, snapshot strip and
  collapsed are entries in a registry, so new photo widgets can be added without
  touching the header, the cycle, the sidebar or the layout. See
  `docs/superpowers/specs/2026-07-12-group-photo-renderers.md`.

## 2.9.17

- **Nested groups now really look nested.** The dendrogram lines actually connect
  (they were being painted over by the sticky headers), and a sub-group's
  **photos are indented under their own header** too — along with its snapshot
  strip and collapsed pill — instead of every row starting at the left margin.
  (usability testing)

## 2.9.16

- **Nested groups now look nested.** With more than one grouping level, each
  sub-group is indented under its parent and joined to it by dotted dendrogram
  lines, so you can see the hierarchy at a glance instead of a flat stack of
  headers. (usability testing)

## 2.9.15

- **The app now tells you when the server is gone.** If the backend crashes or
  restarts, a banner says so ("what's on screen may be out of date"), the app
  keeps retrying with backoff, and it reloads itself automatically as soon as the
  server is back — instead of silently showing stale data while fetches failed in
  the console. There's a "Retry now" button too. (usability testing)
- **Server code now hot-restarts in development** (`node --watch`), so backend
  edits no longer need a manual restart.

## 2.9.14

- **Shift+click a group to fold its subgroups** — like function folding in VS
  Code. A plain click collapses the group as one block; Shift+click leaves the
  group open and folds every subgroup underneath it instead. Works from the feed
  headers and the tree sidebar. (usability testing)
- **Fixed: collapsing a parent no longer leaves its children collapsed too.**
  Snapshotting (or collapsing) a group whose child was already snapshotted used
  to draw two strips; the parent's state now supersedes its children's.
  (usability testing)

## 2.9.13

- **Fixed: collapsing a nested group crashed the feed.** With two grouping levels
  (e.g. Type › Folder), collapsing the outer group threw and left the feed blank.
  Collapsed groups only carry the levels down to where they were collapsed, and
  the header code assumed every level was always present. (usability testing)
- **Errors now show up in the app, not just the console.** Anything that escapes
  — a rendering crash, a failed background task — is surfaced in the status line
  with what broke and what to try, instead of silently blanking the view.
  (usability testing)
- **Jump to the next/previous group from a group label** — new ‹ › buttons, the
  mouse equivalent of Option+←/→. (usability testing)
- **Option+←/→ at the first/last group** now jumps to that group's first/last
  photo instead of doing nothing. (usability testing)
- **"Remove" is now offered on folder-name groups too**, not just full-path
  folder groups. (usability testing)

## 2.9.12

- **One icon for a group's state, everywhere.** The tree sidebar, the feed's
  section headers, the snapshot strip and the collapsed pill now all show the
  same tri-state icon — a full grid, a snapshot strip, or a collapsed bar (amber
  once it isn't showing in full) — and clicking it cycles the group the same way
  from either place. The sidebar previously only knew "collapsed" and missed the
  snapshot state entirely. (usability testing)

## 2.9.11

- **The sidebar is resizable** — drag its right edge (double-click to reset, or
  focus it and use ←/→). The width is remembered. (usability testing)
- **Long folder names are readable again.** Hovering a truncated name in the tree
  slides it across so you can read the whole thing. (usability testing)
- **Expand all / Collapse all** buttons in the tree sidebar. (usability testing)
- **The tree's two toggles no longer look alike.** The ▸/▾ triangle folds
  sub-folders in the tree; a separate photo-grid icon controls whether that
  group's photos show in the feed (and turns amber when hidden). (usability
  testing)

## 2.9.10

- **The "Group by" control is far more compact.** Its title now sits on top, the
  current grouping levels come first, the add-a-level autocomplete is short, and
  "Clear All" is now a small ✕ — reclaiming a lot of toolbar width. (usability
  testing; needs multi-auto-select 0.0.13)

## 2.9.9

- **Media-type filter now uses icons + a "Type" legend** — a photo icon, a RAW
  badge, and a video icon, each with a tooltip, instead of plain text labels.
  (usability testing)

## 2.9.8

- **Reveal a whole selection in Finder/Explorer.** Right-clicking a selected
  photo now offers "Reveal N photos in Finder" — on macOS it highlights all of
  them, on Windows the first (Explorer can't multi-select), on Linux it opens the
  containing folder. Single-photo reveal is unchanged. (usability testing)

## 2.9.7

- **Time now sorts oldest-first by default**, so a freshly-scanned trip reads in
  the order it was shot. (Your existing sort preference is kept.) (usability
  testing)
- **File sizes on the thumbnails when sorting by size.** Sorting by Size now
  shows each photo's size in the bottom-right of its tile (tucked above the
  burst-count badge on stacks). (usability testing)

## 2.9.6

- **Filter by media type.** New Photos / RAW / Videos toggles in the toolbar
  narrow the view to just the kinds you want (e.g. show only videos). Combines
  with the rating, orientation, and time filters. (usability testing)

## 2.9.5

- **The status bar is no longer hidden by background jobs.** The jobs strip
  (scan/export/undo progress) now sits directly above the status bar instead of
  painting over it, so counts, sort, and zoom stay visible while a job runs.
  (usability testing)

## 2.9.4

- **Select all with ⌘A / Ctrl+A.** Pressing ⌘A (Ctrl+A on Windows/Linux) now
  selects every photo in the current view — the whole filtered working set, not
  just the loaded window — unless you're typing in a text field. (usability
  testing)

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
