# Persistent multi-drive index — Design

Status: Approved, ready for implementation plan
Date: 2026-07-06

## Context & problem

This is the foundation piece for a larger interface change John wants: an
endless, cross-folder photo feed groupable by folder/day/month and later by
album and categorical tags (people, features, camera), plus knowing which
photos are backed up across his several external hard drives.

None of the two invariants in `CLAUDE.md` that describe this are actually
built yet:

- There is no SQLite index. `server/api.js` holds one in-memory
  `session = { root, items }`, replaced wholesale by every `POST /api/scan` —
  one folder at a time, gone on restart.
- Nothing is keyed by content hash. `ratings.json`, `coverChoices.json`, and
  `metacache.json` are all keyed by absolute path, and nothing tracks which
  source volume a folder came from.

Real data already exists under `~/.autogallery/` that a migration must not
drop: 7 ratings, 5 library folders (`library.json`), and a ~3.9 MB
`metacache.json`.

Prior art: John has six years-old prototypes of a closely related project,
"PhotoRing" (`/Users/aguerra/workspace/photoRing*`), whose whole premise is
navigating a large photo collection across multidimensional facets (date,
camera, tags) without losing context, zooming between 1/10/100 photos, and
jumping between "sections." Reusable ideas pulled from there: an EAV-style
dimension table for open-ended/multi-valued facets, and keyset pagination
centered on a focus row for infinite scroll. Not reused: its MySQL-specific
schema, Flickr/MoMA-specific columns, its jQuery+d3v3 frontend, and its
literal radial "ring" visualization (a different — possibly future —
alternate view, not what's being built here).

## Goal

A persistent, rebuildable SQLite index spanning multiple folders across
multiple (not-always-mounted) drives, that:

1. Gives every photo a stable id and identity that survives rescans.
2. Lets the feed (a later spec) group photos by folder/day/month cheaply,
   and by album/tags once those are populated.
3. Tracks which physical volume each folder lives on, using an identifier
   that survives remounts, so the app can report a folder/photo as
   "offline" (cached only) versus currently accessible.
4. Makes "is this photo backed up on another drive" a free query once
   populated (exact-hash match only — see "Out of scope").

## Schema

```sql
CREATE TABLE volumes (
  id INTEGER PRIMARY KEY,
  label TEXT,
  uuid TEXT UNIQUE,          -- diskutil Volume UUID; NULL when unavailable
  last_mount_path TEXT,
  last_seen_at INTEGER
);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  abs_path TEXT NOT NULL UNIQUE,
  volume_id INTEGER REFERENCES volumes(id),
  last_scanned_at INTEGER
);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  content_hash TEXT,        -- SHA1, filled in lazily after scan; NULL until hashed
  taken_at INTEGER,
  width INTEGER,
  height INTEGER,
  camera TEXT,
  kind TEXT NOT NULL,        -- 'image' | 'raw' | 'video'
  perceptual_hash TEXT,      -- reserved; populated by the follow-up dedup spec
  rating INTEGER NOT NULL DEFAULT 0,       -- 0-5, retires ratings.js/ratings.json
  preferred_cover INTEGER NOT NULL DEFAULT 0, -- retires coverChoices.js/.json
  stale INTEGER NOT NULL DEFAULT 0,  -- 1 = not seen in the most recent scan
  UNIQUE(folder_id, filename)
);
CREATE INDEX idx_photos_taken_at ON photos(taken_at);
CREATE INDEX idx_photos_content_hash ON photos(content_hash);

CREATE TABLE albums (               -- empty until #3 (album clustering) lands
  id INTEGER PRIMARY KEY,
  name TEXT,
  start_at INTEGER,
  end_at INTEGER
);
CREATE TABLE photo_album (
  photo_id INTEGER REFERENCES photos(id),
  album_id INTEGER REFERENCES albums(id),
  PRIMARY KEY (photo_id, album_id)
);

CREATE TABLE tags (                 -- empty until Phase-2 ML tagging lands
  id INTEGER PRIMARY KEY,
  dimension_name TEXT NOT NULL,     -- 'person' | 'feature' | ...
  value TEXT NOT NULL,
  UNIQUE(dimension_name, value)
);
CREATE TABLE photo_tags (
  photo_id INTEGER REFERENCES photos(id),
  tag_id INTEGER REFERENCES tags(id),
  source TEXT NOT NULL,             -- 'exif' | 'ml' | 'manual'
  PRIMARY KEY (photo_id, tag_id)
);
```

`albums`/`photo_album` and `tags`/`photo_tags` are created now but populated
by later work (album clustering, #3; ML tagging, Phase 2 per `CLAUDE.md`) —
this avoids a schema migration when those land, since John named
"categorical elements like people or features" as a concrete near-term
direction, not a hypothetical.

**Why not one uniform EAV table for everything** (as PhotoRing did): folder,
day/month/year are single-valued and cheaply derived from columns already on
`photos` (`GROUP BY folder_id`, `GROUP BY strftime('%Y-%m', taken_at)`).
Routing those through an EAV table would multiply every photo by every
dimension for no benefit. The `tags` table is reserved for genuinely
multi-valued or open-ended facets (a photo can have several people/features;
new tag dimensions arrive without a migration).

## Identity: content hash

`content_hash` = SHA1 over the full file (`node:crypto`, already used for the
thumbnail cache key — no new dependency). Computed **lazily**, in the
background, after the fast path+mtime+size scan already returns and the grid
paints — this never blocks first paint. A rescan of an unchanged file (same
path+mtime+size) skips re-hashing entirely, same as it skips re-processing
today.

`content_hash` is nullable and briefly absent right after a fresh scan.
Dedup/backup queries simply treat rows with a `NULL` hash as unmatched until
the background job catches up.

## Volume identity

`diskutil info <mountpoint>` exposes a `Volume UUID` on macOS that is stable
across remounts, even if the mount path or volume label changes (e.g. two SD
cards sharing a label). This is what `volumes.uuid` stores, and what
determines "is this folder's volume currently mounted" — not the raw path
check `library.js` does today.

No Windows/Linux implementation now — the Electron packaging for those
platforms isn't shipped yet (per `docs/ROADMAP.md`), and there's no way to
test it. When `diskutil` is unavailable, `volumes.uuid` stays `NULL` and the
app falls back to today's path-existence check.

## Data flow

1. **`POST /api/scan`** changes from "replace the in-memory session" to
   **upsert** into `folders` + `photos`, keyed by `(folder_id, filename)`.
   Unchanged files (same size+mtime) are skipped entirely (already the
   scan's fast-path contract); changed files update in place; files no
   longer present are marked `stale = 1`, not deleted (see "Renames/moves"
   below). `GET /api/thumb/:id` and `GET /api/image/:id` change minimally —
   `itemById(id)` becomes a DB lookup by primary key instead of an array
   index.
2. **Library-wide indexing**: a new pass iterates every folder already
   recorded in `library.json`, scanning whichever volumes are currently
   mounted (via the volume-UUID check) and leaving folders on unmounted
   volumes as last-known-cached. This is what actually backs a cross-drive
   feed, rather than only ever knowing about the last-scanned folder.
3. **One-time migration**, run on first startup against the new DB: import
   `ratings.json` (→ `photos.rating`), `coverChoices.json` (→
   `photos.preferred_cover`), `library.json` (→ `folders`/`volumes`), and
   `metacache.json` (→ `photos.taken_at`/`width`/`height`) into the new
   tables, matched by absolute path. Guarded so it only runs once (skipped
   once `photos` is non-empty). `ratings.js`, `coverChoices.js`, and
   `metaCache.js` are retired by this plan — their JSON files are read once
   by the migration and not written again; `GET/POST /api/rating` and
   `GET/POST /api/cover` become DB reads/writes against the `photos` row
   instead. This also fixes a real fragility in the JSON stores: a
   path-keyed rating breaks on file rename/move, whereas the DB row (keyed
   by stable id, later re-linkable via `content_hash`) does not.

## Error handling / edge cases

- **Unmounted volume**: folders under it stay queryable (metadata/ratings
  from cache, offline badge); a scan simply skips folders whose volume
  isn't currently mounted.
- **Renamed or moved file**: not identified as "the same photo" by path — it
  creates a new `(folder_id, filename)` row. The old row is marked
  `stale = 1` rather than hard-deleted, so a temporarily-unmounted or
  slow-to-enumerate drive is never mistaken for "these files were deleted."
  (Once `content_hash` backfills, a stale row and a new row sharing a hash
  is a detectable "this looks like the same photo, renamed/moved" case —
  worth a future UI affordance, out of scope here.) Feed/grouping queries
  (the follow-up spec) filter `stale = 0` by default; ratings and other
  path-independent data tied to a stale row are not deleted, only hidden
  from normal browsing.
- **Hash job failure** (unreadable file, permissions): `content_hash` stays
  `NULL`; the photo is otherwise usable (thumbnail/rating/grid) — hashing
  failure never blocks culling.

## Out of scope (deliberately)

- **Perceptual/near-duplicate hashing** — needed to match `fotos_peq`'s
  resized copies against full-res originals on other drives (exact
  `content_hash` won't do this, since resizing changes every byte). Real
  algorithmic work (library/threshold choice) that John wants to tune
  himself, like the burst-stack thresholds. Follow-up spec, tracked
  separately.
- **Populating `tags`/`photo_tags`** — schema only; ML tagging is Phase 2
  per `CLAUDE.md`.
- **The grouped endless-feed UI itself** (keyset-paginated queries, grouping
  selector, infinite scroll) — this spec is the data layer it will be built
  on top of. Follow-up spec.
- **Windows/Linux volume identity.**

## Testing

vitest, colocated `*.test.js`, following the existing pattern
(`server/processing/ProcessingService.test.js`, `server/lib/safeResolve.test.js`):

- Schema creation + upsert idempotency: scanning the same synthetic folder
  twice produces no duplicate rows and preserves ids.
- Changed-file handling: mtime/size change updates the row in place; stale
  marking for files no longer enumerated.
- Volume offline/online transition: folder queries still return cached
  metadata when the (fake) volume is reported unmounted.
- Backup-coverage query: synthetic photos sharing a `content_hash` across
  two `volume_id`s are correctly identified as backed up; one without a
  match is not.
- JSON→DB migration: fixture-shaped `ratings.json`/`coverChoices.json`/
  `library.json`/`metacache.json` import correctly and the migration guard
  prevents a second import.

All fixtures are synthetic, created per-test — never the real read-only test
folders in `docs/TEST_FOLDERS.local.md`.

## Validation

After implementation, run the library-wide index against
`/Users/aguerra/Pictures/fotos_peq` (~111,310 files, 2002–2018,
`YYYY_MMMon_DD_Name` album folders — see `docs/TEST_FOLDERS.local.md`) and
report: total scan+hash time, and a spot-check backup-coverage query against
one of the SD-card test folders. Read-only, per the working agreement in
`docs/ROADMAP.md`.
