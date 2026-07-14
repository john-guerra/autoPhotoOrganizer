# Changelog

Notable changes to AutoGallery, newest first. Versions follow the scheme in
`CLAUDE.md` (§ Versioning): every change bumps the patch (third) number, the
minor (second) number is bumped only when a new package is generated, and the
`-alpha` suffix stays until a stable release is cut. Entries are short and
user-facing — what you can now do, not how it's built.

## 2.14.7

- **Right-click a folder in the tree.** Jump to it, select or keep only its
  photos, show it as a strip or collapse it, expand or fold all its sub-folders,
  reveal it in Finder, copy its path, rescan it, or remove it from the library.
  Removing asks first, and says what it will and won't touch — the files on disk
  are never affected.

## 2.14.6

- **A folder group now looks like a folder** — in the feed, the tree and the
  fisheye. A hollow icon means a folder that holds no photos of its own (only
  sub-folders), which is why it offers no rename or remove.
- **The tree's folder-name reveal is slower again**, so a long name can be read
  as it slides rather than snapping past.

## 2.14.5

- **Grouping by folder now shows your folder subtrees in the feed.** Sub-folders
  are indented under their parent, with the same dotted tree lines the sidebar
  uses, instead of a flat list of long absolute paths. Folders with no photos of
  their own (like a card's parent folder) appear as a heading with the total
  underneath, and a run of single-child folders collapses into one row so a deep
  path doesn't cost you five levels of indent. Every parent stays pinned to the
  top as you scroll, so you can always see which folder you're inside.

## 2.14.4

- **Folders now come back in tree order.** Grouping by folder walks a folder and
  then its own sub-folders, instead of letting an unrelated neighbour cut in
  between them — in this library, `Selectas copy` was landing in the middle of
  `Selectas`, separating it from its own contents. Groundwork for showing folder
  subtrees in the feed.

## 2.14.3

- **Editing a `.svelte` file no longer shows a bogus "No Svelte configuration found
  in vite config" error.** Developer-facing only — the app itself was never affected
  (the shipped bundle is byte-for-byte unchanged).

## 2.14.2

- **A video whose thumbnail is slow to appear no longer logs a server error.** The
  grid was falling back to an embedded-photo preview that a video hasn't got.

## 2.14.1

- **A search typed while the library is still loading now actually filters the
  grid.** It could show you the whole library — or an empty grid reading "No
  photos match your current filters" — while the count next to it said how many
  it had found.

## 2.14.0

Packaged build of everything since 2.13.0 — search, HEVC playback, and the video
conversion work below.

- **Search your library.** Type part of a file name or a folder into the search
  box (or press `/` from anywhere, `Esc` to clear) and the library narrows to the
  matches. It composes with the stars, the kinds and the timeline.
- **HEVC videos play natively where your machine can decode them** — instantly,
  instead of being converted first. Where it can't (a Windows PC without the free
  HEVC Video Extension), it converts, as before.
- **Clips convert before you reach them, with a real progress bar** instead of an
  endless spinner.
- **Video sound stays on**, the tree's label reveal is readable, and typing in a
  filter box no longer hands your keystrokes to the photo grid.

## 2.13.4

- **Videos that need converting start before you get to them.** Standing on the
  photo next to a clip the browser can't play (every .avi), the app now gets it
  ready in the background — so by the time you arrow onto it, it just plays.
- **The conversion shows a real progress bar**, not an endless spinner. A big
  camcorder AVI takes minutes, and "converting…" held for minutes is
  indistinguishable from a hang.

## 2.13.3

- **HEVC videos play natively when your machine can decode them.** Most Macs (and
  any Windows PC with the free HEVC Video Extension) decode HEVC in hardware — the
  app now hands those clips straight to the player instead of converting every one
  of them first. On a machine that _can't_ decode HEVC, it notices and converts, as
  before: you always get a picture, you just don't wait for one you didn't need.
- **Videos are probed for their format during the metadata sweep**, not the first
  time you open them — so opening a clip no longer stalls while we work out what it
  is. (The codec columns were added after the videos were indexed, which left 1,171
  of 1,173 clips in the library unprobed and unable to ever be picked up.)

## 2.13.2

- **Search.** A search box in the toolbar narrows the library to photos whose
  file name or folder matches what you type — press `/` from anywhere to jump to
  it, `Esc` to clear. It is a filter like the others, so it composes: search
  `canon`, keep 3 stars and up, show only videos, and the counts, the tree and
  the timeline all follow.
- **Typing in a filter box no longer loses the caret.** The grid used to grab
  focus back the moment the results reloaded, so the rest of what you were typing
  went to the photos instead of the box — and a digit rates a photo.

## 2.13.1

- **Video sound stays on.** Un-mute one clip and the next one plays with sound
  too — the player was hardcoded to start muted, so every single video had to be
  un-muted by hand. Your volume is remembered as well.
- **The folder-name reveal in the tree is slower**, so you can actually read a
  long name as it slides aside instead of it snapping past you.

## 2.13.0

**Packaged build** of the performance + correctness round (2.12.1–2.12.17).

- **The feed keeps up with your scroll.** Every date-grouped page used to scan all
  114,125 photos and sort them from scratch (64ms a page, 224ms with albums
  collapsed); now it seeks straight to the page in ~1ms. And it fetches the next
  page while two screens of photos are still ahead of you, so a hard fling no
  longer outruns the loader.
- **"Collapse all" works on a real library.** With folders as the top grouping it
  was a dead button — 1,183 folders made a request the server refused outright and
  a query SQLite couldn't run. You now get every group as one line with its count.
- **A rating that fails to save no longer looks saved.** The star used to stay lit
  against a rating the database never took, so a cull could quietly ship the wrong
  set. It now goes back, and says why.
- **Videos that played sound but showed nothing now play.** Old camcorder clips
  (AVI/DivX, MJPEG, H.263) and 4:2:2 footage are converted to a playable copy on
  first open — 317 of the 1,173 videos in a real library. Your originals are never
  touched.
- **Photos with no EXIF date get one** from the file itself, instead of piling up
  under "Unknown" (93,622 of them did), and **"Read all metadata"** fills in date,
  camera and lens for everything you've never scrolled past — in the background,
  without slowing down browsing.
- **Opening "Manage library" no longer freezes the app** (it was asking the disk
  615,000 questions), and **the loupe opens faster** (it was generating up to 81
  brand-new thumbnails every single time).
- **Photos appear while a scan is still running**, instead of an empty grid until
  the whole folder tree has been walked.
- **The timeline admits when it's a sample** ("sampled 12,001 of 114,125") — it
  always was, above 12k photos, and that's the curve you brush to find album gaps.
- **Auto Albums gets a timeline**: the range analyzed, a dot per photo, a colored
  band per album, linked to the list and zoomable.
- **The grid zooms out two steps further**, and the fisheye navigator is now its
  own package with proper nesting.
- Failures that used to be silent now speak up: a folder tree that won't load, a
  job that won't cancel, an update that won't install.

## 2.12.17

- **Opening "Manage library" no longer freezes the app.** The cache breakdown was
  asking the disk ~615,000 questions (five per photo) and holding up everything
  else while it did — for two full seconds on a 114k library, during which the
  grid, thumbnails and scrolling all stalled. Now it reads the cache once: the
  breakdown is 4x faster, and the app keeps responding while it runs (a feed page
  during it went from 1.81s to 0.08s).

## 2.12.16

- **Three things that used to fail in silence now tell you.** A folder tree that
  fails to load says so (and offers Retry) instead of rendering as an empty
  library — which read as "you have no photos"; a Cancel or Dismiss the server
  rejects now says why, instead of leaving a job sitting there claiming to run
  forever; and an update that fails to install says so instead of leaving the
  button stuck on "Restarting…".

## 2.12.15

- **The timeline now says when it's showing you a sample.** Above ~12,000 photos
  the density curve is drawn from a sample, not every photo — so a small dip in it
  could be a sampling artifact rather than a real gap between trips. It now says
  "sampled 12,001 of 123,599" right on the axis, which matters because that curve
  is what you brush to find album boundaries.

## 2.12.14

- **The loupe opens faster.** Its filmstrip was asking for a thumbnail size no
  other view uses, so every time you opened a photo the app generated up to 81
  brand-new thumbnails — while you were waiting for the photo itself. It now
  reuses the ones the grid already has, and only loads the strip cells you can
  actually see.
- The full-size photo and video you're looking at now take priority over a
  background metadata sweep, instead of queueing behind it.

## 2.12.13

- **Photos show up while the scan is still running.** Adding a big folder used to
  mean staring at an empty grid until the whole walk finished; now the grid fills
  in as photos are indexed (verified on a 112,618-photo, 1,164-folder archive: the
  first few hundred are on screen while the scan is 300 folders in). A scan you
  add to a library you're already browsing still lands all at once, so the grid
  never moves under your cursor.

## 2.12.12

- The browser tests and a production build now run on every push, not just when
  someone remembers. (No user-visible change — this is the net that catches the
  kind of bug the unit tests structurally can't see.)

## 2.12.11

- **"Collapse all" works on a big library.** With folders as the top grouping, a
  real library has 1,183 of them — and collapsing them all used to fail outright,
  twice over: the request was too long for the server to even accept, and the
  query behind it exceeded SQLite's limits. You now get what the button always
  promised: every group as one line with its count, on a 114k-photo library, in
  about a tenth of a second.

## 2.12.10

- **A rating that fails to save no longer looks like it saved.** If the write was
  rejected, the star stayed lit — so you'd keep culling against a rating the
  database never took, and the export would ship the wrong set. Now the star goes
  back and the status bar says so. Same for a manual burst cover.

## 2.12.9

- **Auto Albums now shows a timeline of what it analyzed.** A strip above the
  album list draws the full time range, a dot per photo, and a colored band per
  album — so the break points are visible as the gaps they actually are, instead
  of something you infer from the album count. Drag the split-gap slider and the
  bands re-flow live.
- **The timeline and the album list are linked.** Each album's color chip matches
  its band; hovering either one highlights the other; clicking a band scrolls the
  list to that album; and a marker tracks where you are as you scroll.
- **Zoom into a busy week.** Drag the axis handles to zoom the timeline (the
  density curve and ticks follow); double-click or hit "Reset zoom" to go back to
  the full range.

## 2.12.8

- **The feed loads ahead of a fast fling, not behind it.** The grid used to ask
  for the next page once you got within 20 tiles of the edge — which, at a big
  zoom or with bursts stacked, is only a few hundred pixels of road, less than
  one round trip at flinging speed. It now measures the runway in pixels and
  fetches while two screens of photos are still ahead of you.

## 2.12.7

- **The feed keeps up with your scroll wheel now.** Every date-grouped page was
  scanning all 114,125 photos and sorting them from scratch — and it got worse the
  more albums you collapsed (224ms per page with 20 collapsed, which is slower than
  you can flick). Now it seeks straight to the page: **64ms → 1ms** on a real
  library, and the collapsed-album case is 13x faster still. Nothing to do; the
  index builds itself the next time the app starts.
- The "Read all metadata" sweep no longer re-scans the whole library to find its
  next batch.

## 2.12.6

- **Videos that used to play sound but show nothing now play properly.** Old
  camcorder clips (AVI/DivX, MJPEG, H.263) and 4:2:2 footage can't be decoded by
  the browser at all — on Windows especially, you'd hear the audio and see a black
  rectangle. AutoGallery now converts those to a playable copy the first time you
  open one, cached alongside the thumbnails; your original files are never touched.
  That's 317 of the 1,173 videos in a real library.
- While a clip is converting, the loupe says so (and says why) instead of showing
  an empty black frame, and a conversion that fails tells you it failed.
- Fixed: a background job with no progress count could crash the jobs panel, which
  silently froze whatever else was on screen.

## 2.12.5

- **Re-reading metadata for a large selection no longer kills the app.** Select
  everything (⌘A) and hit "Re-read metadata" and the server used to die outright,
  taking the window with it.
- **The metadata sweep now stays out of your way.** It reads in the background
  only while you aren't waiting on anything, so scrolling stays as fast as it is
  when nothing is running — thumbnails no longer slow to a crawl or fail to load
  while a big read is in progress.

## 2.12.4

- **"Read all metadata"** (Folders → Manage library) reads the date, camera and
  lens of every photo you have never scrolled past. Until now those photos had
  no date at all: on a 114k library, 93,622 of them sat under "Unknown" and were
  missing from the timeline. It runs in the background with progress and a
  cancel, you can keep browsing, and stopping early loses nothing — it resumes
  where it stopped.
- **"Re-read metadata"** re-reads the selected photos from disk even if they were
  read before — for when you have edited the files somewhere else.

## 2.12.3

- **A photo with no EXIF date now uses the file's creation date** instead of
  landing in "Unknown". Screenshots, exports, scans and stripped images finally
  sort and group under a real date, in the grid, the tree and the timeline alike.
- Photos the app hasn't read yet still wait in "Unknown" rather than being filed
  under a guessed date — so nothing jumps between groups while you browse.

## 2.12.2

- **The grid zooms out two steps further.** Two new smaller thumbnail sizes (the
  `−` key or the slider) let you take in a whole shoot at a glance — a 99-photo
  folder now fits in five rows. The gutter shrinks with the tiles, so the small
  sizes read as a contact sheet rather than a field of gaps.
- Your zoom setting survives this change: it now remembers the thumbnail _size_
  rather than its position in the list, so adding sizes no longer moves you.

## 2.12.1

- The fisheye navigator is now a standalone package ([@john-guerra/fisheye-nav](https://github.com/john-guerra/fisheye-nav)) and understands nesting: an icicle whose leaf axis is fisheyed, or a flat outline indented by level, so you can always see what level you are on.
- Fisheye: hovering moves one group at a time instead of jumping past a whole month, every group can be reached and selected by drilling in, and the selected day is highlighted (below the top level, it never was).
- Fisheye: the photo-count bars are back inside each row (a histogram silhouette down the column), the icicle shows aggregated counts on years and months, and the row under the cursor always shows its name.
- Fisheye settings now live in the widget's own ⚙ and remember themselves: view, lens, band size (equal rows vs. photo mass), bar scale, and the interest weights.

## 2.12.0

- **The app says who made it.** ⌘-About (and the Windows installer, and the Linux
  package metadata) now name AutoGallery and John Alexis Guerra Gómez, with a link
  to https://johnguerra.co. Releases are credited to John rather than a bot.
- **The macOS build is signed** — ad-hoc, not authenticated. The bundle is sealed,
  so macOS can tell if it has been tampered with, and it launches cleanly on Apple
  Silicon instead of being killed as unsigned. What an ad-hoc signature can't do is
  prove the app came from John: without an Apple Developer ID, Gatekeeper still
  needs a right-click → Open on first launch, and macOS auto-update stays off.

## 2.11.0

- **Packaged build** of the folder-tree and selection round (2.10.7–2.10.13). The
  Library is a real nested folder tree whose labels spend their width on the part
  that tells two folders apart; ⌘A takes the group you're in before it offers you
  the whole library; a selected photo is its gold checkmark alone, so the focus
  ring is visible again; Undo restores exactly the selection you had; collapsing a
  group keeps you where you are; and "Choose subfolders…" is reachable from the
  native picker again (the 2.10.6 regression).

## 2.10.13

- **Collapsing a group no longer throws you back to the top of the library.**
  Folding or snapshotting a group far down the feed used to reload the window
  from photo #1 — the view jumped, and the group you had just clicked scrolled
  out from under you (often without even showing its snapshot). The feed now
  stays anchored on the group you clicked, in both directions (#113).

## 2.10.12

- **Every folder-tree bug that shipped now has a test that would have caught it.**
  Five defects in the folder tree passed a green unit suite and were found only by
  looking at the running app; the browser tier now covers each one — nesting, a
  photo-less parent folder that folds its children, the tree opening on load, a
  label that keeps the folder's name when it has to be clipped, and two folders
  whose names differ by a single character rendering differently. Each was checked
  to fail with its fix reverted, not merely to pass.

## 2.10.11

- **The Library is a real folder tree now.** Grouping by folder used to list every
  folder as a full absolute path, one flat row each. It now nests them, joining
  single-child chains into one row the way VS Code does, and rolls the photo counts
  up the tree. Folders on different drives come out as separate roots, so a library
  spread across several volumes reads properly.
- **Folder rows spend their width on the part that tells folders apart.** A name like
  `2013_01Jan_02_Harbour_Walk_selected_peq` now shows the date and the `selected`/`peq`
  boilerplate muted, with the event name bright — and the row is anchored to its end,
  so a long name is clipped at the front (which the parent row already told you)
  instead of at the subject. Nothing is ever removed: hover slides the name back into
  view and the full path is in the tooltip.
- **A folder row can fold everything beneath it.** Clicking the grid/strip/bar icon on
  a parent folder cycles every group under it together, and shows a "mixed" icon when
  they disagree. Clicking a folder that has no photos of its own jumps to the first
  one that does.
- **The path never outshines the folder's name.** A header put its rare middle
  words (`Backup`, `temp`) in lights while the folder's own name sat grey beneath
  them. Path segments are context now — always muted — and the emphasis goes to
  the name. If the name is nothing but boilerplate (`2025_11Nov_08 Canon 1`), what
  comes back bright is whatever differs from its siblings: the `1`. Two camera
  folders that differ by one character no longer read identically.
- **Feed headers keep the folder's name, not the path.** A long header used to be
  cut at the end — so two groups under the same long parent both read
  `…/2025_11Nov_08 Canon 1/2…` and looked identical. The header now clips its front
  (the part the path above already told you) and always shows the folder it names.
- **The tree starts expanded when you group by folder**, like it already did for
  multi-level groupings — and it no longer stops a third of the way through a big
  library. Opening a folder's sub-folders costs no request (they arrive with the
  level), so they were being counted against a budget meant for requests.
- **The hover reveal on a long name is ~5× faster** — a reveal, not a ticker.

## 2.10.10

- **You can see where you are again.** A selected photo is marked by its gold
  checkmark alone — the gold border is gone. The blue border now means one thing
  only: this is the focused tile. Before, a photo that was both focused and
  selected lost its focus ring to the selection colour, so in a sea of selected
  photos you couldn't tell where the keyboard was.
- **Undo covers every bulk selection change, not just removals** — Clear, ⌘A and
  ⌘⇧A all stash first — and it restores _exactly_ the selection you had before.
  It used to merge the old selection into the current one, which quietly made
  undoing a select-all do nothing at all.

## 2.10.9

- **⌘A now takes the group you're in, not the whole library.** Press it again and
  it offers to take everything currently shown — asking first, inline in the
  status bar, because pulling ten thousand photos into a selection shouldn't
  happen on a keystroke. Press ⌘A once more (or click Select all) to confirm,
  Esc to back out.
- **⌘⇧A is the mirror image:** it removes the current group from the selection,
  and pressing it again offers to remove everything shown. Anything it removes is
  restorable with Undo.
- Both are in the help menu (`?`).

## 2.10.8

- **Checking a folder in the subfolder list now takes everything under it.** Tick
  or untick a parent and its whole subtree follows, however deep — you don't
  click twenty boxes to take a year, or to drop one. If you then exclude
  something inside it, the parent shows a dash instead of a tick, so it never
  claims to be importing more than it is.

## 2.10.7

- **Fix: "Choose subfolders…" was unreachable in the app** (regression in 2.10.6).
  Picking a folder with the native picker started the scan immediately, so the
  panel's options — which subfolders to import, whether to focus — were gone
  before you could touch them. The picker now fills the path in and waits; you
  choose your options and press the button to commit.

## 2.10.6

- **Packaged build** of the folder-controls work: one ＋ panel for adding,
  opening, and rescanning a folder; a subfolder checklist so a recursive add
  imports only what you want; and a single scope chip in place of the old
  "Folder focus" and "Keep only" pair.

## 2.10.5

- **One door for folders.** Adding a folder and opening one were two separate
  controls doing nearly the same thing. Now there's one ＋ panel: pick a folder,
  choose whether to include subfolders, and tick "Focus on this folder only" to
  see just that folder. The button says what it will do — **Add & scan** for a
  new folder, **Rescan** for one you already have, **Open** to jump straight into
  an already-scanned folder (still works with the drive unmounted, without
  rescanning). The Folders dropdown is gone; the Folders button opens Manage
  folders directly.
- **Choose which subfolders to import.** Adding a folder with "Include
  subfolders" used to be all-or-nothing. "Choose subfolders…" now lists every
  folder it found with photo counts, so you can leave out the Exports/ and
  Selects/ folders you don't want. Untouched by default — a plain add still
  imports everything in one click, with no directory walk to wait on.

## 2.10.4

- **One scope, one chip.** "Folder focus" and "Keep only" were two chips and two
  mental models for the same idea — showing you a subset of the library. They're
  now a single scope with a single ✕ to leave it. Behavior is unchanged: scoping
  to a folder still picks up photos scanned into it later and still survives a
  reload, and keeping a hand-picked set still does neither.

## 2.10.3

- **Undo actually works after clearing a selection** (#97). Clearing used to
  remove the Undo button along with the selection, so the "undoable" clear had no
  way to be undone. The Undo button now stays until you use it or select again.
- **Clearing a selection no longer pops a modal.** It's instant and undoable, and
  the status line tells you what was cleared — the native confirm() froze the
  whole UI to ask about something you could already take back.
- Select-all (⌘A) was measured at **20ms on a 10,000-photo library**, so the old
  ~15s freeze reported in #97 is gone; there's now a test that fails if it
  returns.

## 2.10.2

- **Clicking the first photo no longer jumps into the loupe** (#104). Every tile
  now behaves the same way: one click focuses, a second opens. Before, photo #1
  counted as focused from the moment the app loaded, so a single click opened the
  loupe — and because rating auto-advances in the loupe, anyone who landed there
  by accident rated the _next_ photo with every keystroke while looking at the
  one on screen.

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
