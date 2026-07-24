# Missing-files review (copy-aware delete-or-relocate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface files that vanished from disk and let the user relocate them (preserving all metadata) or dismiss them (a recoverable tombstone), copy-aware so a still-backed-up photo is never mistaken for a lost one.

**Architecture:** The index already marks vanished files `stale = 1` on rescan; this feature adds a `dismissed` tombstone column and a `first_seen_at` column, a server `missing.js` module that classifies stale rows (moved / still-covered / truly-gone / ambiguous) and auto-relocates only unambiguous moves, `/api/missing` endpoints, and a Svelte review pane plus a non-blocking rescan nudge. Relocate keeps the row id stable (repoint, don't merge) so ratings, albums, tags, keep-scope and manual-stack all survive automatically.

**Tech Stack:** Node.js + Express, better-sqlite3, Svelte 5 (runes), Vite, vitest (unit), Playwright (e2e). ESM, JSDoc types, Prettier.

**Spec:** `docs/superpowers/specs/2026-07-15-missing-files-review-design.md`.

## Global Constraints

- **ESM everywhere**; **no TypeScript** (plain JS + JSDoc). `"type": "module"`.
- **Every file-serving endpoint routes user paths through `server/lib/safeResolve.js`.**
- **A fixed bug / new behavior gets a test at the tier that would catch it**, in the same commit; **red/green-verify** each test (revert the change, watch it fail).
- **Every change bumps `package.json` patch version** and adds a **`CHANGELOG.md`** entry (newest first, user-facing) in the same commit. Current version at plan start: **2.15.10**. Use sequential patches per committed task (2.15.11, 2.15.12, …).
- **Any new/changed keyboard shortcut is documented in `ui/src/lib/ShortcutsOverlay.svelte`** in the same commit.
- **Every user-facing failure is surfaced** in the UI (inline `result.error` or the status line), never a silent no-op or console-only error.
- **Destructive actions are soft/undoable** — dismiss is a tombstone, never a hard delete.
- **Prettier**: run `npm run format` (or `npx prettier --write`) before each commit; CI gates formatting.
- **Never modify/move/delete files inside the user's real photo folders.** All tests use a temp `AUTOGALLERY_HOME` and synthetic paths; never the real `~/.autogallery`.
- **Migrations use the existing `ensureColumn` idempotent ADD COLUMN** in `server/db/schema.js` — the app ships no migration runner.
- Run unit tests with `npm test` (vitest). Run one file with `npx vitest run <path>`. Run e2e with `npx playwright test <path>`.

---

## File structure

**Server (create):**

- `server/db/missing.js` — the whole missing-files domain: identity/candidates, classification, relocate, dismiss, carry-metadata, list. One responsibility: reconciling stale rows against reality.
- `server/db/missing.test.js` — colocated vitest for the above.

**Server (modify):**

- `server/db/schema.js` — add `dismissed` + `first_seen_at` columns (Task 1).
- `server/db/photos.js` — `upsertScan` stamps `first_seen_at` on insert and clears `dismissed` on conflict (Task 1); no other change (relocate reuses existing `repointPhotoToFolder`/`resolveDestFolderId`).
- `server/api.js` — the recursive-scan emptied-folder fix (Task 7); the `/api/missing` endpoints and scan-completion classify wiring (Task 8).
- `server/api.test.js` — endpoint + scan-integration tests (Tasks 7, 8).

**Frontend (create/modify):** defined in the UI tasks section (Tasks 9+), pinned to the app's existing status-line, panel, toolbar-badge, and confirm patterns.

---

## Task 1: Schema — `dismissed` + `first_seen_at` columns, upsert wiring

**Files:**

- Modify: `server/db/schema.js:105-108` (add two `ensureColumn` calls near `no_auto_stack`)
- Modify: `server/db/photos.js:25-39` (upsert INSERT + ON CONFLICT)
- Test: `server/db/photos.test.js`

**Interfaces:**

- Produces: two new `photos` columns — `dismissed INTEGER NOT NULL DEFAULT 0`, `first_seen_at INTEGER`. After `upsertScan`, a freshly-inserted row has `first_seen_at` set to the scan's `now`; a re-seen file keeps its original `first_seen_at` and is forced `dismissed = 0`, `stale = 0`.

- [ ] **Step 1: Write the failing test**

Add to `server/db/photos.test.js` inside `describe("upsertScan", ...)`:

```js
it("stamps first_seen_at on insert and never changes it on rescan", () => {
  const db = getDb();
  const [first] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
  const seen1 = db
    .prepare("SELECT first_seen_at FROM photos WHERE id = ?")
    .get(first.id).first_seen_at;
  expect(Number.isInteger(seen1)).toBe(true);
  // Rescan the same unchanged file: first_seen_at must be stable.
  upsertScan(db, "/photos/trip", 1, [FILES[0]]);
  const seen2 = db
    .prepare("SELECT first_seen_at FROM photos WHERE id = ?")
    .get(first.id).first_seen_at;
  expect(seen2).toBe(seen1);
});

it("clears a dismissed tombstone when the same file reappears, keeping its rating", () => {
  const db = getDb();
  const [p] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
  setPhotoRating(db, p.id, 5);
  db.prepare("UPDATE photos SET stale = 1, dismissed = 1 WHERE id = ?").run(
    p.id
  );
  // The file comes back on a later scan of the same folder.
  upsertScan(db, "/photos/trip", 1, [FILES[0]]);
  const row = db
    .prepare("SELECT stale, dismissed, rating FROM photos WHERE id = ?")
    .get(p.id);
  expect(row).toMatchObject({ stale: 0, dismissed: 0, rating: 5 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/db/photos.test.js`
Expected: FAIL — `first_seen_at`/`dismissed` columns do not exist (SQLite error "no such column").

- [ ] **Step 3: Add the columns**

In `server/db/schema.js`, immediately after the `no_auto_stack` `ensureColumn` (line 108):

```js
// Missing-files review (#1). `dismissed` is a recoverable tombstone: a stale
// row the user removed from the index, hidden everywhere but never deleted, so
// its rating survives and is restored if the file reappears. `first_seen_at`
// (set on INSERT, never updated) distinguishes a row that appeared THIS scan
// (a candidate move target) from a pre-existing copy — the signal that keeps
// auto-relocate from repointing onto an existing backup. See db/missing.js.
ensureColumn(db, "photos", "dismissed", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(db, "photos", "first_seen_at", "INTEGER");
```

- [ ] **Step 4: Wire the upsert**

In `server/db/photos.js`, change the `upsertPhoto` statement (lines 25-39) to stamp `first_seen_at` on insert and clear `dismissed` on conflict:

```js
const upsertPhoto = db.prepare(`
    INSERT INTO photos (folder_id, filename, size, mtime, btime, kind, stale, first_seen_at)
    VALUES (@folderId, @filename, @size, @mtime, @btime, @kind, 0, @now)
    ON CONFLICT(folder_id, filename) DO UPDATE SET
      size = excluded.size,
      mtime = excluded.mtime,
      btime = excluded.btime,
      kind = excluded.kind,
      stale = 0,
      dismissed = 0,
      content_hash = CASE
        WHEN photos.size = excluded.size AND photos.mtime = excluded.mtime
        THEN photos.content_hash
        ELSE NULL
      END
  `);
```

And pass `now` in the loop (line 47-54):

```js
upsertPhoto.run({
  folderId,
  filename: f.name,
  size: f.size,
  mtime: f.mtimeMs,
  btime: f.btimeMs ?? null,
  kind: f.kind,
  now,
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/db/photos.test.js`
Expected: PASS (all, including the two new).

- [ ] **Step 6: Red/green check**

Temporarily revert the `dismissed = 0` line in the ON CONFLICT; rerun; confirm the reappear-test fails. Restore.

- [ ] **Step 7: Bump version + changelog + commit**

Set `package.json` version to `2.15.11`. Add to `CHANGELOG.md` under a new `## 2.15.11`:

```
- **Groundwork for missing-file review:** the index now remembers when a photo
  was first seen and can tombstone a removed file recoverably. (#1)
```

Then:

```bash
npx prettier --write server/db/schema.js server/db/photos.js server/db/photos.test.js CHANGELOG.md package.json
git add server/db/schema.js server/db/photos.js server/db/photos.test.js CHANGELOG.md package.json
git commit -m "feat(index): dismissed tombstone + first_seen_at columns (2.15.11) (#1)"
```

---

## Task 2: `sameFileCandidates` — cross-copy identity

**Files:**

- Create: `server/db/missing.js`
- Test: `server/db/missing.test.js`

**Interfaces:**

- Produces: `sameFileCandidates(db, row)` where `row = {id, content_hash, filename, size, mtime}`. Returns `Array<{id, folderId, absPath, volumeId, stale, dismissed, firstSeenAt}>` — every OTHER photo (id != row.id) representing the same underlying file: same non-null `content_hash`, OR same `(filename, size, mtime)` triple. Ordered by id for determinism.

- [ ] **Step 1: Write the failing test**

Create `server/db/missing.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan, setPhotoRating } from "./photos.js";
import { sameFileCandidates } from "./missing.js";

let cacheDir;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-missing-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'vol-a', 'uuid-a', '/a', ?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (2, 'vol-b', 'uuid-b', '/b', ?)`
  ).run(Date.now());
});
afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

const F = { name: "IMG_1.jpg", size: 100, mtimeMs: 1000, kind: "image" };

function rowFor(db, id) {
  return db
    .prepare(
      "SELECT id, content_hash, filename, size, mtime FROM photos WHERE id = ?"
    )
    .get(id);
}

describe("sameFileCandidates", () => {
  it("matches an identical file in another folder by (filename,size,mtime)", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    const [b] = upsertScan(db, "/b/backup", 2, [F]);
    const cands = sameFileCandidates(db, rowFor(db, a.id));
    expect(cands.map((c) => c.id)).toEqual([b.id]);
    expect(cands[0]).toMatchObject({ absPath: "/b/backup", volumeId: 2 });
  });

  it("does not match a different file", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    upsertScan(db, "/b/other", 2, [{ ...F, name: "OTHER.jpg" }]);
    expect(sameFileCandidates(db, rowFor(db, a.id))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/db/missing.test.js`
Expected: FAIL — `missing.js` does not exist / `sameFileCandidates` is not a function.

- [ ] **Step 3: Implement**

Create `server/db/missing.js`:

```js
import { join, basename } from "node:path";
import { resolveDestFolderId, repointPhotoToFolder } from "./photos.js";

/**
 * Every OTHER photo row representing the same underlying file as `row`:
 * identical non-null content_hash, or identical (filename, size, mtime) — the
 * triple a Finder move or a byte-for-byte backup copy preserves. Ordered by id.
 * @param {import("better-sqlite3").Database} db
 * @param {{id:number, content_hash:?string, filename:string, size:number, mtime:number}} row
 * @returns {Array<{id:number, folderId:number, absPath:string, volumeId:?number, stale:number, dismissed:number, firstSeenAt:?number}>}
 */
export function sameFileCandidates(db, row) {
  return db
    .prepare(
      `SELECT photos.id AS id, folders.id AS folderId,
              folders.abs_path AS absPath, folders.volume_id AS volumeId,
              photos.stale AS stale, photos.dismissed AS dismissed,
              photos.first_seen_at AS firstSeenAt
         FROM photos JOIN folders ON folders.id = photos.folder_id
        WHERE photos.id != @id
          AND (
            (@hash IS NOT NULL AND photos.content_hash = @hash)
            OR (photos.filename = @filename AND photos.size = @size AND photos.mtime = @mtime)
          )
        ORDER BY photos.id`
    )
    .all({
      id: row.id,
      hash: row.content_hash ?? null,
      filename: row.filename,
      size: row.size,
      mtime: row.mtime,
    });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/db/missing.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** (no version bump yet — internal helper, no user-visible change; fold into Task 3's bump)

```bash
npx prettier --write server/db/missing.js server/db/missing.test.js
git add server/db/missing.js server/db/missing.test.js
git commit -m "feat(missing): sameFileCandidates cross-copy identity helper (#1)"
```

---

## Task 3: `classifyMissing` — classify stale rows and auto-relocate clean moves

**Files:**

- Modify: `server/db/missing.js`
- Test: `server/db/missing.test.js`

**Interfaces:**

- Consumes: `sameFileCandidates` (Task 2), `resolveDestFolderId`/`repointPhotoToFolder` (photos.js).
- Produces:
  - `relocateMissing(db, staleId, destAbsPath)` — delete any duplicate row already occupying `(destFolder, filename)`, repoint the stale row there, set `stale = 0, dismissed = 0`. Returns `{ relocatedId: number }`. Id stays stable.
  - `classifyRow(db, staleRow, scanStartedAt)` — pure classification → `{ kind: "moved"|"covered"|"gone"|"ambiguous", moveTargetAbsPath?: string, survivors: Array<{absPath, volumeId, id}> }`. `moved` iff exactly one candidate is stale=0 AND new-this-scan (`firstSeenAt >= scanStartedAt`) AND there is no other stale=0 survivor of any age.
  - `classifyMissing(db, scanStartedAt)` — walk all `stale=1, dismissed=0` rows, auto-`relocateMissing` every `moved` one, and return `{ autoRelocated: number, toReview: number }`.

- [ ] **Step 1: Write the failing tests**

Append to `server/db/missing.test.js`:

```js
import { classifyMissing, classifyRow, relocateMissing } from "./missing.js";

function staleRow(db, id) {
  return db
    .prepare(
      `SELECT id, content_hash, filename, size, mtime, first_seen_at AS firstSeenAt
         FROM photos WHERE id = ?`
    )
    .get(id);
}
function markStale(db, id) {
  db.prepare("UPDATE photos SET stale = 1 WHERE id = ?").run(id);
}

describe("classify + relocate", () => {
  it("relocateMissing keeps the row id and its rating, removing the dest duplicate", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    setPhotoRating(db, a.id, 4);
    markStale(db, a.id); // A vanished from /a/trip
    const [b] = upsertScan(db, "/a/moved", 1, [F]); // reappeared in /a/moved
    const { relocatedId } = relocateMissing(db, a.id, "/a/moved/IMG_1.jpg");
    expect(relocatedId).toBe(a.id); // id stable → FKs/rating survive
    const row = db
      .prepare(
        "SELECT folder_id, filename, stale, rating FROM photos WHERE id = ?"
      )
      .get(a.id);
    const movedFolderId = db
      .prepare("SELECT id FROM folders WHERE abs_path = '/a/moved'")
      .get().id;
    expect(row).toMatchObject({
      folder_id: movedFolderId,
      filename: "IMG_1.jpg",
      stale: 0,
      rating: 4,
    });
    // The freshly-scanned duplicate B is gone (its slot was taken by A).
    expect(
      db.prepare("SELECT id FROM photos WHERE id = ?").get(b.id)
    ).toBeUndefined();
  });

  it("classifies a clean move and auto-relocates it", () => {
    const db = getDb();
    const scanStart = 5000;
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    markStale(db, a.id);
    // Destination scanned "after" scanStart → new-this-scan.
    const [b] = upsertScan(db, "/a/moved", 1, [F]);
    db.prepare("UPDATE photos SET first_seen_at = ? WHERE id = ?").run(
      6000,
      b.id
    );
    expect(classifyRow(db, staleRow(db, a.id), scanStart).kind).toBe("moved");
    const res = classifyMissing(db, scanStart);
    expect(res).toMatchObject({ autoRelocated: 1, toReview: 0 });
    expect(
      db.prepare("SELECT stale FROM photos WHERE id = ?").get(a.id).stale
    ).toBe(0);
  });

  it("does NOT auto-relocate when a pre-existing backup survives (still covered)", () => {
    const db = getDb();
    const scanStart = 5000;
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    const [b] = upsertScan(db, "/b/backup", 2, [F]); // pre-existing backup
    db.prepare("UPDATE photos SET first_seen_at = ? WHERE id = ?").run(
      100,
      b.id
    );
    markStale(db, a.id); // A's copy deleted; B still there
    expect(classifyRow(db, staleRow(db, a.id), scanStart).kind).toBe("covered");
    const res = classifyMissing(db, scanStart);
    expect(res).toMatchObject({ autoRelocated: 0, toReview: 1 });
    expect(
      db.prepare("SELECT stale FROM photos WHERE id = ?").get(a.id).stale
    ).toBe(1);
  });

  it("classifies a truly-gone file (no surviving copy)", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    markStale(db, a.id);
    expect(classifyRow(db, staleRow(db, a.id), 0).kind).toBe("gone");
  });

  it("classifies ambiguous when two new-this-scan candidates appear", () => {
    const db = getDb();
    const scanStart = 5000;
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    markStale(db, a.id);
    const [b] = upsertScan(db, "/a/m1", 1, [F]);
    const [c] = upsertScan(db, "/a/m2", 1, [F]);
    db.prepare("UPDATE photos SET first_seen_at = 6000 WHERE id IN (?, ?)").run(
      b.id,
      c.id
    );
    expect(classifyRow(db, staleRow(db, a.id), scanStart).kind).toBe(
      "ambiguous"
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run server/db/missing.test.js`
Expected: FAIL — `classifyRow`/`classifyMissing`/`relocateMissing` are not exported.

- [ ] **Step 3: Implement**

Append to `server/db/missing.js`:

```js
/**
 * Repoint a vanished (stale) row to where its file now lives, keeping the row id
 * so every FK (albums/tags/keep_scope/manual_stacks) and on-row field (rating,
 * preferred_cover, no_auto_stack) survives. Deletes any freshly-scanned
 * duplicate already occupying the destination's (folder, filename) slot first.
 * @param {import("better-sqlite3").Database} db
 * @param {number} staleId
 * @param {string} destAbsPath  absolute path of the file at its new location
 * @returns {{relocatedId:number}}
 */
export function relocateMissing(db, staleId, destAbsPath) {
  const destFolderId = resolveDestFolderId(db, join(destAbsPath, "..")); // dir
  const filename = basename(destAbsPath);
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM photos WHERE folder_id = ? AND filename = ? AND id != ?`
    ).run(destFolderId, filename, staleId);
    repointPhotoToFolder(db, staleId, destFolderId, filename);
    db.prepare(`UPDATE photos SET stale = 0, dismissed = 0 WHERE id = ?`).run(
      staleId
    );
  });
  tx();
  return { relocatedId: staleId };
}

/**
 * Classify a single stale row. `moved` is the only kind eligible for silent
 * auto-relocate, and only when it is unambiguous and no other copy survives.
 * @param {import("better-sqlite3").Database} db
 * @param {{id:number, content_hash:?string, filename:string, size:number, mtime:number, firstSeenAt:?number}} staleRow
 * @param {number} scanStartedAt  ms; a candidate is "new this scan" if firstSeenAt >= this
 * @returns {{kind:"moved"|"covered"|"gone"|"ambiguous", moveTargetAbsPath?:string, survivors:Array<{id:number, absPath:string, volumeId:?number}>}}
 */
export function classifyRow(db, staleRow, scanStartedAt) {
  const cands = sameFileCandidates(db, staleRow);
  const survivors = cands
    .filter((c) => c.stale === 0 && c.dismissed === 0)
    .map((c) => ({ id: c.id, absPath: c.absPath, volumeId: c.volumeId }));
  const newThisScan = cands.filter(
    (c) =>
      c.stale === 0 &&
      c.dismissed === 0 &&
      (c.firstSeenAt ?? 0) >= scanStartedAt
  );
  const preExisting = survivors.filter(
    (s) => !newThisScan.some((n) => n.id === s.id)
  );
  if (newThisScan.length === 1 && preExisting.length === 0) {
    return {
      kind: "moved",
      moveTargetAbsPath: join(newThisScan[0].absPath, staleRow.filename),
      survivors,
    };
  }
  if (survivors.length > 0) return { kind: "covered", survivors };
  if (newThisScan.length > 1) return { kind: "ambiguous", survivors };
  return { kind: "gone", survivors };
}

/**
 * Walk every unresolved missing row; auto-relocate clean moves; count the rest.
 * @param {import("better-sqlite3").Database} db
 * @param {number} scanStartedAt
 * @returns {{autoRelocated:number, toReview:number}}
 */
export function classifyMissing(db, scanStartedAt) {
  const stale = db
    .prepare(
      `SELECT id, content_hash, filename, size, mtime, first_seen_at AS firstSeenAt
         FROM photos WHERE stale = 1 AND dismissed = 0`
    )
    .all();
  let autoRelocated = 0;
  let toReview = 0;
  for (const row of stale) {
    const c = classifyRow(db, row, scanStartedAt);
    if (c.kind === "moved") {
      relocateMissing(db, row.id, c.moveTargetAbsPath);
      autoRelocated += 1;
    } else {
      toReview += 1;
    }
  }
  return { autoRelocated, toReview };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run server/db/missing.test.js`
Expected: PASS (all).

- [ ] **Step 5: Red/green check**

In `classifyRow`, temporarily change the `moved` guard to drop `&& preExisting.length === 0`; rerun; confirm the "does NOT auto-relocate when a pre-existing backup survives" test fails (it would auto-relocate onto the backup). Restore.

- [ ] **Step 6: Bump + changelog + commit**

`package.json` → `2.15.12`. `CHANGELOG.md` `## 2.15.12`:

```
- **Moved photos are recognised automatically.** After a scan, a file that
  simply moved on disk is relocated in place with its rating and albums intact;
  copies that are still backed up elsewhere are never touched. (#1)
```

```bash
npx prettier --write server/db/missing.js server/db/missing.test.js CHANGELOG.md package.json
git add server/db/missing.js server/db/missing.test.js CHANGELOG.md package.json
git commit -m "feat(missing): classify stale rows + auto-relocate clean moves (2.15.12) (#1)"
```

---

## Task 4: `dismissPhotos` + `carryMetadata`

**Files:**

- Modify: `server/db/missing.js`
- Test: `server/db/missing.test.js`

**Interfaces:**

- Produces:
  - `dismissPhotos(db, ids)` — set `dismissed = 1` for each id. Returns `{ dismissed: number }` (rows changed).
  - `carryMetadata(db, fromId, toId)` — if `toId` has NO user metadata (rating 0, not a cover, no album/tag/keep-scope/manual-stack rows), copy rating/preferred_cover/no_auto_stack from `fromId` and re-parent its `album_members`/`photo_tags`/`keep_scope`/`manual_stacks` rows to `toId`; then do nothing else (caller dismisses `fromId`). If `toId` already has metadata, leave it untouched. Returns `{ carried: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `server/db/missing.test.js`:

```js
import { dismissPhotos, carryMetadata } from "./missing.js";

describe("dismiss + carryMetadata", () => {
  it("dismiss sets the tombstone flag", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    markStale(db, a.id);
    expect(dismissPhotos(db, [a.id])).toEqual({ dismissed: 1 });
    expect(
      db.prepare("SELECT dismissed FROM photos WHERE id = ?").get(a.id)
        .dismissed
    ).toBe(1);
  });

  it("carries rating + tag membership to an unrated survivor", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    const [b] = upsertScan(db, "/b/backup", 2, [F]);
    setPhotoRating(db, a.id, 5);
    db.prepare("INSERT INTO tags (id, name) VALUES (1, 'kids')").run();
    db.prepare("INSERT INTO photo_tags (photo_id, tag_id) VALUES (?, 1)").run(
      a.id
    );
    expect(carryMetadata(db, a.id, b.id)).toEqual({ carried: true });
    expect(
      db.prepare("SELECT rating FROM photos WHERE id = ?").get(b.id).rating
    ).toBe(5);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM photo_tags WHERE photo_id = ?")
        .get(b.id).n
    ).toBe(1);
  });

  it("leaves an already-rated survivor untouched", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    const [b] = upsertScan(db, "/b/backup", 2, [F]);
    setPhotoRating(db, a.id, 5);
    setPhotoRating(db, b.id, 2);
    expect(carryMetadata(db, a.id, b.id)).toEqual({ carried: false });
    expect(
      db.prepare("SELECT rating FROM photos WHERE id = ?").get(b.id).rating
    ).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run server/db/missing.test.js`
Expected: FAIL — `dismissPhotos`/`carryMetadata` not exported.

- [ ] **Step 3: Implement**

Append to `server/db/missing.js`:

```js
/**
 * Tombstone stale rows: hidden everywhere, never deleted, rating preserved.
 * @param {import("better-sqlite3").Database} db
 * @param {number[]} ids
 * @returns {{dismissed:number}}
 */
export function dismissPhotos(db, ids) {
  if (!ids.length) return { dismissed: 0 };
  const stmt = db.prepare(`UPDATE photos SET dismissed = 1 WHERE id = ?`);
  const tx = db.transaction((all) => {
    let n = 0;
    for (const id of all) n += stmt.run(id).changes;
    return n;
  });
  return { dismissed: tx(ids) };
}

/** True if `id` carries any user-authored metadata worth preserving. */
function hasUserMetadata(db, id) {
  const p = db
    .prepare(
      `SELECT rating, preferred_cover, no_auto_stack FROM photos WHERE id = ?`
    )
    .get(id);
  if (!p) return false;
  if (p.rating > 0 || p.preferred_cover === 1 || p.no_auto_stack === 1)
    return true;
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM album_members WHERE photo_id = @id)
       + (SELECT COUNT(*) FROM photo_tags   WHERE photo_id = @id)
       + (SELECT COUNT(*) FROM keep_scope   WHERE photo_id = @id)
       + (SELECT COUNT(*) FROM manual_stacks WHERE photo_id = @id) AS n`
    )
    .get({ id });
  return counts.n > 0;
}

/**
 * Copy user metadata from `fromId` onto `toId` ONLY when `toId` has none, so a
 * vanished copy's stars/albums/tags/stack survive on a duplicate that had none.
 * Re-parents FK rows (INSERT OR IGNORE against composite PKs). Never touches an
 * already-annotated survivor.
 * @param {import("better-sqlite3").Database} db
 * @param {number} fromId
 * @param {number} toId
 * @returns {{carried:boolean}}
 */
export function carryMetadata(db, fromId, toId) {
  if (hasUserMetadata(db, toId)) return { carried: false };
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE photos SET
         rating = (SELECT rating FROM photos WHERE id = @from),
         preferred_cover = (SELECT preferred_cover FROM photos WHERE id = @from),
         no_auto_stack = (SELECT no_auto_stack FROM photos WHERE id = @from)
       WHERE id = @to`
    ).run({ from: fromId, to: toId });
    for (const tbl of [
      "album_members",
      "photo_tags",
      "keep_scope",
      "manual_stacks",
    ]) {
      db.prepare(
        `UPDATE OR IGNORE ${tbl} SET photo_id = @to WHERE photo_id = @from`
      ).run({ from: fromId, to: toId });
    }
  });
  tx();
  return { carried: true };
}
```

Note: `keep_scope` has a single-column PK `photo_id`; `UPDATE OR IGNORE` drops the row silently if `toId` already scoped — harmless since `hasUserMetadata` guaranteed `toId` had none.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run server/db/missing.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** (fold version bump into Task 6)

```bash
npx prettier --write server/db/missing.js server/db/missing.test.js
git add server/db/missing.js server/db/missing.test.js
git commit -m "feat(missing): dismiss tombstone + carry-metadata-to-survivor (#1)"
```

---

## Task 5: `listMissing` — the review pane's data

**Files:**

- Modify: `server/db/missing.js`
- Test: `server/db/missing.test.js`

**Interfaces:**

- Consumes: `classifyRow` (Task 3), a mounted-volume predicate passed in.
- Produces: `listMissing(db, { mountedVolumeIds, scanStartedAt = 0 })` — every `stale=1, dismissed=0` row whose `volumeId` is in `mountedVolumeIds`, as `Array<{id, filename, absPath, rating, kind, classification: {kind, survivors, moveTargetAbsPath?}}>`, ordered by `absPath, filename`. Rows on unmounted volumes are omitted (an unplugged drive is not a deletion).

- [ ] **Step 1: Write the failing test**

Append to `server/db/missing.test.js`:

```js
import { listMissing } from "./missing.js";

describe("listMissing", () => {
  it("lists mounted missing rows with classification, omitting unmounted volumes", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/a/trip", 1, [F]);
    const [b] = upsertScan(db, "/b/only", 2, [{ ...F, name: "X.jpg" }]);
    markStale(db, a.id);
    markStale(db, b.id);
    const rows = listMissing(db, { mountedVolumeIds: [1], scanStartedAt: 0 });
    expect(rows.map((r) => r.id)).toEqual([a.id]); // b is on unmounted vol 2
    expect(rows[0]).toMatchObject({
      absPath: "/a/trip",
      filename: "IMG_1.jpg",
    });
    expect(rows[0].classification.kind).toBe("gone");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/db/missing.test.js`
Expected: FAIL — `listMissing` not exported.

- [ ] **Step 3: Implement**

Append to `server/db/missing.js`:

```js
/**
 * The review pane's rows: unresolved missing photos on currently-mounted
 * volumes, each with its classification. An unmounted drive is not a deletion,
 * so its rows are omitted.
 * @param {import("better-sqlite3").Database} db
 * @param {{mountedVolumeIds:number[], scanStartedAt?:number}} opts
 * @returns {Array<{id:number, filename:string, absPath:string, rating:number, kind:string, classification:object}>}
 */
export function listMissing(db, { mountedVolumeIds, scanStartedAt = 0 }) {
  const rows = db
    .prepare(
      `SELECT photos.id AS id, photos.filename AS filename,
              folders.abs_path AS absPath, folders.volume_id AS volumeId,
              photos.rating AS rating, photos.kind AS kind,
              photos.content_hash AS content_hash,
              photos.size AS size, photos.mtime AS mtime,
              photos.first_seen_at AS firstSeenAt
         FROM photos JOIN folders ON folders.id = photos.folder_id
        WHERE photos.stale = 1 AND photos.dismissed = 0
        ORDER BY folders.abs_path, photos.filename`
    )
    .all();
  const mounted = new Set(mountedVolumeIds);
  return rows
    .filter((r) => r.volumeId != null && mounted.has(r.volumeId))
    .map((r) => ({
      id: r.id,
      filename: r.filename,
      absPath: r.absPath,
      rating: r.rating,
      kind: r.kind,
      classification: classifyRow(db, r, scanStartedAt),
    }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/db/missing.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** (fold into Task 6)

```bash
npx prettier --write server/db/missing.js server/db/missing.test.js
git add server/db/missing.js server/db/missing.test.js
git commit -m "feat(missing): listMissing review-pane query (#1)"
```

---

## Task 6: Scanner emptied-folder reconciliation fix

**Files:**

- Modify: `server/api.js:581-587` (recursive scan loop)
- Test: `server/api.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: after a recursive scan, a folder ALREADY in the index that now yields zero media files has all its rows marked `stale = 1` (instead of being skipped). New empty folders still create no row.

- [ ] **Step 1: Write the failing test**

Add to `server/api.test.js` (follow the file's existing real-scan harness — a temp source dir + `/api/scan`). Minimal shape:

```js
it("marks rows stale when a previously-indexed folder is emptied on a recursive rescan", async () => {
  // Arrange: a parent with one subfolder holding one image, scanned once.
  const root = await mkdtemp(join(tmpdir(), "ag-scan-"));
  const sub = join(root, "sub");
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, "p.jpg"), "x");
  await postScan(srv, root); // recursive scan of root
  const db = getDb();
  const before = db
    .prepare("SELECT COUNT(*) AS n FROM photos WHERE stale = 0")
    .get().n;
  expect(before).toBe(1);
  // Act: delete the file, rescan the parent recursively.
  await rm(join(sub, "p.jpg"));
  await postScan(srv, root);
  // Assert: the emptied subfolder's row is now stale.
  const after = db
    .prepare("SELECT COUNT(*) AS n FROM photos WHERE stale = 0")
    .get().n;
  expect(after).toBe(0);
});
```

(Use the exact scan-invocation helper the surrounding tests use — `postScan`/`waitForJob` equivalent already present in `api.test.js`; match it rather than inventing one.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/api.test.js`
Expected: FAIL — `after` is 1 (the emptied folder was skipped, its row stayed `stale = 0`).

- [ ] **Step 3: Implement**

In `server/api.js`, the recursive loop (currently lines 581-587):

```js
const subdir = dirs[i];
const files = await processing.scan(subdir);
if (files.length) {
  // don't create empty folders rows
  upsertScan(db, subdir, volumeId, files);
  count += files.length;
  folders += 1;
} else {
  // A folder ALREADY in the index that is now empty must have its
  // rows reconciled (marked stale), or an emptied folder's photos
  // are never noticed as missing. New empty folders create no row.
  const known = db
    .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
    .get(subdir);
  if (known) {
    db.prepare(`UPDATE photos SET stale = 1 WHERE folder_id = ?`).run(known.id);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/api.test.js`
Expected: PASS.

- [ ] **Step 5: Red/green check**

Revert the `else` branch; rerun; confirm the new test fails. Restore.

- [ ] **Step 6: Bump + changelog + commit** (this bump also covers Tasks 4 & 5's committed code)

`package.json` → `2.15.13`. `CHANGELOG.md` `## 2.15.13`:

```
- **Emptied folders are noticed.** Removing every file from a folder now marks
  those photos missing on the next rescan instead of leaving stale entries. (#1)
```

```bash
npx prettier --write server/api.js server/api.test.js CHANGELOG.md package.json
git add server/api.js server/api.test.js CHANGELOG.md package.json
git commit -m "fix(scan): reconcile a previously-indexed folder emptied on disk (2.15.13) (#1)"
```

---

## Task 7: `/api/missing` endpoints + scan-completion classify

**Files:**

- Modify: `server/api.js` (import from `missing.js`; add endpoints; call `classifyMissing` at scan completion and surface counts)
- Test: `server/api.test.js`

**Interfaces:**

- Consumes: `classifyMissing`, `listMissing`, `relocateMissing`, `dismissPhotos`, `carryMetadata` (missing.js); `mountedVolumeIds` — reuse the existing volume-mount check used by the library listing (see `server/api.js` around the library/volumes section, the `volumeMounted`/`existsSync(r.path)` logic).
- Produces HTTP:
  - `GET /api/missing` → `{ items: listMissing(...), count }`.
  - `POST /api/missing/relocate` `{ id, destAbsPath }` → `{ relocated: true, id }` (400 on bad input; `destAbsPath` routed through `safeResolve`).
  - `POST /api/missing/dismiss` `{ ids: number[] }` → `{ dismissed }`.
  - `POST /api/missing/carry` `{ fromId, toId }` → `{ carried }`.
  - Scan responses/`finish` payload gain `missing: { autoRelocated, toReview }` from a `classifyMissing(db, scanStartedAt)` call after the scan completes (both the recursive job path near line 594 and the single-folder path near line 604). `scanStartedAt` = the `now`/`t0` wall-clock captured at scan start (add a `Date.now()` at scan entry to compare against `first_seen_at`).

- [ ] **Step 1: Write the failing tests**

Add to `server/api.test.js`:

```js
it("GET /api/missing lists stale rows; dismiss tombstones them", async () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at) VALUES (9, 'v', 'u9', ?, ?)`
  ).run(tmpdir(), Date.now()); // a mounted path
  // Insert a folder on that volume with one stale photo.
  const fid = db
    .prepare(
      `INSERT INTO folders (abs_path, volume_id, last_scanned_at) VALUES (?, 9, ?)`
    )
    .run(tmpdir(), Date.now()).lastInsertRowid;
  const pid = db
    .prepare(
      `INSERT INTO photos (folder_id, filename, size, mtime, kind, stale) VALUES (?, 'g.jpg', 1, 1, 'image', 1)`
    )
    .run(fid).lastInsertRowid;

  const list = await (await fetch(`${srv.base}/api/missing`)).json();
  expect(list.items.some((r) => r.id === pid)).toBe(true);

  const res = await fetch(`${srv.base}/api/missing/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [pid] }),
  });
  expect(await res.json()).toEqual({ dismissed: 1 });
  const after = await (await fetch(`${srv.base}/api/missing`)).json();
  expect(after.items.some((r) => r.id === pid)).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/api.test.js`
Expected: FAIL — 404 on `/api/missing`.

- [ ] **Step 3: Implement the endpoints**

At the top of `server/api.js`, extend the `./db/missing.js` import:

```js
import {
  classifyMissing,
  listMissing,
  relocateMissing,
  dismissPhotos,
  carryMetadata,
} from "./db/missing.js";
```

Add a helper to compute mounted volume ids (reuse the existing volume-mount logic; factor it if needed) and the endpoints, near the other `app.post`/`app.get` registrations:

```js
/** Volume ids whose last known mount path currently exists. */
function mountedVolumeIds(db) {
  return db
    .prepare(`SELECT id, last_mount_path FROM volumes`)
    .all()
    .filter((v) => v.last_mount_path && existsSync(v.last_mount_path))
    .map((v) => v.id);
}

app.get("/api/missing", (_req, res) => {
  const db = getDb();
  const items = listMissing(db, { mountedVolumeIds: mountedVolumeIds(db) });
  res.json({ items, count: items.length });
});

app.post("/api/missing/relocate", (req, res) => {
  const { id, destAbsPath } = req.body ?? {};
  if (
    !Number.isInteger(id) ||
    typeof destAbsPath !== "string" ||
    !destAbsPath
  ) {
    return res.status(400).json({ error: "id and destAbsPath are required" });
  }
  const safe = safeResolve(destAbsPath);
  if (!safe) return res.status(400).json({ error: "invalid destination path" });
  const db = getDb();
  const { relocatedId } = relocateMissing(db, id, safe);
  res.json({ relocated: true, id: relocatedId });
});

app.post("/api/missing/dismiss", (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
    return res.status(400).json({ error: "ids must be an array of integers" });
  }
  res.json(dismissPhotos(getDb(), ids));
});

app.post("/api/missing/carry", (req, res) => {
  const { fromId, toId } = req.body ?? {};
  if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
    return res.status(400).json({ error: "fromId and toId are required" });
  }
  res.json(carryMetadata(getDb(), fromId, toId));
});
```

(Confirm `safeResolve`'s exact export shape in `server/lib/safeResolve.js` and match it — it may return a resolved path or throw. Adapt the guard to its real contract.)

- [ ] **Step 4: Wire classify into scan completion**

Capture a scan-start timestamp and run `classifyMissing` before finishing. In the recursive path, just before `registry.finish(job.id, …)` (line ~595):

```js
const missing = classifyMissing(db, scanStartedAt);
registry.finish(job.id, { root: dir, count, folders, elapsedMs, missing });
```

In the single-folder path, before `res.json(...)` (line ~622):

```js
const missing = classifyMissing(db, scanStartedAt);
res.json({
  root: dir,
  count: items.length,
  folders: 1,
  elapsedMs,
  missing,
  items,
});
```

Add `const scanStartedAt = Date.now();` at the top of the `/api/scan` handler (before any `processing.scan`).

- [ ] **Step 5: Run tests**

Run: `npx vitest run server/api.test.js`
Expected: PASS.

- [ ] **Step 6: Bump + changelog + commit**

`package.json` → `2.15.14`. `CHANGELOG.md` `## 2.15.14`:

```
- **Missing files have an API.** The app can now list photos that vanished from
  disk, relocate one to a new folder, or dismiss it. (#1)
```

```bash
npx prettier --write server/api.js server/api.test.js CHANGELOG.md package.json
git add server/api.js server/api.test.js CHANGELOG.md package.json
git commit -m "feat(api): /api/missing list/relocate/dismiss/carry + scan classify (2.15.14) (#1)"
```

---

## Task 8: API client functions

**Files:**

- Modify: `ui/src/lib/api.js` (append four functions near the other POST helpers)

**Interfaces:**

- Produces (all follow the house error idiom — throw `Error(body.error || …)` on `!res.ok`):
  - `fetchMissing()` → `{ items, count }`
  - `relocateMissing(id, destAbsPath)` → `{ relocated, id }`
  - `dismissMissing(ids)` → `{ dismissed }`
  - `carryMissing(fromId, toId)` → `{ carried }`

- [ ] **Step 1: Implement** (no unit test — `api.js` is a thin fetch client, exercised via e2e in Task 11 and server tests in Tasks 3-7)

Append to `ui/src/lib/api.js`:

```js
/** Photos that vanished from disk (stale, not dismissed) on mounted volumes. */
export async function fetchMissing() {
  const res = await fetch("/api/missing");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body.error || `could not load missing files (${res.status})`
    );
  }
  return res.json();
}

/** Repoint a vanished photo to its new location (destAbsPath = the file's new path). */
export async function relocateMissing(id, destAbsPath) {
  const res = await fetch("/api/missing/relocate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, destAbsPath }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `relocate failed (${res.status})`);
  }
  return res.json();
}

/** Tombstone vanished photos (recoverable; never a hard delete). */
export async function dismissMissing(ids) {
  const res = await fetch("/api/missing/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `dismiss failed (${res.status})`);
  }
  return res.json();
}

/** Carry a vanished copy's rating/albums/tags/stack onto an unrated survivor. */
export async function carryMissing(fromId, toId) {
  const res = await fetch("/api/missing/carry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fromId, toId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `carry failed (${res.status})`);
  }
  return res.json();
}
```

- [ ] **Step 2: Commit** (fold version bump into Task 10)

```bash
npx prettier --write ui/src/lib/api.js
git add ui/src/lib/api.js
git commit -m "feat(missing): api client — list/relocate/dismiss/carry (#1)"
```

---

## Task 9: `MissingReview.svelte` — the review pane

**Files:**

- Create: `ui/src/lib/MissingReview.svelte`

**Interfaces:**

- Consumes: `fetchMissing`, `relocateMissing`, `dismissMissing`, `carryMissing` (Task 8); `thumbUrl` (`ui/src/lib/api.js`); `toggleId`, `withoutIds` (`ui/src/lib/selectionOps.js`); `Modal` (`ui/src/lib/Modal.svelte`).
- Props: `{ onclose, onchanged }` — `onclose()` closes the pane; `onchanged()` fires after any successful action so App can refresh the count and feed.
- Self-loads its rows on mount; owns its selection and per-row relocate input state.

- [ ] **Step 1: Create the component**

Create `ui/src/lib/MissingReview.svelte`:

```svelte
<script>
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { thumbUrl } from "./api.js";
  import {
    fetchMissing,
    relocateMissing,
    dismissMissing,
    carryMissing,
  } from "./api.js";
  import { toggleId } from "./selectionOps.js";

  let { onclose, onchanged } = $props();

  let items = $state([]);
  let loading = $state(true);
  let error = $state("");
  let selected = $state(new Set());
  let dismissArmed = $state(false); // two-click confirm for bulk dismiss
  let relocatingId = $state(null); // row showing its destination input
  let destPath = $state("");
  let busy = $state(false);

  const hasNativePicker =
    typeof window !== "undefined" && !!window.autogallery?.pickFolder;

  async function load() {
    loading = true;
    error = "";
    try {
      const { items: rows } = await fetchMissing();
      items = rows;
      selected = new Set(); // ids may have changed under us
      dismissArmed = false;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }
  onMount(load);

  function coverageLabel(c) {
    if (c.kind === "covered") {
      const where = c.survivors
        .map((s) => s.absPath)
        .slice(0, 2)
        .join(", ");
      return `still on disk — ${where}`;
    }
    if (c.kind === "ambiguous") return "moved? needs a choice";
    return "no other copy";
  }

  async function doDismiss() {
    if (!selected.size) return;
    if (!dismissArmed) {
      dismissArmed = true;
      return;
    }
    busy = true;
    error = "";
    try {
      // For a still-covered row, carry its metadata onto a surviving copy first
      // (server no-ops if the survivor already has its own).
      for (const row of items) {
        if (!selected.has(row.id)) continue;
        if (
          row.classification.kind === "covered" &&
          row.classification.survivors[0]
        ) {
          await carryMissing(row.id, row.classification.survivors[0].id);
        }
      }
      await dismissMissing([...selected]);
      onchanged?.();
      await load();
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
      dismissArmed = false;
    }
  }

  function startRelocate(row) {
    relocatingId = row.id;
    destPath = "";
    error = "";
  }

  async function pickDest() {
    const p = await window.autogallery?.pickFolder?.();
    if (p) destPath = p;
  }

  async function confirmRelocate(row) {
    const folder = destPath.trim();
    if (!folder) return;
    busy = true;
    error = "";
    try {
      // A move keeps the filename; destAbsPath is folder + the original name.
      const dest = folder.replace(/\/+$/, "") + "/" + row.filename;
      await relocateMissing(row.id, dest);
      relocatingId = null;
      onchanged?.();
      await load();
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
</script>

<Modal open={true} title="Missing files" size="lg" onclose={() => onclose?.()}>
  {#if loading}
    <p class="mr-empty">Checking what’s missing…</p>
  {:else if error}
    <p class="mr-error" role="alert">{error}</p>
  {:else if items.length === 0}
    <p class="mr-empty">
      Nothing’s missing — every indexed photo is where the app expects it.
    </p>
  {:else}
    <div class="mr-actions">
      <span class="mr-count">{selected.size} selected</span>
      <button
        class="mr-dismiss"
        disabled={!selected.size || busy}
        onclick={doDismiss}
      >
        {dismissArmed
          ? `Dismiss ${selected.size} — click to confirm`
          : "Dismiss"}
      </button>
    </div>
    <ul class="mr-list">
      {#each items as row (row.id)}
        <li class="mr-row" class:sel={selected.has(row.id)}>
          <input
            type="checkbox"
            checked={selected.has(row.id)}
            onchange={() => (selected = toggleId(selected, row.id))}
            aria-label={`Select ${row.filename}`}
          />
          <img
            class="mr-thumb"
            src={thumbUrl(row.id, 96)}
            alt={row.filename}
            loading="lazy"
          />
          <div class="mr-info">
            <div class="mr-name" title={row.absPath + "/" + row.filename}>
              {row.filename}
            </div>
            <div class="mr-path">{row.absPath}</div>
            <div class="mr-tags">
              <span class="mr-coverage mr-{row.classification.kind}">
                {coverageLabel(row.classification)}
              </span>
              {#if row.rating > 0}<span class="mr-stars"
                  >{"★".repeat(row.rating)}</span
                >{/if}
            </div>
          </div>
          <div class="mr-rowactions">
            {#if relocatingId === row.id}
              {#if hasNativePicker}
                <button onclick={pickDest} disabled={busy}>Choose…</button>
              {/if}
              <input
                class="mr-dest"
                placeholder="/new/folder"
                bind:value={destPath}
                spellcheck="false"
              />
              <button
                disabled={!destPath.trim() || busy}
                onclick={() => confirmRelocate(row)}
              >
                Relocate
              </button>
              <button onclick={() => (relocatingId = null)} disabled={busy}
                >Cancel</button
              >
            {:else}
              <button onclick={() => startRelocate(row)} disabled={busy}
                >Relocate…</button
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</Modal>

<style>
  .mr-empty,
  .mr-error {
    padding: 1.5rem 0.5rem;
    text-align: center;
    color: #aaa;
  }
  .mr-error {
    color: #ff6b6b;
  }
  .mr-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0 0.5rem;
    border-bottom: 1px solid #333;
  }
  .mr-count {
    color: #aaa;
    font-size: 0.85rem;
  }
  .mr-dismiss {
    margin-left: auto;
  }
  .mr-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 60vh;
    overflow-y: auto;
  }
  .mr-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.25rem;
    border-bottom: 1px solid #262626;
  }
  .mr-row.sel {
    background: #22303d;
  }
  .mr-thumb {
    width: 48px;
    height: 48px;
    object-fit: cover;
    border-radius: 3px;
    background: #111;
    flex: 0 0 auto;
  }
  .mr-info {
    min-width: 0;
    flex: 1 1 auto;
  }
  .mr-name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mr-path {
    color: #888;
    font-size: 0.78rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mr-tags {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.15rem;
  }
  .mr-coverage {
    font-size: 0.72rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: #333;
    color: #cfe;
  }
  .mr-covered {
    background: #244; /* still safe elsewhere */
    color: #9fe;
  }
  .mr-gone {
    background: #422;
    color: #f9b;
  }
  .mr-stars {
    color: #ffd24c;
    font-size: 0.75rem;
  }
  .mr-rowactions {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    flex: 0 0 auto;
  }
  .mr-dest {
    width: 12rem;
  }
</style>
```

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: build succeeds, 0 Svelte warnings for this file.

- [ ] **Step 3: Commit** (fold version bump into Task 10)

```bash
npx prettier --write ui/src/lib/MissingReview.svelte
git add ui/src/lib/MissingReview.svelte
git commit -m "feat(missing): review pane component — relocate/dismiss rows (#1)"
```

---

## Task 10: App wiring — entry + count badge + render pane + rescan nudge

**Files:**

- Modify: `ui/src/App.svelte` (state, count refresh, render `MissingReview`, nudge on scan completion)
- Modify: `ui/src/lib/SourceControls.svelte` (add "Review missing files…" menu entry with a count badge)
- Modify: `ui/src/lib/Toolbar.svelte` (thread the new callback + count prop through)

**Interfaces:**

- Consumes: `MissingReview.svelte` (Task 9); `fetchMissing` (Task 8).
- Produces: `missingCount` (`$state`), refreshed by `refreshMissingCount()` on load and after every scan; a `Review missing files…` menu entry that opens the pane and shows `missingCount` when > 0; a non-blocking status nudge after a scan that loses files.

- [ ] **Step 1: App state + refresh + open**

In `ui/src/App.svelte`, near the other panel toggles (e.g. by `manageLibraryOpen`, line ~672):

```js
let missingReviewOpen = $state(false);
let missingCount = $state(0);
```

Add the import at the top with the other lib imports:

```js
import { fetchMissing } from "./lib/api.js";
import MissingReview from "./lib/MissingReview.svelte";
```

Add a refresh helper near `refreshPendingMeta` (line ~1545):

```js
async function refreshMissingCount() {
  try {
    const { count } = await fetchMissing();
    missingCount = count;
  } catch {
    // A count is advisory; never surface its failure as a user error.
  }
}
```

Call `refreshMissingCount()` once during initial load, alongside the existing startup fetches (where `refreshPendingMeta`/library load happens).

- [ ] **Step 2: Render the pane**

Add a snippet forwarded like `manageLibrary` (near `App.svelte:4547`), or render directly in the top-level markup:

```svelte
{#if missingReviewOpen}
  <MissingReview
    onclose={() => (missingReviewOpen = false)}
    onchanged={onMissingChanged}
  />
{/if}
```

Define `onMissingChanged` to refresh exactly the way a folder removal already does — a relocate/dismiss changes the library the same way. Reuse the existing `onFolderRemoved` refresh path (App wires `onfolderRemoved={onFolderRemoved}` into ManageLibrary; that handler already rebuilds the feed + library after an index change). Concretely:

```js
async function onMissingChanged() {
  await refreshMissingCount();
  onFolderRemoved(); // same library+feed refresh a folder-remove triggers
}
```

(If `onFolderRemoved` takes arguments in the real code, call it the way the folder-remove flow does — do NOT hand-roll a new feed fetch; the feed-window guards must not be duplicated, per CLAUDE.md.)

- [ ] **Step 3: Menu entry with badge (SourceControls)**

In `ui/src/lib/SourceControls.svelte`, add to the `$props()` list: `onreviewmissing`, `missingCount = 0`. Add a menu item after "Manage library" (line ~117):

```svelte
<button
  role="menuitem"
  onclick={() => {
    menuOpen = false;
    onreviewmissing?.();
  }}
>
  Review missing files…
  {#if missingCount > 0}<span class="mr-badge">{missingCount}</span>{/if}
</button>
```

Add CSS for `.mr-badge` (model on the jobs pill / offline-badge):

```css
.mr-badge {
  margin-left: 0.4rem;
  background: #b4442f;
  color: #fff;
  border-radius: 999px;
  padding: 0 0.4rem;
  font-size: 0.72rem;
  font-weight: 600;
}
```

- [ ] **Step 4: Thread through Toolbar**

In `ui/src/lib/Toolbar.svelte`, add `onreviewmissing`, `missingCount = 0` to its `$props()` and pass them into `<SourceControls … onreviewmissing={onreviewmissing} missingCount={missingCount} />` (mirroring how `onmanagelibrary` is threaded, line ~135).

In `App.svelte`'s `<Toolbar … />` usage (line ~4501 area), pass:

```svelte
onreviewmissing={() => {
  missingReviewOpen = true;
  refreshMissingCount();
}}
missingCount={missingCount}
```

- [ ] **Step 5: Rescan nudge**

Find the scan-completion handler where `waitForJob` resolves for a scan (the sweep model is `App.svelte:1506-1519`; the scan path is analogous — locate where a scan job finishes and its result is read). After a scan finishes, read the `missing` payload and nudge:

```js
const m = job.result?.missing;
await refreshMissingCount();
if (m && (m.toReview > 0 || m.autoRelocated > 0)) {
  // `error` (not `status`) so the message survives the feed reload that
  // follows a scan; it is informational, not a failure.
  const parts = [];
  if (m.toReview > 0)
    parts.push(`${m.toReview} file${m.toReview === 1 ? "" : "s"} went missing`);
  if (m.autoRelocated > 0) parts.push(`${m.autoRelocated} auto-relocated`);
  error = `${parts.join(", ")} — open “Review missing files” to sort them out`;
}
```

(Match the real variable for the finished scan job and its result shape — the classify payload is on `registry.finish(…, { …, missing })` per server Task 7.)

- [ ] **Step 6: Build + verify**

Run: `npm run build`
Expected: build succeeds, 0 warnings.

- [ ] **Step 7: Live check**

Run `npm run dev`, open the app, confirm: the "Review missing files…" entry appears in the ＋/Source menu and opens the pane; the pane shows the empty state cleanly; no console errors. (Per the repo's live-verify rule for App.svelte/CSS changes.)

- [ ] **Step 8: Bump + changelog + commit** (covers Tasks 8, 9, 10)

`package.json` → `2.15.15`. `CHANGELOG.md` `## 2.15.15`:

```
- **Review missing files.** When a photo disappears from disk, the app now tells
  you and offers a review panel to relocate it to where it moved (keeping its
  rating and albums) or dismiss it. Files that simply moved are relocated
  automatically; copies still backed up elsewhere are flagged, not lost. (#1)
```

```bash
npx prettier --write ui/src/App.svelte ui/src/lib/SourceControls.svelte ui/src/lib/Toolbar.svelte CHANGELOG.md package.json
git add ui/src/App.svelte ui/src/lib/SourceControls.svelte ui/src/lib/Toolbar.svelte CHANGELOG.md package.json
git commit -m "feat(missing): review entry, count badge, pane wiring + rescan nudge (2.15.15) (#1)"
```

---

## Task 11: e2e — the review pane opens and renders (DOM/seam guard)

**Files:**

- Create: `e2e/missing.spec.js`

**Interfaces:**

- Consumes: `openApp`, `trackPageErrors` (`e2e/helpers.js`).

Rationale: the relocate/dismiss/classify LOGIC is proven by `server/db/missing.test.js` and `server/api.test.js` (Tasks 2-7). The e2e guards what a vitest test cannot — that the entry is wired through Toolbar→SourceControls, the pane mounts, fetches, and renders without a page error (the wiring/load-order/CSS class of bug this app repeatedly ships). Per CLAUDE.md: keep the pyramid; e2e for the seam, not the logic.

- [ ] **Step 1: Write the test**

Create `e2e/missing.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp } from "./helpers.js";

test("@p1 the missing-files review pane opens from the Source menu and renders", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page);

  // Open the ＋/Source menu, then the review entry. (Match the real selectors in
  // e2e/helpers.js — add a `source` helper there if one isn't present, rather
  // than inlining selectors, per the repo's selectors-live-in-helpers rule.)
  await page
    .getByRole("button", { name: /add folder|source|library/i })
    .first()
    .click();
  await page.getByRole("menuitem", { name: /review missing files/i }).click();

  // The pane mounts and shows its heading + the empty state (the fixture library
  // has nothing missing — every scanned file is present on disk).
  const dialog = page.locator(".modal");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Missing files");
  await expect(dialog).toContainText(/nothing’s missing/i);

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx playwright test e2e/missing.spec.js --reporter=line`
Expected: PASS. (If the menu selector doesn't match, add a `source.openMenu(page)` + `source.reviewMissing(page)` helper to `e2e/helpers.js` and use it — do not inline brittle selectors.)

- [ ] **Step 3: Red/green check**

Temporarily remove the `onreviewmissing` wiring in the Toolbar pass-through; rerun; confirm the menuitem click fails (entry missing or dead). Restore.

- [ ] **Step 4: Bump + changelog + commit**

`package.json` → `2.15.16`. `CHANGELOG.md` `## 2.15.16`:

```
- Test: guard that the missing-files review panel opens and renders. (#1)
```

```bash
npx prettier --write e2e/missing.spec.js e2e/helpers.js CHANGELOG.md package.json
git add e2e/missing.spec.js e2e/helpers.js CHANGELOG.md package.json
git commit -m "test(missing): e2e guard for the review pane opening (2.15.16) (#1)"
```

---

## Final verification (after all tasks)

- [ ] `npm test` — full vitest suite green (including the new `server/db/missing.test.js`).
- [ ] `npx playwright test` — full e2e suite green (including `e2e/missing.spec.js`).
- [ ] `npm run build` — 0 warnings.
- [ ] `npm run format:check` (or `npx prettier --check`) — clean.
- [ ] Live pass on the real library: plug/rescan, confirm the nudge fires when a file is moved on disk, the pane lists it, relocate returns it to the grid with its rating, dismiss tombstones it, and a still-backed-up copy is flagged "still on disk". (App.svelte live-verify rule.)
- [ ] Confirm no keyboard shortcut was added (none in this plan); if one is added during implementation, document it in `ui/src/lib/ShortcutsOverlay.svelte` in the same commit.
