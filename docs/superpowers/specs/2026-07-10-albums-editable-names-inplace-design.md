# AutoAlbums: editable names + in-place move default (Slice A) — design

_2026-07-10. First of two slices for John's request: (A) edit album folder
names before materializing and default materialize to move-in-place; (B) rename
folders in the feed (disk rename + reindex) — **B is a separate spec/branch.**_

## Goal

Make materializing auto-albums a one-click "organize this folder in place" action:

1. **Edit each album's folder name** before materializing, instead of accepting
   the auto-generated `YYYY-MM-DD` name.
2. **Default the destination to the folder you've opened** (the `focusPath`
   added by #66) so album subfolders are created *inside* it, and **move**
   (already the default) relocates the originals into them. When you're not
   focused on a folder, the destination is empty and you pick one.

## Invariants & authorization

- Writing *into* a scanned source folder normally violates
  `resolveExportTarget`'s guard (it refuses targets inside any scanned source
  folder). John has **explicitly authorized** materializing in place, so this
  slice relaxes that guard for materialize only (see [[export-into-source-folder-ok]]
  in agent memory). Path-traversal and cache-root guards stay.
- **Folders on disk stay the source of truth.** Move relocates real files;
  `repointPhoto` keeps the index in sync; rescans surface the new dated
  subfolders as normal sections.
- **Undo stays session-only** (existing JobsPanel Undo, backed by the in-memory
  job registry). Persisting the manifest across restarts is explicitly out of
  scope for this slice (decided with John).

## Server changes

### `resolveExportTarget` — opt-in `allowInsideSource`

`server/api.js`. Add a fourth options arg:

```js
function resolveExportTarget(db, destParent, folderName, { allowInsideSource = false } = {})
```

When `allowInsideSource` is true, skip **only** the "refuses target inside a
scanned source folder" check (the `SELECT abs_path FROM folders` loop). The
path-traversal (`safeResolve`) and cache-root (`isPathContainedIn(cacheRoot())`)
checks always run. Default `false` preserves current behavior for `/api/export`.

The **`POST /api/albums/materialize`** handler passes `allowInsideSource: true`
when resolving each album's target, since in-place is now the default use.

_No timeline change is needed_ — the "current folder" comes from the UI's
existing `focusPath` (issue #66), not from a new server query.

## UI changes

### `AlbumsView.svelte`

- **Editable names.** Derive a `names[]` array from `albums`. Re-seed it from the
  defaults whenever the cluster set structurally changes — track an
  `albumSig = albums.map(a => `${a.index}:${a.ids.length}:${a.startAt}`).join("|")`
  and reset `names` only when `albumSig` changes (so slider re-clustering
  re-seeds, but edits persist within one clustering). Render each album divider's
  name as an `<input class="album-name-edit" bind:value={names[i]}>`.
  `namedAlbums()` builds `{ name: names[i], photoIds: album.ids }`, then applies
  the existing `_2`/`_3` disambiguation over the (possibly user-edited) names so
  duplicates never merge into one folder.
- **Default destination.** New prop `export let defaultDest = ""`. Initialize
  `dest` from `defaultDest` when present, else the remembered
  `localStorage["autogallery.exportDest"]`. Re-apply when `defaultDest` changes
  and the user hasn't edited `dest`. Move stays the default radio.

### `App.svelte`

- Pass `defaultDest={focusPath || ""}` to `<AlbumsView>` — the opened-folder path
  from #66. No new state.

## Testing

- **Server (`server/api.test.js`):**
  - `resolveExportTarget` / materialize: with `allowInsideSource`, materializing
    an album into a subfolder of a scanned source folder **succeeds** (files
    moved, index repointed); without the flag it still returns the
    "inside a scanned source folder" error.
- **UI:** editable names + in-place default verified live in the running app per
  the App.svelte manual-verification convention (`docs/ROADMAP.md`).

## Out of scope (this slice)

- Feed folder rename (disk rename + reindex) — **Slice B**, its own spec.
- Persistent/cross-restart undo of a materialize — deferred (session-only stands).
- Relaxing the source-folder guard for `/api/export` (the #5 copy path) —
  separate, tracked with issue #5's deferred notes.
