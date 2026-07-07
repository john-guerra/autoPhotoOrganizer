# Library cleanup — folder removal & cache management — Design

Status: Approved, ready for implementation plan
Date: 2026-07-07

## Context & problem

Two related gaps surfaced during manual testing this session: (1) removing a
folder from the SQLite index currently requires hand-written SQL (done
manually earlier this session to clean up a stray test folder) — there's no
UI for it; (2) the thumbnail disk cache
(`~/.autogallery/cache/thumbs/<sha1>.jpg`) has no visibility or management
UI at all (tracked as GitHub issue #31), and was also cleared manually via
`rm -rf` earlier this session to force a cold-scan test. Both are real,
recurring needs for testing and everyday use, not just this session's
one-offs.

This spec covers both: a "Manage library" panel reachable from the existing
"Library ▾" dropdown, offering folder removal and full cache management
(size, per-folder breakdown, clear, prune). This closes out GH #31.

## Goal

1. Remove any indexed folder (and its photos) from the SQLite index via a
   button, with real files on disk always untouched — exactly what the
   manual SQL cleanup did earlier this session, exposed as a proper action.
2. See the thumbnail cache's total size instantly, and its breakdown by
   source folder on demand.
3. Clear the entire thumbnail cache, or prune only orphaned entries
   (thumbnails whose source photo is no longer indexed) — both while
   preserving the "SQLite index is a rebuildable cache" invariant: neither
   action ever touches a source photo folder, only `~/.autogallery/`.

## Server: folder removal

**`DELETE /api/folders/:id`** — looks up the folder by id (404 if unknown),
runs `DELETE FROM photos WHERE folder_id = ?` then
`DELETE FROM folders WHERE id = ?` in a transaction. `photo_album` and `tags`
reference `photo_id`/`folder`-scoped data but are unused today (album
clustering, GH #3, isn't implemented yet — `photo_album` has zero rows in
the current index) — no cascade cleanup is needed now; this will need
revisiting once album clustering lands and starts populating that table.
Real files under the folder's `abs_path` are never touched — only the
`folders`/`photos` rows.

`GET /api/library`'s response gains an `id` field per entry (it currently
returns only `path`/`name`/`lastScannedAt`/`mounted` — the DB row's `id` is
already available in that route's query, just not selected into the
response) so the client can target a folder for removal precisely, without
relying on path-string matching.

## Server: cache stats & breakdown

**`GET /api/cache/stats`** returns `{ totalBytes, totalFiles }` — a single
`readdir` + `stat` pass over `thumbsDir()`, independent of library size,
always fast.

**`GET /api/cache/breakdown`** (separate, on-demand route, not bundled into
the stats call above) returns
`{ folders: [{ id, path, cachedBytes, cachedFiles }] }`. For each folder,
iterate its photos; for each photo, and for each of the five buckets in
`THUMB_BUCKETS = [160, 320, 480, 640, 1024]` (this exact list, copied from
`ui/src/App.svelte`, which snaps every displayed thumbnail request to one of
these five sizes specifically to avoid fragmenting the cache — this is why
checking exactly these five buckets, not an arbitrary size range, correctly
covers every size the client could ever have requested), recompute
`sha1(path:mtime:size:bucket)` (the exact key formula already used by
`GET /api/thumb/:id`, using the `photos` table's `mtime`/`size` columns —
note `size` appears twice in the key, once for the source file's own byte
size and once for the requested thumbnail bucket) and check with
`existsSync`/`statSync` whether that cache file exists, summing sizes for
hits. With today's real library (~135k photos), this is a bounded but real
cost (up to 5 existence checks per photo) — acceptable for an explicit,
on-demand action, not something to run automatically.

## Server: clear & prune

**`POST /api/cache/clear`** deletes every file under `thumbsDir()`
unconditionally — the same operation as the manual `rm -rf` done earlier
this session, now a button. Fully safe: the cache is content-hash keyed and
rebuilds automatically as thumbnails are re-requested.

**`POST /api/cache/prune`** computes the same "photo × bucket → expected
hash" set described above, but across *every* photo in the index (not one
folder), then deletes any file in `thumbsDir()` whose filename (sans `.jpg`)
isn't in that expected set — these are orphans: thumbnails for photos or
folders removed from the index, or stale entries left behind when a file
changed on disk (mtime/size shifted, changing its cache key) before a
rescan. Returns `{ freedBytes, freedFiles }`. Both routes only ever operate
on `thumbsDir()`; no source folder is ever touched by either.

## Client: "Manage library" panel

A new "Manage library…" item in the existing "Library ▾" dropdown
(`ui/src/App.svelte`, alongside the existing per-folder entries) opens a
modal — this app has no existing modal/confirmation UI at all today, so
this introduces the first one. It lists every indexed folder (name, path,
the existing mounted/offline badge, and now a photo count) with a "Remove"
button per row — confirms via a native `confirm()` dialog (the simplest
option given there's no modal component to reuse yet; a custom in-app
confirmation UI would be a reasonable follow-up if more destructive actions
accumulate, but isn't warranted for this one action), then calls
`DELETE /api/folders/:id`, removes the row from the list, and refreshes the
main `Library ▾` dropdown. There's no existing precedent in this app for
"the folder currently being viewed just disappeared" (today, an unmounted
folder's entry is simply disabled/unclickable in the dropdown — nothing
handles a folder vanishing out from under an active view) — this spec
introduces that handling fresh: if the removed folder's path matches (or is
an ancestor of) the current view's active path, the panel closes and the
feed resets to its default, top-of-library state, clearing any active tree
jump. Removing a folder NOT currently being viewed leaves the feed
untouched.

Below the folder list: total cache size loads immediately on modal open
(via `GET /api/cache/stats`); a "Show breakdown" button triggers
`GET /api/cache/breakdown` and renders a size per folder; a "Clear cache"
button confirms, then calls `POST /api/cache/clear` and refreshes the
total; a "Prune orphaned" button calls `POST /api/cache/prune` directly (no
confirmation needed — it only ever removes files with no corresponding
indexed photo, nothing a user would recognize as "their data") and reports
how many files/bytes were freed.

## Testing

- `server/db/folders.test.js` (or alongside existing folder tests): removing
  a folder deletes its `folders` and `photos` rows; a second, untouched
  folder's rows and a real fixture file on disk are both unaffected.
- `server/api.test.js`: `DELETE /api/folders/:id` — 404 for unknown id, 200
  and rows gone for a real one; `GET /api/library` now includes `id`;
  `GET /api/cache/stats` reflects actual bytes/files written to a temp cache
  dir fixture (mirroring this file's existing thumbnail-cache test
  isolation pattern); `GET /api/cache/breakdown` attributes a known cached
  thumbnail to its correct folder; `POST /api/cache/clear` empties the temp
  cache dir; `POST /api/cache/prune` removes an orphaned fixture file while
  leaving a live one alone.
- No automated tests for the new Svelte modal (this project's established
  convention, per `docs/ROADMAP.md`) — verified manually against the real,
  already-indexed library.

## Out of scope

- Renaming/moving folders in the index, or editing which subfolders within
  an already-scanned tree get included.
- Any UI for `photo_album`/`tags` cleanup — those tables are unused until
  album clustering (GH #3) lands.
- Automatic/scheduled cache pruning — both actions stay manual, user-
  triggered buttons.
- Cache size caps or eviction policy (GH #31's issue text mentions "no size
  cap" as background context, but doesn't ask for one) — this spec adds
  visibility and manual control, not automatic bounding.

## Validation

After implementation: open the Manage Library panel, confirm the folder
list matches `Library ▾`'s existing entries plus photo counts; remove a
small test folder, confirm its photos disappear from the feed and its real
files on disk are untouched; confirm total cache size matches what `du -sh
~/.autogallery/cache/thumbs` reports; trigger the breakdown and spot-check
one folder's reported size against a manual count; clear the cache and
confirm thumbnails regenerate on next view (matches this session's earlier
manual test); prune and confirm only genuinely orphaned files (if any exist
at that point) are removed.
