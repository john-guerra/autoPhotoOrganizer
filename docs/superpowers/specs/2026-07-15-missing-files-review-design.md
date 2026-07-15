# Missing-files review: delete-or-relocate, copy-aware (#1)

**Status:** design approved (brainstorming), pending implementation plan.
**Date:** 2026-07-15.

## Problem

The app already _detects_ files that vanished from disk — it just never tells
you. Every rescan runs `upsertScan`, which marks every row in the folder
`stale = 1`, then flips back to `stale = 0` only the files it actually found on
disk (`server/db/photos.js`). So after a rescan, **`stale = 1` already means "was
in the index, no longer on disk"**, and every feed query carries `stale = 0`
(`server/db/feed.js`), so a stale row silently drops out of the grid.

The cost: a file you delete or move in Finder disappears from the app with its
rating, album membership, tags and manual-stack orphaned in the DB, and there is
no way to see it, recover its metadata, or tell the app where it went.

Two facts make this more than a simple "list the stale rows" feature:

1. **Relocate must not lose user-authored state.** A moved file's row carries
   `rating`, `preferred_cover`, `no_auto_stack`, and is referenced by
   `album_members`, `photo_tags`, `keep_scope`, and `manual_stacks` (all keyed on
   `photo_id`). Any relocate has to preserve all of it.
2. **A photo can exist in multiple folders/volumes (backup copies).** The app
   already models this: `getBackupCoverage(db, photoId)`
   (`server/db/backupCoverage.js`) reports every volume holding the same
   `content_hash`. A copy vanishing is not the same event as a photo being lost —
   the photo may still be fully backed up elsewhere. Ignoring this produces a
   **data-corrupting bug**: a naive "one identical file → relocate" matcher would
   repoint a vanished copy onto a _pre-existing backup's_ row, deleting the backup
   record. The design is copy-aware from the ground up.

## Goals

- Surface files that have gone missing since the last scan, without alarming the
  user about copies that are still safely backed up elsewhere.
- Let the user, in bulk: **relocate** a moved file (preserving all metadata) or
  **dismiss** a gone copy (a recoverable tombstone, never a hard delete).
- Automatically resolve the unambiguous, safe cases (a clean move) so the review
  list holds only what genuinely needs a human.
- Never silently mis-handle the multi-copy case.

## Non-goals

- Finishing content-hash population (tracked separately; see CLAUDE.md's note on
  `hashPendingPhotos` being effectively inert). This feature _uses_ `content_hash`
  when present and falls back to `(filename, size, mtime)` when not.
- Detecting a folder deleted _wholesale_ while its parent is never rescanned — a
  documented v1 limitation (see Known limitations).
- Any change to how present files are scanned, rendered, or rated.

## State model

Every photo row is in exactly one of these states, expressed by the existing
`stale` column plus one new `dismissed` column:

| State                   | `stale` | `dismissed` | Visible in feed | Visible in review |
| ----------------------- | ------- | ----------- | --------------- | ----------------- |
| **Present**             | 0       | 0           | yes             | no                |
| **Missing** (unhandled) | 1       | 0           | no              | yes               |
| **Dismissed** (tomb)    | 1       | 1           | no              | no                |

Two new columns on `photos`, both via the existing `ensureColumn` migration
pattern (as used for `no_auto_stack`, `server/db/schema.js`):

- `dismissed INTEGER NOT NULL DEFAULT 0` — the tombstone flag.
- `first_seen_at INTEGER` — set on INSERT, **never** updated. Distinguishes a row
  that appeared _this scan_ (a candidate move target) from one that was already in
  the index (a pre-existing copy). `upsertScan`'s `ON CONFLICT` already
  distinguishes insert from update, so this is a one-line addition to the INSERT
  and a no-op in the `DO UPDATE`.

**Tombstone semantics (never hard-delete).** Dismissing a row sets
`dismissed = 1`; the row and its `rating`/FKs survive forever. If the identical
file later reappears in the _same folder_, `upsertScan`'s `ON CONFLICT` clears
`stale` and `dismissed` back to 0 (rating is untouched by the upsert), so the
photo returns with its stars intact. This is the recoverability the user chose
over hard deletion.

## Identity across copies

Two rows represent the same underlying file when:

- their `content_hash` is equal (authoritative, when both are hashed), **or**
- (fallback, the common case today) their `(filename, size, mtime)` triple is
  equal — the triple a Finder move or a byte-for-byte backup copy preserves.

A helper `sameFileCandidates(db, row)` returns all _other_ rows matching by this
rule, each tagged `stale`, `dismissed`, `first_seen_at`, `folder path`, and
`volume`.

## Classification (the matcher)

A post-scan pass (and a pass when the review pane opens) walks every
`stale = 1, dismissed = 0` row `S` and classifies it via `sameFileCandidates`:

- **Moved** — exactly one candidate that is _new this scan_ (`first_seen_at`
  within the current scan window) and stale = 0, **and no other surviving copy of
  any age**. This is an unambiguous, safe move → **auto-relocate** (see below).
  Reported in the nudge as "M auto-relocated".
- **Still covered** — at least one surviving (`stale = 0`) copy exists elsewhere,
  new or pre-existing. The photo is not lost. `S` is listed in the review pane
  **tagged "still on {volume}"** (the user's choice: list it, never silently act).
  Default per-row action is Dismiss; if `S` moved rather than duplicated, the user
  can relocate instead.
- **Truly gone** — no surviving copy anywhere. Listed in review as a real loss;
  actions are manual Relocate or Dismiss.
- **Ambiguous** — more than one new-this-scan candidate, or any mix that isn't a
  clean single move. Always listed for a human; never auto-applied.

**Why auto-relocate is restricted to the no-other-copy case:** anything involving
a pre-existing duplicate is exactly where a silent repoint would corrupt the
backup picture, so those never auto-apply — they go to review. This deliberately
tightens the "auto-apply exact-unique match" decision once multiple copies are in
play.

## Actions

### Relocate (repoint the stale row — do NOT merge two rows)

Keep the vanished row's `id` and repoint its `folder_id` + `filename` to the new
location with the existing `repointPhotoToFolder` primitive
(`server/db/photos.js`); when the destination folder is already scanned it holds a
freshly-inserted duplicate row (rating 0, no user state) occupying the
`UNIQUE(folder_id, filename)` slot — delete that duplicate first, then repoint,
then set `stale = 0`.

Because the id is **stable**, every FK table (`album_members`, `photo_tags`,
`keep_scope`, `manual_stacks`) and every on-row field (`rating`,
`preferred_cover`, `no_auto_stack`) survives automatically — no FK re-pointing, no
field copying. Batches resolve the destination folder once
(`resolveDestFolderId`) and repoint each row cheaply, per the existing
per-file-`diskutil` warning in `repointPhoto`'s docs.

If the destination folder is **not yet in the library**, offer to scan it as part
of the relocate (it becomes a normal browsable section — `repointPhoto` already
supports pointing at an unscanned dir).

### Dismiss (tombstone)

Set `dismissed = 1`. Recoverable as described under State model. Bulk-safe.

### Carry metadata to a surviving copy (still-covered case only)

When the vanished copy `S` carried metadata (rating, album/tag membership, manual
stack) and a chosen surviving duplicate `T` has **none** of it, copy that state
from `S` to `T` before tombstoning `S`. An already-rated survivor is left alone —
the user's "carry over only if target has none" choice. This prevents "my stars
vanished because I deleted one of two identical files". Implemented as an explicit
`carryMetadata(db, fromId, toId)` that copies the row fields and re-parents the
four FK tables' rows from `fromId` to `toId` (guarding the composite PKs against
duplicate membership).

## Surfacing & UI

**Rescan nudge (non-blocking).** After a rescan that newly loses ≥1 file, the
status line shows a non-blocking, specific message and a link to the review pane,
following the existing status-line pattern (`StatusBar.svelte`): _"N files went
missing — M auto-relocated, K to review"_. Never a modal; never blocks the scan.

**On-demand entry.** A "Review missing files…" entry (toolbar/menu) with a count
badge (the number of `stale = 1, dismissed = 0` rows on currently-mounted volumes)
opens the review pane anytime.

**Review pane (full pane, not a modal).** A table of unresolved missing rows,
each showing: cached thumbnail (previews survive offline per invariant #2), old
path, rating, a coverage tag (**"still on {volume}"** / **"no other copy"**), and
a suggested destination when the matcher found an ambiguous candidate. Multi-select
with bulk **Relocate…** (pick/confirm destination; offer to scan an unknown
folder) and **Dismiss**. More than a few rows routes through the JobsPanel with
progress, per the Usability rules. Every failure (unmounted destination, permission
error) renders inline — no silent no-op.

## Data flow

1. `upsertScan` marks vanished rows `stale = 1` (already happens) and stamps
   `first_seen_at` on new inserts (new).
2. Scanner emptied-folder fix (below) ensures a fully-emptied known folder is
   reconciled.
3. `classifyMissing(db, scanWindow)` runs post-scan: auto-relocates clean moves,
   returns counts for the nudge, leaves the rest as `stale = 1`.
4. Nudge renders counts; badge reflects the unresolved count.
5. Review pane calls `listMissing(db)` → rows + per-row classification +
   `getBackupCoverage`-style surviving-copy info.
6. User actions call `relocate` / `dismiss` / `carryMetadata`; the pane refreshes.

New server module `server/db/missing.js` owns `classifyMissing`, `listMissing`,
`sameFileCandidates`, `dismissPhotos`, `carryMetadata`; relocate reuses
`repointPhotoToFolder`/`resolveDestFolderId`. New endpoints under
`/api/missing` (list, classify, relocate, dismiss, carry) route file paths through
`server/lib/safeResolve.js` per the repo rule.

## Error handling & edge cases

- **Unmounted drive is not deletion.** You cannot scan an offline volume, so its
  rows are never marked stale — already safe. The review pane additionally lists
  only rows whose volume is currently mounted, so an unplugged backup drive never
  looks like mass loss.
- **Emptied folder not reconciled (bug to fix).** The recursive scan skips
  `upsertScan` when a dir returns zero files (`if (files.length)` in
  `server/api.js`), so a folder that lost _all_ its files never gets its rows
  marked stale. Fix: for a folder **already in the index** that a scan visits and
  finds empty, still run the "mark all stale" step (mark-stale without
  re-inserting). New folders with no media still create no row.
- **Ambiguity is never auto-resolved** — see Classification.
- **Destination duplicate** is deleted before repoint to avoid a UNIQUE collision.
- **Metadata carry** guards composite-PK FK tables against duplicate membership.

## Testing

- **vitest** (`server/db/missing.test.js`, colocated): the state machine and
  classifier against a fixture with — a clean move, a move-with-surviving-backup
  (must NOT auto-relocate), a deleted duplicate (still-covered), a truly-gone file,
  an ambiguous multi-candidate, an emptied folder, and dismiss-then-reappear
  (rating restored). Each relocate/carry case asserts `rating` **and**
  album/tag/keep-scope/stack membership survive. Each is red/green-verified per the
  repo rule (revert the fix, watch it fail).
- **e2e** (`e2e/missing.spec.js`): nudge appears after a scan that loses a file →
  review pane opens → relocate one row (photo returns to the feed at its new spot
  with its rating) and dismiss another (leaves the feed, stays out) — with
  `trackPageErrors`.

## Known limitations (documented, not fixed in v1)

- A folder deleted _wholesale_ on disk while its parent is never rescanned won't be
  noticed until the parent (or the folder itself) is scanned.
- Cross-copy identity leans on `(filename, size, mtime)` until content-hashing is
  finished; a re-encoded/edited-then-moved file (changed size/mtime) won't match
  and surfaces as truly-gone, to be relocated manually.

## Versioning

Patch bump per closed slice, `CHANGELOG.md` entry in the same commit, and any new
keyboard shortcut documented in `ShortcutsOverlay.svelte`, per CLAUDE.md.
