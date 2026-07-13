# Folder controls: one Add door, one scope, selective recursive add

Date: 2026-07-13
Status: approved, not yet implemented

## Problem

Three separate complaints, one cluster of UI:

1. **Two doors for one job.** The toolbar has a `Folders ▾` dropdown ("Manage
   folders…", "Open a folder…") _and_ a separate `＋` add-folder popover. But
   "Open a folder…" is, mechanically, "add + focus": `openFolderFocus` scans the
   path (forced `recursive: true`) if it isn't indexed yet, then calls
   `setFocus(path)`. The only thing it adds over `＋` is the focus step and the
   forced recursion.
2. **Two scope concepts.** `focusPath` (folder-focus) and `keepIds` (keep-only)
   are two chips, two exits, two mental models — for what the user experiences as
   one idea: "show me only this."
3. **Recursive add is all-or-nothing.** Pointing `＋` at a parent with "Include
   subfolders" on pulls in _every_ subfolder with media. There's no way to skip
   an `Exports/` or `Selects/` directory.

## Non-goals

- No schema change. `folders`, `keep_scope`, and `volumes` stay as they are.
- No new way to focus an already-indexed folder from the tree sidebar or Manage
  folders. The Add panel remains the single door (decided explicitly).
- No change to what a recursive scan _produces_: every scanned directory with
  media still becomes its own `folders` row.

## Design

### 1. Toolbar

`Folders ▾` currently holds two entries. Once "Open a folder…" moves into the Add
panel, only "Manage folders…" is left, so the dropdown is deleted. The cluster
becomes:

- `＋` — icon button, opens the Add panel. Tooltip + `aria-label` "Add a folder".
- `Folders` — text button, opens the Manage-library modal directly.

`＋` is universal; a bare icon for "Manage folders" is guess-the-icon, and this
app's discoverability rule (CLAUDE.md § Keyboard shortcuts: "a shortcut nobody
can find does not exist") applies equally to icons. Hence one icon, one label.

### 2. The Add panel — the single door

Opened by `＋`. Contents, in order:

- **Choose folder…** (native OS picker when available) — primary path.
- **or type a path** — the existing text input fallback.
- ☑ **Include subfolders** — `recursiveScan`, default on, as today.
- ↳ **Choose subfolders…** — expander, rendered only when Include subfolders is
  on. **Collapsed by default**, so the common case stays one click and never
  blocks on a directory walk of a big SD card. Expanding fetches the candidate
  list (§4) and renders the checklist (§3).
- ☐ **Focus on this folder only** — default off. This is the old "Open a
  folder…", now a checkbox. On submit, after any scan completes, the app enters
  folder scope on that path.

The primary button's label and behavior adapt to whether the path is already in
the library. This is what keeps the verb honest when the user re-picks a folder
they already have:

| Path state         | Focus checked | Button label | Behavior                                             |
| ------------------ | ------------- | ------------ | ---------------------------------------------------- |
| not in library     | either        | `Add & scan` | scan, then focus if checked                          |
| already in library | ☑             | `Open`       | **no scan** — enter folder scope straight from cache |
| already in library | ☐             | `Rescan`     | incremental rescan (catches up with disk)            |

The count is only known once the picker has been expanded and the walk has run.
So the label carries a count **only when a subset is actually in play**: while the
picker is collapsed (the common case, nothing walked yet) it reads `Add & scan`;
once the checklist is showing it reads `Add & scan 4 folders`, tracking the
checked count live.

The already-indexed + focus case MUST NOT scan. That is what makes today's "Open
a folder…" work with the external drive unmounted (per invariant 2: the SQLite
index is an offline mirror), and losing it would be a regression.

"Already in library" is the existing predicate from `openFolderFocus`:
`library.some(e => e.path === p || e.path.startsWith(p + "/"))`.

### 3. The subfolder checklist

A **depth-indented flat list** — exactly the directory list the server would
otherwise scan, so it maps 1:1 to the `folders` rows the scan will create:

```
☑ 2026-07-04 Trip          412
    ☑ RAW                   98
    ☐ Exports               12
☑ 2026-07-06 Beach         230
    ☑ RAW                   55

[All] [None]              Add & scan 4 folders
```

- All checked by default (a plain recursive add is the default outcome; opting
  _out_ is the deliberate act).
- Each row: checkbox, directory name indented by depth, media count.
- All / None toggles.
- Scrolls within the panel; a card with hundreds of dated folders is expected.

Selection state and the all/none logic live in a **pure module**
(`ui/src/lib/subfolderSelection.js`) so they're unit-testable without a DOM,
matching the codebase's pure-module convention (`feed.js`, `treeState.js`, …).

### 4. Server

Two changes, both additive.

**New: `GET /api/fs/subdirs?dir=…`**

Returns the candidate directories under `dir`:

```json
[
  {
    "path": "/abs/path/2026-07-04 Trip/RAW",
    "relPath": "2026-07-04 Trip/RAW",
    "depth": 1,
    "mediaCount": 98
  }
]
```

Built from the existing `listDirsRecursive(dir)` plus a per-directory media
count. Validates `dir` exists and is a directory, mirroring `/api/scan`'s
`statSync` guard, and returns `404` / `400` the same way. Directories with no
media are omitted — they'd produce no `folders` row anyway.

**Changed: `POST /api/scan` gains an optional `dirs: string[]`**

When `recursive` is true and `dirs` is present, the job scans exactly those
directories instead of the full `listDirsRecursive` walk. Job `total` becomes
`dirs.length`.

Each entry is validated: it must be an existing directory AND lie inside `dir`.
This is user-supplied path input arriving over HTTP, so the containment check is
a security boundary, not a sanity check — resolve both sides and require a true
path-prefix (a `/a/b` vs `/a/bc` prefix bug is the classic hole here). An entry
that fails validation rejects the whole request with `400`; we do not silently
drop it.

`dirs` absent → today's behavior exactly, unchanged.

### 5. Scope unification

`focusPath` and `keepIds` collapse into a single value:

```js
scope = null | { kind: "folder", path } | { kind: "ids", ids };
```

- **One chip, one exit ✕** in the UI, replacing the two chips.
- Folder scope keeps the cheap live `folderPath` predicate; ids scope keeps the
  `keep_scope` table. **The two kinds stay distinct underneath on purpose** —
  collapsing folder scope into an id set would materialize every id of a 10k
  folder (the #97 freeze shape), would freeze the scope so newly scanned photos
  never appear in it, and would drop reload persistence.
- Folder scope persists across reload (`localStorage`, as `focusPath` does
  today). Ids scope stays session-only (as `keepIds` does today: reset to `null`
  on load even though the server table survives).
- They are already mutually exclusive (`setFocus` clears `keepIds`); the union
  makes that structural rather than a manual clear.
- `setFocus` and `applyKeepOnly` today run near-identical rebuild sequences
  (epoch bump, counts reset, `await tick()`, `onGroupByChange`). They become
  **one** `applyScope(scope)`. CLAUDE.md § Debugging discipline explicitly warns
  against adding a seventh copy of this guard pattern; this removes one.

### 6. Failure modes

Per CLAUDE.md § Usability — every failure is visible, specific, actionable:

- Subdir listing fails (permission denied, unmounted volume, path vanished) →
  inline error **in the Add panel**, naming the path and the reason. Not a
  console error, not an empty list.
- Zero subfolders checked → the primary button is disabled **with the reason
  shown next to it**, not a dead button.
- The directory walk shows a spinner while it runs; the panel stays closable.
- Scan rejection (`400` from a bad `dirs` entry) surfaces as `result.error`
  inline, the existing pattern.

## Testing

**Server (vitest, colocated):**

- `/api/fs/subdirs` over a temp fixture tree: depth, counts, media-less dirs
  omitted; `404` on a missing path, `400` on a file.
- Scan with a `dirs` subset creates **only** the selected `folders` rows.
- A `dirs` entry outside `dir` is rejected with `400` — including the
  `/a/b` vs `/a/bc` prefix case.
- `dirs` absent → unchanged full-walk behavior.

**UI (vitest, pure modules):**

- `subfolderSelection.js`: all/none, per-row toggle, derived count.
- The scope union: transitions, mutual exclusion, what persists.

**Live verification (per CLAUDE.md and the live-verify convention):** drive the
real app — add a folder with a subset selected, confirm only those sections
appear; enter folder scope from the checkbox; confirm the already-indexed + focus
path does not scan.

## Delivery

Three PRs, in this order. The scope refactor touches the feed-window guard — the
riskiest surface in this codebase — and must not ride along with new UI:

1. **Scope unification** (`applyScope`, one chip). Pure refactor, no new
   features, behavior-identical.
2. **Control merge** (Add panel absorbs Open; dropdown deleted; `＋` + `Folders`).
3. **Selective recursive add** (subdirs endpoint, `dirs` param, checklist).

Each bumps the patch version and adds a `CHANGELOG.md` entry in the same commit,
per CLAUDE.md § Versioning.
