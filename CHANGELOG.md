# Changelog

Notable changes to AutoGallery, newest first. Versions follow the scheme in
`CLAUDE.md` (§ Versioning): every change bumps the patch (third) number, the
minor (second) number is bumped only when a new package is generated, and the
`-alpha` suffix stays until a stable release is cut. Entries are short and
user-facing — what you can now do, not how it's built.

## 2.21.2

- **The loupe now shows all three of a photo's dates**, not just the one it
  picked: the EXIF capture date, the file's creation date and its modified
  date, side by side, with the one your current sort is actually using marked.
  A date that cannot be real — like the 1984 macOS writes when a file has no
  creation date of its own — is flagged in amber and says so, which is how a
  folder of 2025 phone photos turns out to be sorting into 1984 (#349).

## 2.21.0

First packaged build since 2.20.1. Mostly the Face Map, which went from a
feature you had to already understand to one you can explore.

- **The Face Map's settings sit beside the map, and the sliders move it as you
  drag.** They used to be a popover on top of the map, so you could not see
  what a setting did to the thing you were changing it for. Every setting is
  now a slider you can also type an exact number into, the map re-frames itself
  and the faces animate to their new places, and the panel is as wide as you
  drag it. On a library too big to keep up, it says so and waits for Apply
  rather than pretending (#327, #287).
- **The Face Map no longer hands you a map of a library you no longer have.**
  Asking for settings you had used before gave back the old map even after face
  grouping had found hundreds more people — worst on the default settings,
  which is the first map you ever build, and is why it looked like one
  particular Neighbours value was broken. It now notices and rebuilds, and the
  "N added since" notice is a button you can press (#325).
- **Neighbours defaults to 30**, chosen from 40 real projections across five of
  your own albums rather than from a screenshot (#326).
- **You can scan your selection while a whole-library run is going.** The scope
  picker and the button used to be greyed out, so the request could not even be
  composed. The big run now parks at its next batch boundary, yours runs, and
  the big one resumes with nothing recomputed — both visible in the jobs panel
  throughout (#279, #257).
- **Your Face Map selection now follows the people, not their positions**, so a
  rebuild or a filter change can no longer leave the tray holding someone you
  never picked — and pressing Build keeps your selection instead of clearing it
  (#327).
- Security: pinned a patched `js-yaml` inside the auto-updater, closing a
  high-severity advisory with no upstream fix (#338).
- Internal: better-sqlite3 moved to 13, which switches it to the N-API — one
  binary now serves both Node and Electron, so the rebuild dance that could
  strand a half-finished packaged build is gone. Dependabot also now opens its
  PRs against `testing` rather than the release line.

## 2.20.9

- **The Face Map's settings now sit beside the map, and the sliders move it as
  you drag.** They used to be a popover over the map, so you could not see what
  a setting did to the thing you were changing it for. On a library this size a
  change lands in under a tenth of a second; on a much larger one the panel says
  so and waits for Apply instead of pretending (#327).
- **You can type a number again.** The settings were number boxes that clamped
  on every keystroke, so getting from 5 to 50 by typing a 0 was impossible.
  Every setting is now a slider with an editable number beside it (#327).
- **The map remembers your settings.** They no longer reset every time you
  reload (#287).

## 2.20.8

- **You can now start a scan on your selection while a whole-library run is
  going.** Asking to find faces (or compute similarity) in a selection used to
  do nothing at all while a big background pass was running — the scope
  picker and the button were both greyed out, so the request could not even be
  composed. The scoped request now takes priority: the big run parks at its
  next batch boundary, yours runs, and the big one picks up where it left off
  with nothing recomputed. Both are visible in the jobs panel throughout, and a
  parked one says what it is waiting for (#279, #257).
- Kicking off a second whole-library pass while one is already running still
  answers immediately instead of queueing a duplicate — it would scan exactly
  the same photos.

## 2.20.6

- **The Face Map no longer hands you a map of a library you no longer have.** A
  map is stored under the settings it was built with, and asking for those same
  settings gave the old map back even after face grouping had found hundreds
  more people. The default settings were hit hardest, because that is the first
  map you ever build — which is why it looked like one particular Neighbours
  value was broken. Building now notices and rebuilds (#325).
- **"N added since" is a button.** It has always told you the map was out of
  date; now you can press it (#325).
- **Neighbours now defaults to 30.** Picked from 40 real projections of your own
  library across five albums, rather than from one screenshot — and a fresh
  comparison did not reproduce the old 50 (#326).
- Security: pinned a patched `js-yaml` inside the auto-updater, closing a
  high-severity advisory that had no upstream fix available (#338).

## 2.20.5

- Internal: CI is now a real gate that nobody has to watch — branch protection
  plus auto-merge, so an agent opens a PR and walks away; a workflow does the
  post-merge close-out an absent agent cannot; superseded PR runs cancel
  instead of racing to completion; and the e2e browser download is cached
  (#330). Nothing user-facing.

## 2.20.3

- Internal: the docs an agent reads first no longer state a version the app
  passed three releases ago, `docs/superpowers/plans/` is documented as the
  third folder it has always been, four shipped plans moved to
  `completed_plans/`, and `UI-CONTRACTS.md` no longer cites #222 as a settled
  success when it was reopened after failing validation (#323). The
  2026-08-05 handoff note is retired, its one durable lesson promoted into
  `AGENT-NOTES.md`. Nothing user-facing.

## 2.20.2

- Internal: a dated handoff note for the next agent (`docs/HANDOFF-2026-08-05.md`),
  covering the two stale worktrees still to be cleared and why the v2.20.0 draft
  must stay unpublished. Nothing user-facing.

## 2.20.1

- **Your existing Face Map needs rebuilding once.** 2.20.0 raised the default
  Neighbours setting from 15 to 50, and a map is stored under the settings it
  was built with — so the Face Map will open empty the first time and offer to
  rebuild it (about 20 seconds on a large library). Only once (#307).
- **"Copy log location" now captures the last few seconds too.** It was
  flushing only the server's half of the diagnostic log, so the events closest
  to whatever went wrong — the ones you opened the panel for — were still
  sitting in the browser (#314).
- **If copying the path fails, the path is now shown** instead of a message
  telling you to select something that wasn't there (#314).
- **The diagnostic log can no longer grow without limit**, and says plainly
  that it records the folders and files you browsed and anything you searched
  for — worth knowing before attaching it to a public bug report (#314).

## 2.20.0

First packaged build since 2.18.2, and a big one: fifty versions of work.

- **Faces became a real feature.** Find faces, have them filed into people as
  the scan runs, browse and name those people, and fix the inevitable
  duplicates in bulk on the new **Face Map** — lasso the blobs that are
  obviously one person and merge them in one undoable action.
- **Resetting your library works, and stays reset.** It no longer fails on a
  library with burst stacks, no longer blocks the app while it runs, and no
  longer comes back when you reopen the app.
- **Every long operation now says what it is acting on** — All, Keep only,
  Filtered or Selected, with live counts and a cost estimate that tracks your
  choice. Asking to find faces in 1,557 photos no longer quietly does 175.
- **Videos behave.** Arrowing through a folder of clips no longer wedges
  playback or the connection, and the one you stop on is not buried by the ones
  you passed.
- **AutoGallery keeps a diagnostic log**, so a stall can be diagnosed from
  evidence instead of guesswork. Settings → Diagnostics → Copy log location.
- **Shift-click selects the photos in between.**

## 2.19.46

- Internal: the video-connection trap behind #305 is written down where the
  next change will meet it, so it cannot be reintroduced by accident.

## 2.19.45

- **Arrowing through a folder of videos really is fixed now** (#305). Leaving a
  clip stopped its picture but not its download: the browser went on streaming
  every video you passed, and after about ten of them there were no connections
  left — the clip you were actually on sat black at 0:00, and the app announced
  it had lost the server while the server was answering in a millisecond.
  Leaving a video now releases it. Measured on a folder of 400 MB screen
  recordings: ten clips forward took the health check from 2 seconds back to
  2 milliseconds.

## 2.19.44

- **AutoGallery now keeps a diagnostic log** (#314). When something stalls or
  the app says it lost the server, there is finally a record of what both the
  app and the server were doing at that moment — requests, video conversions,
  jobs, and any period the server could not respond. It stays on your machine
  and is never sent anywhere. Settings (`,`) → Diagnostics → **Copy log
  location**, and paste that into a bug report.

## 2.19.43

- **The Face Map's Neighbours setting really does start at 50 now** (#307). The
  higher default shipped two versions ago but the gear kept showing 15: the app
  was sending its own copy of every setting with each request, so the server's
  answer was always overwritten by the client's. There is now one default per
  setting, in one place.

## 2.19.42

- **Arrowing through a folder of videos no longer wedges the app.** Each clip
  you passed started its own conversion, and enough of them at once starved the
  server until the app reported the connection lost. At most two convert at a
  time now, and one that is waiting says so (#305).
- **People start appearing much earlier in a face scan.** The first ones used
  to need about a thousand photos; now they arrive after roughly a hundred, and
  the pass gets rarer as it gets more expensive (#304).

## 2.19.41

- **People appear while a face scan is running**, instead of all at once when
  it finishes. Faces are filed into people as they are found, and how often
  scales with the size of your library so a big scan is not slowed down (#304).

## 2.19.40

- **Scrubbing past videos no longer buries the one you stopped on.** Landing on
  a clip started converting it, and nothing ever stopped that — so passing
  twenty videos ran twenty conversions at once, all competing with the clip you
  actually wanted. A conversion you navigate away from is now withdrawn, and
  closing the loupe withdraws everything still running (#305).

## 2.19.38

- Internal: the library-reset test that guards against blocking the server was
  both flaky on CI and unable to detect the regression it existed for. It now
  checks the behaviour deterministically (#310).

## 2.19.36

- **The Face Map groups duplicates better out of the box.** UMAP's neighbourhood
  now defaults to 50 instead of 15 — chosen by comparing both on a real
  254-person library, where 50 gives visibly tighter clusters to lasso (#307).

## 2.19.35

- **Face thumbnails are the right faces again.** After resetting the library
  and re-adding the same folder, the People view showed crops left over from
  before the reset — the crop cache was keyed on a face id, and those ids get
  reused once the table is emptied. Crops already cached by the browser are
  stepped around too, so the fix takes effect without clearing anything (#302).
- **The People view refreshes when a face scan finishes**, instead of staying
  empty until you reopened a panel. (It did NOT yet fill in DURING a scan —
  grouping still ran only at the end. See 2.19.41 for that half.) (#304)

## 2.19.34

- **People and the Face Map come back on their own after a face scan.** Both
  buttons were gated on a count the app only refreshed when you opened a panel,
  so a scan could file hundreds of faces and neither view would appear until
  you reloaded (#300).
- **The Face Map is offered as soon as you have any people at all**, instead of
  waiting for 100 (#300).

## 2.19.33

- **Grouping faces no longer fights the app for the CPU.** It now stands aside
  whenever you are being served — scrolling the grid, opening a photo — the
  same way scanning already did, so a whole-library grouping stops making the
  window unresponsive (#279).

## 2.19.32

- **Finding faces now files them into people, in the same run.** Grouping was
  a second button you had to know about, and skipping it left a pile of face
  boxes that did nothing. The scan job now shows a "Filing faces into people"
  phase and reports how many it filed. It groups only the photos it scanned,
  so a small scoped scan can't trigger a library-wide pass; Group is still
  there for whatever is left over, and Regroup is unchanged (#250).

## 2.19.31

- **A library you reset stays reset when you reopen the app.** Quitting and
  relaunching used to bring the whole thing back — folders you never re-added,
  along with old ratings — replayed out of the pre-SQLite `library.json`. That
  one-time import is gone; the files it read are untouched on disk (#295).

## 2.19.30

- **Nothing changes for you** — a packaging test that pins the one thing the
  coming background-work rewrite depends on: the database engine loading
  correctly inside a packaged build's worker thread. It would otherwise only
  have been discovered by a released app failing to start (#282).

## 2.19.29

- **Resetting the library works again.** It failed outright with `FOREIGN KEY
constraint failed` on any library holding a manual burst stack — and so did
  removing a folder, removing a subtree, and removing photos by selection.
  All four are fixed at the constraint, so a fifth can't get it wrong (#293).
- **A reset now really does wipe the index.** It used to leave the "keep only"
  working set behind — which, since that survives a reload, scoped the app to
  photos that no longer existed and showed an empty feed with no explanation —
  and to leave every person in place with no faces (#293).
- **Face grouping says what it actually did.** "Grouped 327 faces into 0
  people" was a wrong field name, not a failed run; it now reports the faces
  filed, the people created, anything left to do, and any empty people it
  tidied up (#293).
- **The grouping progress bar moves.** It reported once per batch of 500, so a
  job smaller than that sat at zero and then jumped to done — indistinguishable
  from a hang (#293).
- **People with no faces are cleaned up as grouping runs.** They accumulated
  whenever photos were removed or re-scanned; one library had 1,053 people of
  which 974 were empty. People you have NAMED are always kept (#293).

## 2.19.28

- **Groundwork, nothing visible yet** — background jobs that need the same
  resource (the database writer, the ML process) now take turns through the
  scheduler instead of each route refusing the second request. The refusals
  themselves come out next; this is the part that makes removing them safe
  (#279).

## 2.19.26

- **"Lost the connection" is no longer said about a server that is simply
  busy.** While a long job is running the banner is amber and names the work —
  "Resetting the library is still running" — instead of red and telling you the
  backend is gone. A server that really has gone still says so (#282).
- **Stop now works on a job that is waiting its turn**, which was the one job
  you were most likely to want to stop. And a waiting job can no longer be
  dismissed out of the panel while its work is still queued to resume.
- **A waiting job says what it is waiting for** — "Waiting for “Finding faces”
  to finish" — rather than only that it is waiting.

## 2.19.25

- **Resetting your library actually resets it, and tells you it is doing so.**
  It runs as a job in the Jobs panel now, with a progress bar and a working
  Stop, instead of freezing the whole app for up to a minute with no message
  and then reporting a lost connection. Emptying the thumbnail cache works the
  same way. Stopping either one is safe: what was already removed stays
  removed, and the summary says how far it got (#281).

## 2.19.24

- **Grouping faces no longer makes the app stop responding.** It now steps
  aside roughly a hundred times more often, including part-way through a
  single face — which is what was needed on a library with tens of thousands
  of people (#231).

## 2.19.22

- **Nothing changes for you** — this is review follow-up on 2.19.20's Face Map
  work (#255): the shift-lasso test could no longer tell "adds to the
  selection" from "replaces it", the "N people are left off" line in the empty
  state had no test at all, and two comments still called 2 the default.

## 2.19.20

- **The Face Map now starts at 5 faces per person instead of 2**, so it opens on
  the people you might actually name rather than on thousands of two-face groups
  that are noise or a stranger in the background of one photo (#255). The gear
  still lowers it whenever you want the tail.
- **The map says how many people the threshold is leaving off** — in the gear
  next to the member count, and in the empty state before you build. A filter
  that quietly removes most of your people should not have to be inferred (#255).

## 2.19.19

- **People now shows only the people in the photos you are looking at**,
  the way the Face Map already did. With a "Keep only" set or a filter in
  force the two views used to disagree about who exists (#252).

## 2.19.18

- **Shift-click finally selects the photos in between.** Select one photo,
  shift-click another, and the range is yours — including when you use the
  selection circles, which is the way most people select and the one path
  that never worked (#253).
- **Closing the window from `electron:dev` now stops the whole thing**,
  instead of leaving the server and Vite running until you Ctrl-C.

## 2.19.17

- **Finding faces no longer waits for grouping to finish.** Asking for one
  while the other runs now queues it instead of greying out the button, and
  "Group faces" steps back to being an advanced option rather than a step
  you have to remember (#258).

## 2.19.16

- **One "Scan my photos" pass**, on the server for now: it walks your photos
  in slabs sized to about twenty seconds of work each, carries every slab
  through each step you have switched on, and reports what it found. Stopping
  it keeps everything it had already finished (#258).

## 2.19.15

- **Asking to scan a folder or a selection now jumps the queue.** A
  library-wide pass steps aside for it — finishing the batch it is on, never
  losing work — says so in the jobs panel, and picks up again afterwards
  (#257).

## 2.19.14

- **An unplugged drive no longer looks like a failure.** A sweep that stops
  because the drive went away now says it is paused, with the reason, in a
  neutral colour — instead of a red "1 failed" about something that was
  never wrong with your photos (#260).

## 2.19.13

- Groundwork, not yet visible: one place to ask how many photos still need
  each kind of processing, for the whole library, the current filter and
  your selection at once (#258).

## 2.19.12

- Two counting fixes with no visible symptom yet: the face panel could
  under-report how many photos still need scanning once photos had gone
  missing, and "clear failures" removed more than failures (#261).

## 2.19.11

- **Coming back to the photo grid from People, Auto Albums or the Face Map
  shows your photos again.** It used to come back nearly empty until you
  scrolled (#248).

## 2.19.10

- No user-facing change. Adds a benchmark that records how fast each
  processing stage is today, so the upcoming unified scan can be held to
  being at least as fast (#258).

## 2.19.9

- No user-facing change. Adds a test fixture larger than one feed page, so
  the bugs that only appear on a real library can be caught before you find
  them (#245, #248).

## 2.19.8

- **The scope you pick is now the scope it runs on.** "Visible" meant
  whatever had scrolled into view, so asking to find faces in 1,557 photos
  quietly scanned 175 and said it worked. It is called **Filtered** now and
  means every photo the current filter matches (#245).
- **A "Keep only" scope appears while a working set is in force**, so you can
  run something over the whole working set without selecting it all first.
- **Selected now says how many of your selection the filter matches** — a
  selection survives a filter change on purpose, so "20 selected · 14 in the
  current filter" tells you which number is which.

## 2.19.7

- The toolbar timeline now updates when you change what "Keep only" is
  keeping. Replacing one kept selection with another left the strip plotting
  the previous set's dates, so the timeline and the photos below it disagreed
  (#246).

## 2.19.6

- Build and security tooling updated to current major versions
  (`actions/checkout` v7, CodeQL v4), so CI keeps running on supported
  actions (#242, #244).

## 2.19.5

- No user-facing change. Repairs the test suite, which went red across 36
  tests after "Keep only" was made to survive a reload (#212): a test that
  scoped the app never cleaned up, so every test after it ran against a
  two-photo library.

## 2.19.3

- "Keep only" now survives a reload and an app restart. It used to come back
  showing the whole library while the working set was still in force on the
  server — one side remembering and the other not (#212).

## 2.19.2

- **Grouping faces now works on a selection**, like everything else: All /
  Visible / Selected, with a live count of how many faces it will actually
  group. It used to offer only the whole library (#235).
- **And it keeps what it finishes.** Grouping files faces in batches as it
  goes, so stopping it — or closing the app — no longer throws the work away.
  Run it again and it picks up where it left off instead of starting over.
  This is what makes a large library groupable at all.
- Rebuilding every group from scratch is still available, as its own
  clearly-marked action with a confirmation, since it discards the groups the
  app worked out.
- The grouping job's label in the jobs panel is short enough to read now
  (#236).

## 2.19.1

- **The face map's settings can actually be changed now.** Editing a value used
  to be silently undone the next time anything refreshed, and only UMAP's
  settings existed at all — picking t-SNE offered nothing to adjust. Each
  method now brings its own settings, with an explanation of what each one
  does, and PCA says plainly that it has none (#237).

## 2.19.0

Packaged build. Everything in 2.18.46 below, plus:

- **The map is sized by photos, and you control the range.** A dot's area is
  proportional to how many photos that person appears in, on a square-root
  scale, with smallest/largest sliders in the map's gear. Faces carry the same
  encoding as the dots now, so it survives at the zoom where you are actually
  reading them.
- **Filter the map to what you are viewing.** Narrow the feed — a keep-only
  set, a rating, a folder — and the map shows only the people in those photos,
  keeping everyone's position so you can compare across filters. It says
  "50 of 120 people · in view" rather than quietly looking like the whole
  library, and tells you when the filter matches nobody.
- **Zoom in much further**, and the map no longer blinks while faces load.

## 2.18.46

- **New Face Map view.** See everyone laid out by how alike their faces are,
  lasso the ones who are really the same person, and merge and name them in one
  action — with undo. Built for the case where grouping has split one person
  across dozens of groups (#232).
- **The map says what it is not showing you**: how many faces have never been
  grouped, and how many people have been added since it was built. Two
  differently-named people in one lasso stops and asks which name to keep
  rather than quietly dropping one.
- **Choose how it lays out** — UMAP, t-SNE or PCA — with the minimum number of
  faces, neighbours and other settings in the map's own gear. Each option says
  how well it actually separates people, and how long it will take. Maps are
  kept, so going back to one you have already built is instant.
- A view can now bring its own keyboard shortcuts, so they show up in the help
  overlay (**?**) automatically and the app stops answering them with a message
  about photos.

## 2.18.45

- **Grouping faces no longer makes the app say it lost the server.** The pass
  blocked everything for ten seconds at a stretch on a large library, long
  enough that the app gave up and showed "Lost the connection… Reconnecting".
  Photos, the feed and the jobs panel now keep working throughout (#231).
- **The People view no longer tries to draw every person at once.** A real
  library can hold tens of thousands of them, most seen in a single photo. It
  shows the biggest groups first, says how many more there are, and loads more
  on request (#223).

## 2.18.44

- **People moved out of the settings panel and into the main area.** Press `V`
  (or the People button) and you get a face for every person the grouping
  found — name them, merge the ones that got split, and click a face to see
  just their photos. Naming from a list of "Unnamed · 34 faces" placeholders
  was guessing; now you can see who you're naming (#223).
- Faces are shown as real crops from your photos for the first time — the app
  had been storing where every face is since faces shipped, but had no way to
  draw one (#223).
- The Machine learning panel keeps the face **settings** (model, download,
  licence, forget everything) and points you at the People view for browsing
  (#223).

## 2.18.43

- **Grouping faces into people can now be watched and stopped.** It used to be
  a frozen button inside the settings panel — no progress, nothing to cancel,
  and the whole operation vanished the moment you closed the panel. It is now a
  job like every other long task: a real progress bar, a working Stop, and
  visible from the main interface whether or not the panel is open (#222).
- Stopping a grouping changes nothing at all, and says so rather than reporting
  a failure (#222).
- Starting a second grouping while one is running is refused with a message
  telling you where to watch the first (#222).

## 2.18.42

- **Find faces in what you selected, or just what's on screen** — not only in
  the whole library. The panel now offers All / Visible / Selected with live
  counts, and the time estimate follows your choice, so twenty photos no longer
  cost you a library-wide scan (#221).
- An empty selection is refused with a message that says so, instead of quietly
  scanning everything (#221).
- Progress for a scoped scan counts the photos that still need looking at, so
  the bar reaches the end instead of stopping partway (#221).
- Picking a scope where everything has already been scanned says so, instead of
  starting a scan that immediately reports nothing (#221).

## 2.18.41

- **Rating or selecting during the Auto Albums review no longer hits the wrong
  photo.** Pressing `1`–`5`, `X`, `⌘A`, `C` or `G` there used to quietly rate,
  select or re-stack a photo from the grid behind it — one you couldn't see and
  hadn't chosen. Each now tells you the action isn't available in that view,
  and how to get back (#155).
- **Press `V` to switch what fills the main area** — grid → Auto Albums → back.
  The Auto Albums button is now a toggle you can press again to leave (#155).
- Holding `V` no longer fires one album scan per key-repeat, or drops you back
  into a view you'd just left (#155).
- Groundwork: the main area is now pluggable, so upcoming views (People, #223)
  arrive as their own screen rather than another panel (#155).

## 2.18.40

- **No change to the app.** Three rules about how features should behave —
  every operation runs on your selection, long work can be watched and stopped
  from the main window, and anything that shows you photos belongs in the main
  window rather than a settings panel — were only ever recorded in closed
  issues, so each got broken again by the next feature. They are now written
  down as contracts every future change inherits (#224), and the gaps in the
  new face feature are filed as #221, #222 and #223.

## 2.18.39

- **Find the faces in your photos** (#166). Machine learning → Find faces
  downloads a small face model (16 MB) and looks through your library for
  people — about 14 minutes for 32,000 photos. Faces stay in this app's local
  index and never leave your machine, and one button forgets all of them.
- **Group those faces into people, and name them** (#167). Naming sticks: it
  survives re-grouping and new imports, and photos of someone you have named
  are filed under them automatically as they arrive. Merge two people, or pull
  a face out of the wrong one, and that correction sticks too.
- **Filter the grid by person** from the toolbar, once you have named someone.
- If any photos could not be read, one button offers to **try them again** on
  the next scan.

## 2.18.38

- **Work is now validated on a `testing` branch before it reaches `main`.**
  `main` holds only what has been signed off and is what release builds are
  cut from; everything else lands on `testing` first. No change to the app
  itself — this is how changes get to you, not what they do.

## 2.18.37

- **Search your photos by what is in them** (#164). Type "sunset", "whiteboard",
  "my dog on a sofa" — anything, there is no fixed list of words — and
  AutoGallery ranks your whole library against it in a fraction of a second. It
  reads nothing new: it compares your words against photos the model has
  already looked at.
- Results are **ranked, never thresholded**. You drag a slider to keep as many
  as you want, because only you can see where the results stop being your dog.
- **Save what you keep as a tag**, and it becomes a normal filter you can
  combine with ratings, folders and dates. Photos you add to a tag by hand are
  never thrown away when the search is re-run.

## 2.18.36

- **Find duplicates now answers about your selection** (#211). Select some
  photos, run it, and it tells you what it found among _those_ photos — "12
  groups among your 200 selected photos (43 library-wide)" — instead of only
  ever reporting a library-wide number you had no way to connect to what you
  were looking at.
- When a duplicate group reaches photos outside your selection, it says so
  rather than quietly counting them as yours.
- With photos selected, the first-time "read your photos" step now reads only
  the selection, not everything on screen.

## 2.18.35

- **Photo similarity now makes bursts better, not just bigger** (#216). Photos
  taken seconds apart used to stack together no matter what was in them — and
  on a real library a quarter of those stacks turned out to hold visibly
  unrelated photos. When similarity is on, AutoGallery now splits those apart
  as well as pulling matching ones together.
- **A dot on a photo means it has been read** by the vision model, so you can
  see at a glance what has been processed and what has not.
- Bursts behave exactly as before on any library that has not been embedded.

## 2.18.34

- **Photos of the same shot now stack together, even when you paused between
  them** (#162). Burst detection used to rely on timing alone, so a retake a few
  seconds later — same scene, framed slightly differently — landed as a separate
  photo. With photo similarity turned on, AutoGallery recognises them as the
  same shot and stacks them. Nothing is moved or deleted, and you can still pull
  any photo out of a stack as before.
- **Tune it yourself in Manage library:** a Similarity slider for how alike two
  photos must be, and a Time window for how far apart they may be taken. The
  defaults are deliberately strict — a missed duplicate is invisible, a wrong
  one hides a photo. Changing either regroups in seconds, without re-reading
  your photos.
- If photo similarity is off (the default), burst detection behaves exactly as
  it did before.
- **Find duplicates and Burst selection are in the toolbar**, next to the burst
  gap (#207). "Burst selection" stacks just the photos you have selected,
  splitting them wherever the pause is longer than the gap — which making a
  manual stack can't do, since that forces everything into one stack.
- **Machine learning has its own panel** (#205), reached from the settings menu
  instead of being buried under the thumbnail cache in Manage library.
- **Embed just the photos you care about** (#206). Right-click to read the
  selection, or everything currently loaded, instead of waiting for the whole
  library — on a 34,000-photo library that is the difference between twenty
  minutes and a few seconds.
- **The embedding progress bar actually fills now** (#208), instead of dancing
  with no idea how far along it is.
- **You can pin which processor runs the model** — CPU, GPU or Apple's Neural
  Engine (#209). Auto still measures and picks; the read-out always names what
  really loaded, so you can check the surprising result (CPU beat the GPU here)
  on your own machine.

## 2.18.33

- **Photo similarity works in the installed app, not just in development**
  (#203). The background process that reads photos for similarity had never
  been run from a real packaged build, and if it had failed there it would have
  failed for every user while looking fine on a developer's machine. Verified
  against a real macOS build end-to-end — it starts, loads, and produces
  results. No change was needed, and a test now keeps it that way.

## 2.18.32

- **Dev:** fixed the two CI-only flakes in `e2e/albums.spec.js`. Album
  detection clusters on capture dates, but metadata reads are lazy, so the
  number of albums the fixture produced varied with paint timing; and the
  materialize test asserted zero console errors while deliberately stubbing a
  400, racing Chromium's own log of it. Both now deterministic.

## 2.18.31

- **Internal:** a test that proves the new photo analysis actually understands
  what it is looking at, rather than merely producing numbers of the right
  shape. A burst, the same scene re-framed, and an unrelated subject now have
  to come out in that order with a usable margin between them, or the build
  fails — the check that #162's duplicate detection and #163's clusters
  quietly depend on (#161).

## 2.18.30

- **AutoGallery can now analyze your photos by what they look like, so future
  features can find them without you having tagged anything — off by default.**
  Turn it on from Manage library, which shows you the model, its download
  size, and its licence before anything downloads. (#161)
- **New ML settings in Manage library**: pick the model, cap how many cores it
  can use (half your machine by default, so browsing stays smooth), see how
  many photos are done and how many failed, and reclaim the disk space a
  model's data uses. (#161)
- Analyzing your library in the background leaves thumbnails cached for every
  photo it passes over, so the grid loads instantly everywhere afterwards,
  not just where you've already scrolled. (#161)
- **A problem with the model or the download no longer writes off your
  photos.** If the analyzer itself can't run — no connection on the plane, a
  blocked proxy, a full disk — it now stops and says why, instead of marking
  every photo "could not be read". And when photos are genuinely marked
  failed, a **Retry failed** button in Manage library puts them back in line.
  (#161)
- RAW files are skipped rather than counted as failures, and the panel says
  so — there's no preview AutoGallery can read for one yet. (#161)

## 2.18.29

- **Internal:** step 5 of the jump/landing refactor (#189) — every feed-window
  jump (tree/scrubber click, Option+←/→, group ‹/› buttons) now resolves which
  photo to land on through the single tested resolver the re-center path already
  used, instead of three near-identical hand-rolled copies. No behavior change;
  one fewer place for the "jump lands on the wrong photo" bug class to hide.

## 2.18.27

- **Internal:** second step of the jump/landing refactor (#189) — the two
  separate "hold the landing" flags (a jumped-to tile, and an expanded group's
  header) are now one `landing` state, so they can never both be armed and fight
  over the scroll. No change to any normal jump; a rare fold-then-jump corner is
  tightened. Scrolling also feels a touch smoother (the pin now skips no-op
  scroll writes).

## 2.18.26

- **Internal/dev:** the e2e suite's ports are now configurable via
  `E2E_API_PORT` / `E2E_UI_PORT` (default 4399 / 5399), so multiple agents can
  run Playwright concurrently without colliding on the hardcoded ports (#192).

## 2.18.24

- **Internal:** first step of the jump/landing refactor (#189) — extracted the
  scroll-hold math that keeps a jumped-to photo in view into a pure,
  unit-tested module. No behavior change; groundwork toward ending the recurring
  "jump lands on the wrong group" bug class for good.

## 2.18.23

- **The toolbar timeline strip no longer gets stuck showing the wrong dates
  after "Keep only"**. If you'd narrowed the timeline (dragged a brush handle)
  before scoping down to a selection or a group, the strip could keep showing
  the old, now-meaningless date range instead of the new working set's — and
  in the worst case silently re-applied that stale range as a filter on the
  new scope. Applying (or leaving) a "Keep only" scope now resets the time
  brush, the same way it already resets for every other facet. (#194)

## 2.18.22

- **Jumping to a group no longer drifts onto a different group** on a large
  library. Clicking a folder deep in the tree (or the scrubber) used to land on
  the right group for a moment, then slide onto a _later_ folder as photos'
  real dimensions loaded in the background. The landing now holds steady until
  you scroll, and earlier folders load as you scroll up. Fixes the regression in
  2.18.14, which only held on small libraries (#180).

## 2.18.21

- **Dev:** pinned the `adm-zip` transitive dependency pulled in by
  `onnxruntime-node` to `^0.6.0` via an `overrides` entry, closing a high
  severity `npm audit` finding (crafted-ZIP memory exhaustion, GHSA-xcpc-8h2w-3j85).
  No released `onnxruntime-node` version (including dev prereleases) requires
  the fixed `adm-zip`, so the override is required until upstream moves.

## 2.18.19

- **Dev:** fixed the toolbar-fold e2e test, which had asserted lowercase
  dimension names and so been red since the chips were Title-Cased — restoring
  regression protection for the folded group-by dropdown. (#178)

## 2.18.18

- **Dev:** the e2e suite warms the Vite dev server before running, so a cold
  optimizer cache no longer flakes the accessibility spec with a spurious
  dependency-reoptimization 404. (#190)

## 2.18.16

- **Loupe minimap now labels the photo's place on the map.** The city name sits
  on the pin instead of drifting off behind a stray leader line, and only places
  actually in view are labelled — no more lines pointing to nothing. (#179)

## 2.18.15

- **New "Neighborhood" place level, below City.** Group, filter, and search by
  the neighborhood a photo was taken in — Mission District, Chinatown, Hell's
  Kitchen — as the finest level under Country › Region › City, and see it in
  the loupe's Location breadcrumb. Only resolves when the photo is genuinely
  inside a known neighborhood (otherwise it stays Unknown), so it never guesses
  a distant one. (#176)

## 2.18.14

- **Jumping to a group no longer drifts off screen.** When you jump to a folder
  via the tree (or the scrubber), the landing now holds steady while the photos'
  real dimensions load in the background, instead of sliding out of view a moment
  after it looked right. Most visible on a large library, where that metadata is
  slow to arrive.

## 2.18.13

- **Guarded group jumping.** Every way of jumping to a group (Option+→, the tree,
  the scrubber, a group header's › button) is now covered by a test that checks
  the jump lands on that group's FIRST photo, with the photo on screen — and that
  the landing still holds after the feed's background backfill settles, rather
  than only for the first frame. Also covers a library larger than one feed page,
  which the old fixture was too small to exercise at all.

## 2.18.12

- **Adding a folder now tells you it worked.** After a scan the status bar names
  what landed — "Added 2024_05May_01 NewCard — 4 photos in 1 folder" — and the
  message stays put instead of being overwritten a second later by the generic
  "N photos loaded". If you're grouped by something other than folder (so the
  feed can't scroll to it), it says so rather than appearing to do nothing (#170).

## 2.18.10

- Unmounting a drive while the library was being hashed no longer excludes those
  photos from hashing forever. Libraries already affected are repaired
  automatically on the next launch — no rebuild needed. (#169)
- Content hashing now appears in the Jobs panel with progress and a cancel
  button, instead of running invisibly. (#160)
- Groundwork for on-device photo understanding: the background runtime that
  future face and similarity features will run on. No models are downloaded and
  nothing changes in the app yet. (#160)

## 2.18.9

- **The "Nearest town" dimension is now labelled "City".** It carried that
  hedge since it launched because the geocoder used to return a genuinely
  unrelated small town for a city coordinate; that was fixed in 2.18.5, so
  the label no longer needed to undersell it.

## 2.18.8

- **A new Region level — state, province, or departamento.** Group and
  search the feed by "California", "Cundinamarca", "Île-de-France" — one
  more step in the place hierarchy, between country and nearest town (#173).
  Existing photos pick it up automatically, no rescan needed.
- **The loupe's minimap now labels what you're looking at**, using
  @john-guerra's `smart-labels` — the photo's own town plus nearby countries,
  only as many as fit without crowding.

## 2.18.7

- **The loupe now shows where a photo was taken.** A Location section appears
  for any geotagged photo — its country and nearest town, plus a small
  offline map with a pin. Entirely offline, same as the rest of Places (#154,
  #175): no network, no accounts, and it works with your photo drive
  unplugged.

## 2.18.6

- **Fix:** on a large library, updating to the new place-name database (2.18.5)
  no longer stalls the whole app on launch. It now catches up in the
  background instead.

## 2.18.5

- **Places now name the right city.** San Francisco photos were being filed
  under "Half Moon Bay" — a town 33 km away — because the old location
  database had no entry for San Francisco, Oakland, Berkeley, San Jose or
  Palo Alto at all. Swapped in a far denser offline database (138,000 places,
  still no network, no accounts) that also knows the difference between a big
  city and the small town next door: central Bogotá reads "Bogotá", while
  nearby La Calera stays "La Calera" (#175).
- Your existing photos are re-labelled automatically the next time the app
  starts — no rescan, and it works with the drive unplugged.

## 2.18.4

- **Fix:** removing "Nearest town" (or any non-folder dimension) from Group
  By no longer crashes the Library tree (#172).

## 2.18.3

- **Group and search your photos by where they were taken.** AutoGallery now
  reads the GPS in your photos and resolves it to a country and nearest town —
  entirely offline, no accounts and no network. Group the feed or the Library
  tree by Country or Nearest town, and type a place name into search to find
  everything shot there. Photos without GPS group under "Unknown". Existing
  libraries fill in automatically in the background after the next scan (#154).

## 2.18.2

- **Content signatures now index the whole library in the background.** After a
  scan, AutoGallery hashes every photo's content (idle-gated, so it never slows
  browsing; resumable across restarts) instead of stopping after ~50. This is the
  foundation for cross-drive backup coverage and duplicate detection (#12, #86)
  and content-based relocation of missing files (#129).

## 2.18.1

- **Under the hood:** the dev / CI / build toolchain now targets **Node 24** (the
  current stable), up from Node 22.12 — `engines`, both CI workflows, the release
  workflow, and a new `.nvmrc`. The packaged app is unaffected (its Node ships
  inside Electron); this only sets what contributors and CI build with.

## 2.18.0

- **Packaged release of the 2.17.x line** — cut as native macOS / Windows /
  Linux builds. Bundles: the trailing-slash feed de-dup (#138), reveal-in-Finder
  for huge selections (#140), the empty-feed-after-materialize fix (#139), the
  shift-click range confirmation (#141), the Add-folder subfolder-tree cascade
  (#137), and whole-folder subtree fold + aggregate snapshot (#142).

## 2.17.13

- **Fold a whole folder as one, or peek at its subfolders (#142).** When grouped
  by folder, clicking a parent folder's fold icon now snapshots its ENTIRE
  subtree as one strip (sampled across every subfolder), then collapses it to one
  bar, then expands — so a card with camera subfolders folds in a single click.
  Shift-click instead fans out to one snapshot strip per subfolder (VS Code–style
  region fold). Works from both the feed header and the sidebar tree. (The
  whole-subtree fold only applies when grouped by folder alone — grouping by
  e.g. year then folder falls back to the per-subfolder fold, since a single
  folder can span multiple years.)

## 2.17.12

- **The Add-folder "Choose subfolders" list now behaves like a tree (#137).** A
  parent folder that holds no photos of its own but has camera/date subfolders
  (e.g. `Cards/Cam 1`) now appears as its own parent row — so one click checks or
  unchecks the whole card, and unchecking a parent clears every subfolder under
  it. Partly-selected parents show an indeterminate checkbox.

## 2.17.11

- **A big shift-click range now asks first (#141).** Click a photo, then
  shift-click another to select everything in between. If that range is more
  than 50 photos, an inline "Select all N photos in the shift-click range?"
  confirmation appears (with Undo), so a stray shift-click across a big grid
  can't silently grab hundreds.

## 2.17.10

- **The feed no longer goes blank after materializing albums (#139).** When you
  had a folder open (scoped) and moved its photos into albums elsewhere, the
  grid came back empty because it was still pointed at the now-emptied source.
  It now follows the photos to the destination and shows the new albums.

## 2.17.9

- **Reveal in Finder now works for huge selections (#140).** Selecting more
  than 500 photos and choosing Reveal used to be rejected outright. It now
  highlights the first 500 and tells you the rest were omitted (e.g. "Revealed
  500 of 1500 — narrow the selection to highlight specific files").

## 2.17.8

- **A folder path with a trailing slash no longer duplicates its photos in the
  feed (#138).** Scanning `/trip/` and `/trip` now resolve to the same folder
  instead of two, so each photo appears once.

## 2.17.7

- **The search box shows a focus ring for keyboard users.** Tabbing into the
  toolbar search now has a visible outline (keyboard only — the clean borderless
  look stays for mouse users).

## 2.17.6

- **Status messages are now announced to screen readers.** The status bar's
  transient line — "Path copied", "Select all failed", "Removed N — Undo",
  "Reading metadata…" — is now a live region, so assistive-tech users hear the
  same "never fail silently" feedback sighted users always got.

## 2.17.5

- **Remove any group from the library, not just folders (#135).** The Remove
  action on a group header now works for every grouping — a year, a camera, a
  day, or a folder. It drops all the photos in that group (and everything nested
  under it) from the library; files on disk are untouched (a rescan brings them
  back), though ratings for those photos are lost. Two-click confirm, and the
  feed, tree, and counts refresh afterward.

## 2.17.4

- **Folder pickers open where the input already points.** Choosing a destination
  for export, Auto Albums, adding a folder, or relocating a missing file now
  starts browsing in the folder currently typed in that field, instead of your
  home directory.
- **The feed updates after moving photos.** Moving photos out via Export now
  reloads the feed (and counts) so they leave their old spot, instead of
  lingering as stale, broken tiles.

## 2.17.3

- **Auto Albums now uses the names you type.** Editing an album's name in the
  review took visually but was dropped when you materialized — the folders came
  out with the default names. They now match what you typed.
- **The feed no longer goes blank after materializing.** Once the album folders
  are created, the feed reloads to show the new state instead of a stale, mostly-
  black grid pointing at photos that just moved.

## 2.17.2

- **The album-name fields in Auto Albums now fill the row.** Each editable name
  used a fixed, cramped width that ignored the panel; it now grows to use the
  available space, so long album names are readable while you edit them.

## 2.17.1

- **Release builds now publish reliably across all three platforms.** The per-OS
  installers are gathered and published in a single step, so a release always
  ships macOS, Windows, and Linux together — previously the OS builds could land
  in separate draft releases and silently drop each other's files.

## 2.17.0

Packaged build. Bundles everything since 2.16.0 — headlined by the new
**feed scrubber** and a **keyboard-navigable folder tree**.

- **New feed scrubber on the right edge.** A full-height rail you can drag,
  resize, and hop with the keyboard to move through the whole library at a
  glance. It labels folders (following the library tree) and can show a date
  "scent," with a hover fisheye, a name tooltip, and a marker that tracks your
  position smoothly.
- **Navigate the folder tree from the keyboard, VS Code-style.** Press **T** to
  focus the tree, then arrows move a cursor, **→/←** expand / collapse,
  **Home/End** and **PgUp/PgDn** jump, type a name to jump by type-ahead, **Enter**
  opens the folder, and **Esc** hands control back to the photo feed.
- **The tree keeps your place in view** — a new **👁 Follow** toggle scrolls the
  tree to the folder you're browsing as you move through the feed.
- **Auto Albums is smarter.** Run it on just your current selection, get numbered
  album names by default (`2018_06Jun_30_Chicaque_1`) so same-day albums stay
  distinct, and pick a naming scheme from a real dropdown.
- **Smoother scrolling.** The grid predictively prefetches thumbnails in the
  direction you're heading, no longer stops dead at a false "end of page," and a
  hard fling no longer "refreshes the whole page." The grid also stops jumping as
  details load or when you resize / zoom.
- **Export is simpler** — pick the folder, then Copy or Move — and you can now
  export straight into a scanned folder. Adding a folder jumps the feed to it.
- Plus fixes to jumping to a folder (trailing-slash folders, scrolling up to
  earlier folders, no more bouncing to a neighbouring album), the release CI
  checks, and the release build itself (the per-OS installers now publish one at
  a time, so a release always ships all three platforms). (#5, #128, #130, #132)

## 2.16.28

- **Fixed the CI checks that gate releases.** The feed scrubber's viewport marker
  shared a CSS class (`thumb`) with grid photos, so an automated check counted it
  as an extra photo and stayed red; the marker now has its own class. No visible
  change to the app.

## 2.16.27

- **Auto Albums works on your selection.** Select some photos, then hit Auto
  Albums and it organizes just those instead of the whole view — the selection
  becomes the working set (shown by the scope chip, clearable in one click). With
  nothing selected, Auto Albums still uses the whole view as before.

## 2.16.26

- **Press Esc in the Library tree to jump back to the photo feed.** After
  arrowing through folders, Esc hands keyboard control back to the grid so
  arrows and rating keys work again — no reaching for the mouse. (Tab never did
  this; it followed the browser's tab order, not the grid.)

## 2.16.25

- **Folder-naming presets are pickable again.** The Auto Albums naming field now
  has a real dropdown of preset schemes beside the text box — the old combobox
  silently hid every option once a value was filled in.
- **Album names get a number by default.** The default naming scheme is now
  `%Y_%m%b_%d_%f_%n` (e.g. `2018_06Jun_30_Chicaque_1`), so a folder that splits
  into several albums on the same day gets distinct, numbered names.

## 2.16.24

- **Navigate the folder tree from the keyboard, VS Code-style.** Press **T** to
  focus the tree, then **↑/↓** move a cursor between folders, **→/←** expand /
  collapse (or step to a child / parent), **Home/End** and **PageUp/PageDown**
  jump around, **type a name** to move the cursor to a matching folder, and
  **Enter** opens the cursor's folder in the feed. While the tree is focused the
  grid's shortcuts stand down. All listed in the **?** shortcuts overlay.

## 2.16.23

- **"Select all" now asks in a modal, not the easy-to-miss status bar** — both the
  ⌘A whole-view prompt and the per-folder "select all N photos?" prompt.
- **Export is simpler: pick the folder, then Copy or Move.** The separate "new
  folder name" box is gone — the folder you pick (or create in the Choose… dialog)
  is the destination. Move is now its own coloured button instead of a checkbox,
  and finishing closes the dialog with a "Moved N → …" / "Copied N → …" status.
- **You can now export straight into a scanned folder** (it was wrongly blocked).
- **Adding a folder jumps the feed to it** so its photos are on screen right away.

## 2.16.22

- **Auto-albums now name folders `2018_06Jun_30_Chicaque` by default** — the date
  (`%Y_%m%b_%d`) followed by the folder the photos came from. Open ⚙ Options to
  pick a different scheme from the naming dropdown (year subfolder, ISO date, …)
  or type your own; the new `%f` token drops in this folder's name.

## 2.16.21

- **After jumping to a folder (tree or scrubber), you can scroll up to the
  previous folders again.** A jump landed you at the top with the earlier folders
  locked out; they now load above the landing as they did before, so scrolling up
  keeps browsing backward. (Regression from the 2.16.18 jump-bounce fix.)

## 2.16.20

- **Jumping to a folder from the tree no longer lands on an empty feed.** For a
  rare folder whose stored path ended in a slash, clicking it in the tree showed
  "No photos to show here" (the scrubber worked); the tree now jumps to the
  folder's exact value like the scrubber does.

## 2.16.19

- **The tree now keeps your place in view as you scroll — new "👁 Follow" toggle,
  on by default.** The tree scrolls to (and opens) whichever folder is at the top
  of the feed as you scroll, centring it in the list. A folder you've collapsed by
  hand stays collapsed — Follow won't reopen it. Turn it off next to Expand all /
  Collapse all. The Library header and the tree's buttons now stay pinned while
  the folder list scrolls.

## 2.16.18

- **Jumping to an album (scrubber, tree, or fisheye) no longer bounces to a
  neighbouring album.** When you dragged the scrubber to an album from a
  scrolled-down position, the feed would land on the right album and then slide
  onto the one before it (most visibly when that album followed a tiny one).
  Jumps now reset the scroll and pin the landing exactly like the keyboard
  group-jump already did.

## 2.16.17

- **Scrubber: the viewport marker no longer hiccups backward while scrolling.**
  Inside a group larger than one page (e.g. a camera or folder holding tens of
  thousands of photos), each background page-load used to grow the marker's frame of
  reference and jerk it back up a notch. The marker now measures your position
  against the group's true size, so it only ever advances as you scroll down.

## 2.16.16

- **Scrubber: big groups always get a label.** Rail labels are now thinned by group
  size, so a dominant group keeps its label instead of losing it to a tiny neighbour
  that merely sorts just above it. Grouping by camera, a Canon 70D holding ~30% of the
  library no longer goes unlabeled (its band previously showed the next camera's name);
  the same helps large folders in the uniform folder view.

## 2.16.15

- **Scrubber: choose the folder landmark style.** Settings → Scrubber rail → "Folder
  landmarks" switches between **Uniform** (leaf-folder names spaced evenly down the
  rail — the original look) and **Tree** (one label per library-tree branch, like the
  sidebar). Only affects folder grouping; year/month landmarks are the same either
  way. (Replaces the short-lived 2.16.14 show/hide toggle.)

## 2.16.13

- **Scrubber: folder landmarks now follow the library tree.** The rail labels the
  folder branch you're in (the same level the sidebar shows) instead of each leaf
  folder's first word — so sibling folders like `fotos_historia` and `fotos_pruebas`
  no longer show up as two misleading "fotos" marks, and the labels stay meaningful
  even when folder names don't start with a date.

## 2.16.12

- **Scrubber: readable folder landmarks + a right-anchored name tooltip.** When
  grouping by folder the rail no longer stacks hundreds of folder names — it labels
  where the folder's leading token changes (for `2010_..`-style names that reads as
  clean year markers), while every fine folder still drives density and scrubbing.
  Hovering or dragging the rail now shows the full folder name in a chip anchored to
  the right edge, so long names stay readable instead of running off-screen.

## 2.16.11

- **Scrubber: keyboard hops, a hover fisheye, and a marker that tracks smoothly.**
  `[` and `]` jump to the previous/next landmark. Hovering the rail magnifies the
  nearby labels so a dense rail stays scannable. The viewport marker now rides the
  same scale as the landmarks and interpolates within a group, so it keeps moving
  as you scroll through a big year/folder — and dragging to a spot leaves the
  marker exactly there (it no longer snaps a couple of years off, and clicking a
  year on the value axis lands on that year). The drag tooltip updates live.

## 2.16.10

- **Scrubber can now show a date "scent," and you can switch what the rail
  measures.** A new Settings → Scrubber rail option toggles the rail between "by
  photo count" (the thumb tracks your scroll) and "by sort value" (landmarks
  spaced by date/number, like the top timeline, with a temporal-density scent).
  Value spacing falls back to count for folder/categorical grouping.

## 2.16.9

- **The scrubber is now draggable, resizable, and readable.** Drag anywhere on the
  rail to scrub — a floating preview shows the target folder/landmark and the jump
  commits when you release. Drag the rail's left edge to make it as wide as you
  like (persisted), so long folder names are fully readable; hovering a label also
  pops its full name out over the grid.

## 2.16.8

- **New scrubber rail on the right edge of the feed.** It shows the whole
  library's shape for the current grouping — a density track and labeled
  landmarks (folders, years…) — with a thumb that tracks where you are as you
  scroll. Click a landmark to jump straight to it. (First slice; drag-to-scrub,
  a date "scent", and a count/value axis toggle are coming next.)

## 2.16.7

- **Aggressive scrolling no longer "refreshes the whole page."** When a hard
  fling overshot past the loaded rows into the scroll reserve, the grid used to
  tear every tile down to nothing for a beat and then rebuild — a jarring blank
  flash that lost your place. It now keeps the last screenful mounted until the
  next rows load in, so the redraw is incremental and your context stays put.

## 2.16.6

- **Fast flings no longer stop dead at a false "end of page."** While there are
  more photos to load, the grid now keeps a scroll reserve below the loaded rows
  so a quick flick keeps gliding and the loader fills in underneath, instead of
  the scroll slamming to a halt because it thought it hit the bottom. (Part of
  the Adaptive load-ahead setting.)

## 2.16.5

- **Fast scrolling no longer reaches the end of the feed before more loads.**
  Each load now fetches enough photos to cover the screen you're flinging past
  instead of a fixed batch, so the smallest thumbnails keep up with the fastest
  scroll (a benchmark measured ~70% blank frames → ~0%).
- **New Scrolling & prefetch settings** (press <kbd>,</kbd> or the ⚙ button) let
  you pick how aggressively the grid prefetches — Off, Baseline, Balanced
  (default), Conservative, or Custom sliders — and toggle the adaptive page size,
  all applied live so you can feel the difference on your own library.

## 2.16.4

- **Scrolling prefetches thumbnails in the direction you're heading**, scaled to
  how fast you scroll, so tiles appear instantly instead of loading in behind the
  scroll. The look-ahead is bounded so it never starves the tiles you're actually
  looking at.

## 2.16.3

- **Nicer loading tiles.** A photo that hasn't loaded yet now shows a subtle
  diagonal-striped placeholder with its filename centered on it, so you can see
  which file a slow tile is before it renders (replacing the old spinner). Loaded
  tiles get a soft gradient along the bottom edge behind the rating stars — and on
  hover — so the stars stay legible over any photo without darkening the grid.

## 2.16.2

- **The grid no longer jumps as photo details load, or when you resize or zoom.**
  Tiles used to slide to their new positions whenever the layout recomputed
  (metadata streaming in, a window resize, a zoom change), sliding whatever you
  were looking at out from under you. Now the tile at the top of your view stays
  put — the grid re-lays-out around it instead of scrolling away — and tiles snap
  into place rather than gliding.

## 2.16.1

- **`electron:dev` now opens the app instead of a blank window.** On machines
  where Vite bound only IPv6 (`::1`), Electron looked for the UI on IPv4
  (`127.0.0.1`) and found nothing. The dev server is now pinned to IPv4 loopback,
  matching the API server and Electron, so the desktop dev window loads reliably.

## 2.16.0

Packaged build. Bundles everything since 2.15.0 — headlined by the move to
**Svelte 5 (runes)** with a full dependency modernization, and the new
**missing-files review** feature.

- **The app is rebuilt on Svelte 5 (runes)** with every dependency brought up to
  its current release (Vite, Vitest, Playwright, Express, Electron, and the native
  modules). No change to how the app looks or works — it's the same app on a
  modern, supported foundation.
- **Review missing files.** When a photo disappears from disk, the app tells you
  and opens a review panel to relocate it to where it moved (keeping its rating,
  albums and tags) or dismiss it. Files that simply moved are relocated
  automatically; copies still backed up on another drive are flagged, not lost. (#1)
- **The library tree shows where you are** — an amber dot on the group you're
  working in and a grey eye on the top of the feed, matching the timeline. (#130)
- **The Fisheye sidebar fills the whole pane**, and right-clicking a feed section
  header now opens the same menu the folder tree offers. (#128, #126)
- Plus the 2.15.x fixes: burst stacks in the loupe filmstrip, removing a
  photo-less parent folder, the Export panel and status-bar layout, and search
  reliability on large libraries.

## 2.15.18

- **Missing-file review polish.** The "files went missing" notice reads as an
  informational message instead of an error; the review list now uses the same
  volume-mounted check as the library (so a drive remounted elsewhere isn't
  mistaken for a missing one); and relocate/carry gained direct API tests. (#1)

## 2.15.17

- **Missing-file review is safer and more complete.** A single-folder rescan now
  reports files that went missing, just like a recursive one; and relocating a
  missing file into a folder that already holds a different rated photo of the
  same name is refused instead of silently overwriting it. (#1)

## 2.15.16

- Test: guard that the missing-files review panel opens and renders. (#1)

## 2.15.15

- **Review missing files.** When a photo disappears from disk, the app now tells
  you and offers a review panel to relocate it to where it moved (keeping its
  rating and albums) or dismiss it. Files that simply moved are relocated
  automatically; copies still backed up elsewhere are flagged, not lost. (#1)

## 2.15.14

- **Missing files have an API.** The app can now list photos that vanished from
  disk, relocate one to a new folder, or dismiss it. (#1)

## 2.15.13

- **Emptied folders are noticed.** Removing every file from a folder now marks
  those photos missing on the next rescan instead of leaving stale entries. (#1)

## 2.15.12

- **Moved photos are recognised automatically.** After a scan, a file that
  simply moved on disk is relocated in place with its rating and albums intact;
  copies that are still backed up elsewhere are never touched. (#1)

## 2.15.11

- **Groundwork for missing-file review:** the index now remembers when a photo
  was first seen and can tombstone a removed file recoverably. (#1)

## 2.15.10

- **The library tree shows where you are.** An amber dot marks the group holding
  the photo you're working on, and a grey eye marks the group at the top of the
  feed — the same two anchors, and the same colours, as the timeline. When both
  land on the same group only the amber dot shows. (#130)

## 2.15.9

- **The Fisheye sidebar fills the whole pane.** Its bars used to stop 6px short of
  the right edge; they now reach the divider, using the full sidebar width. (#128)

## 2.15.8

- **The Export panel opens again.** It had started rendering clipped/behind the
  feed — a status-bar overflow rule (added to keep long messages from widening the
  app) was cutting off the pop-up, which lifts up over the feed from the Export
  button. The pop-up shows in full again, and long status messages still don't
  widen the window.

## 2.15.7

- **You can now remove a parent/ancestor folder that has no photos of its own.**
  Right-clicking a folder whose photos all live in sub-folders offered a red
  "Remove" that looked clickable but did nothing — it was disabled because that
  folder has no row of its own. Now that removal takes the whole subtree, the item
  is enabled (worded "Remove folder and its contents…") and removes the folder and
  everything under it.
- **A disabled menu item can no longer look enabled.** A greyed-out action in a
  right-click menu now always reads as disabled, even destructive (red) ones — a
  disabled item was being painted in the danger colour and looked clickable.

## 2.15.6

- **Removing a parent folder now removes everything under it.** "Remove from
  library" on a folder that has sub-folders used to drop only that one folder's
  own photos — the sub-folders stayed indexed and immediately rebuilt the parent,
  so it looked like nothing happened. It now removes the folder and its whole
  subtree in one go (index only — files on disk are never touched), and reports
  exactly what came out in the status bar. (#127)
- **A long status message no longer stretches the window.** The status bar text
  now truncates with an ellipsis (full text on hover) instead of forcing the app
  wider than its window.

## 2.15.5

- **The loupe filmstrip handles bursts exactly like the grid.** Clicking a burst
  cover in the strip expands it in place; the members draw as one tight run with a
  connecting line behind them, each showing the same ⚏ marker (gold on the cover),
  and clicking that marker collapses the burst again. The badge and marker are now
  a single shared control, so the strip and the grid can't drift apart. (#127)

## 2.15.4

- **The loupe filmstrip shows bursts.** A collapsed burst now carries the same ×N
  badge in the filmstrip that it does in the grid, and the members of an expanded
  burst share an accent edge — so you can see the burst you're paging through
  instead of a flat, unmarked strip. (#127)

## 2.15.3

- **Right-click a group header in the feed to get its menu.** The same actions the
  folder tree offers — Jump, Select all, Keep only, the grid/snapshot/collapse
  view-cycle, and (for folders) Reveal in Finder, Copy path, Rescan, and Remove —
  are now a right-click away on any feed section header, not just in the sidebar.
  (#126)

## 2.15.2

- **The folder tree keeps your collapse/expand choices when you filter.** Folding
  a folder and then typing in search (or brushing the timeline) no longer springs
  it back open — your layout only resets when you actually change the grouping.
  (#125)

## 2.15.1

- **Browsing a large library no longer fails with "Failed to fetch."** Opening,
  searching, or clicking a folder while nothing is selected used to fire one
  request per group — around a thousand at once on a big library — which
  overwhelmed the browser and could leave the feed or folder tree blank. The
  group select indicator now skips that work entirely when you have no selection,
  and paces the requests when you do. (#4)

## 2.15.0

Packaged build. Bundles everything since 2.14.0 — folder hierarchy in the feed,
the toolbar reorganisation, a compact jobs widget, and the folder-order and
snapshot-fold work from this round.

- **The feed shows folder subtrees, not a flat list of paths** — the same nested
  shape the sidebar draws, with every ancestor pinned as you scroll. Folders walk
  in tree order.
- **Folders follow the sort you picked.** With "Taken, ascending" the first folder
  is the one holding your oldest matching photo, and it re-ranks when you change
  the filter. (#14)
- **Right-click a folder in the tree** to reveal it in Finder, rescan it, copy its
  path, or remove it from the library. (#2)
- **The toolbar reorganised into labelled groups**, holds one line, gives the
  timeline room, and folds groups into dropdowns when the window is too narrow
  instead of pushing controls off the edge. (#3, #9)
- **Selecting a folder selects the photos inside it**, with a partial-state icon
  and a confirmation past ~1,000 photos. (#8)
- **Job notices stopped stacking up over the photos** — they live in a compact,
  dismissable widget in the status bar now. (#4)
- **Folding a group into a snapshot is animated**, and the strip lines up exactly
  with the photos it replaced. (#12)
- **Closing a photo returns you to the view you opened it from** — a snapshot
  stays a snapshot. (#11)

## 2.14.20

- **Folding a group into a snapshot is animated.** The strip now unrolls from
  exactly the spot, and at exactly the photo size, that the group's first row of
  photos occupied, while the photos below it glide up — so a fold reads as the grid
  closing rather than as photos blinking out and a widget blinking in.

## 2.14.19

- **The toolbar folds instead of overflowing.** Make the window narrow enough and
  the toolbar's groups used to slide off the right edge, taking Sort and the zoom
  slider with them. Now a group that no longer fits collapses into a labelled
  dropdown — click it and you get the same controls, in the same state, in a
  panel. They come back on their own when you widen the window. A folded Filter
  group stays lit while it's hiding photos, so the reason you can only see 300 of
  them is still visible even when the control is not.

## 2.14.18

- **Folders now come in the order you asked for.** Grouped by folder, the feed and
  the tree used to list folders alphabetically no matter how you sorted. Now they
  follow the sort: with "Taken, ascending" the first folder is the one holding your
  oldest matching photo, and it re-ranks when you change the filter — filter to 5
  stars and you get the folder with the oldest five-star shot. Folders still nest,
  and a parent is still ranked by the best photo anywhere beneath it.

## 2.14.17

- **Closing a photo puts you back where you opened it from.** Open a photo from a
  snapshot strip and press Esc, and you get the strip back — not the group's full
  grid with the feed scrolled somewhere else.

## 2.14.16

- **Grouping by folder name is flat again, matching the tree.** The feed was
  nesting it into a hierarchy while the sidebar listed it flat, so the two
  navigators disagreed about the shape of the same library.

## 2.14.15

- **A group no longer jumps when you toggle it to a snapshot.** The strip now
  starts exactly where the group's photos started, and its photos are the same
  size as the ones in full view — they follow the zoom, instead of being stuck at
  a fixed size.
- **The timeline's settings popover opens again.** It was being clipped when the
  timeline moved into the Filter box.
- **The ＋ is the toolbar's one primary button**, and adding a folder and managing
  your library both live behind it.
- **Clear the filters from the Filter group's own label**, and the toolbar's
  groups sit tighter.

## 2.14.14

- **The cycle-all button says what it will DO**, not what it already is. It read
  "Full view" while everything was in full view — so the only way to find out what
  pressing it did was to press it. It now offers the next step: Snapshot all →
  Collapse all → Expand all.

## 2.14.13

- **Every toolbar control now sits in a named, bordered group** — Library, Filter,
  Group, View — so the bar tells you which control is the reason you can only see
  300 of your 114,000 photos. The Filter box lights up when something in it is
  actually hiding photos.
- **The timeline is back with the filters**, where it belongs: it narrows by
  capture time exactly as the stars and the kinds do, and it takes all the width
  the row has left.
- **Grouping moved next to Tree/Fisheye.** It isn't a filter — it hides nothing,
  it decides how what's left is carved up, which is the same question the sidebar
  switch answers.
- **The big blue "Folders" button is gone.** Adding a folder and managing your
  library both live behind the ＋, named.
- Locate is an icon, and Sort is quieter — neither was earning the space it took.

## 2.14.12

- **The timeline gets a row of its own**, directly under the filters it belongs
  with. It is about five times wider than it was: the whole span of the library
  is legible at once, and brushing the gap between two shoots is no longer a game
  of pixels.
- **Locate and Auto Albums moved down** to sit with the view controls, which is
  what made the room.

## 2.14.11

- **The timeline sits with the filters**, where it belongs — it narrows the
  library by capture time exactly as the stars and the kinds do, so the whole of
  what's currently narrowing your view reads as one row.
- **"Full view" moved to the second row**, next to size, burst and order. It sets
  how every group is drawn, which is what those do; Locate and Auto Albums, which
  actually do something, stay on top.

## 2.14.10

- **Selecting a folder now selects what's inside it** — including the photos in
  the folders under it. Clicking a parent used to leave the checkbox saying
  "nothing selected" while its children were full, and a folder that holds only
  sub-folders could never be selected at all.
- **A parent shows a partial mark** when only some of the photos beneath it are
  selected, so you can see where a selection reaches without opening every folder.
- **Shift-click a folder's checkbox to take it all back out** of the selection,
  whatever state it's in — the mouse equivalent of ⌘⇧A, and undoable.
- **Selecting more than 1,000 photos in one click asks first**, naming the folder
  and the count. One click on a folder near the root of a big library is worth
  the whole library.

## 2.14.9

- **Job notices no longer pile up over your photos.** Converting a video used to
  leave a "Converting…" row behind forever, one per clip, in a strip that took
  its height straight out of the grid. A conversion that succeeds now clears its
  own notice, and the rest live in a small pill in the status bar's corner that
  opens a scrollable list — the grid keeps its full height however many jobs run.
- **Dismiss all.** One click clears every finished job. Anything still running
  keeps running.
- **The "keep only" chip moved next to the showing count**, which is the number
  it explains.
- A finished video conversion or metadata read used to show a blank summary next
  to its ✓. It now says what it did.

## 2.14.8

- **The toolbar stays on one line.** Adding a third grouping dimension used to
  push the group-by pills onto a second row and shove everything else around.
  Now the row compresses instead of wrapping, and the search box is the only
  thing that gives up width — the pills and the filters keep theirs.
- **The timeline is nearly four times wider.** It moved to a second toolbar row
  of its own, where the date labels at each end are readable instead of clipped.
- **Size, burst and order are back in the toolbar**, next to the other view
  controls, instead of down in the status bar.
- **Tree / Fisheye sits above the sidebar it switches**, on the left of the
  second row, rather than lost among the view buttons.

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
