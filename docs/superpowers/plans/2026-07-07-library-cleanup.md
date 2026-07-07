# Library Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Manage library" panel that lets the user remove an indexed
folder from the SQLite index (real files untouched) and view/clear/prune the
thumbnail disk cache, closing out GitHub issue #31.

**Architecture:** Two independent server capabilities — folder removal
(`server/db/photos.js` + a new `DELETE /api/folders/:id` route) and cache
management (a new `server/lib/cacheStats.js` module + four small routes) —
both surfaced through one new client component (`ManageLibrary.svelte`)
reachable from the existing "Library ▾" dropdown in `App.svelte`.

**Tech Stack:** Node.js/Express, better-sqlite3, Svelte, vitest.

## Global Constraints

- ESM everywhere (`"type": "module"`), plain JS with JSDoc types — no
  TypeScript.
- Tests: vitest, colocated as `*.test.js` next to sources under `server/`.
- No automated tests for Svelte components — manual-only verification (this
  project's established convention).
- Real photo folders are never written to, moved, or deleted by anything in
  this plan — every destructive action only ever touches `~/.autogallery/`
  (the folders/photos rows in `index.db`, or files under
  `~/.autogallery/cache/thumbs/`).
- `THUMB_BUCKETS = [160, 320, 480, 640, 1024]` (from `ui/src/App.svelte`) is
  the exact, complete set of thumbnail sizes ever requested — cache-key
  recomputation must check exactly these five buckets, not an arbitrary
  range.
- The thumbnail cache key formula, unchanged, from `server/api.js`'s
  existing `/api/thumb/:id` route: `sha1(\`${path}:${mtime}:${size}:${bucket}\`)`
  hex digest, filename `<hex>.jpg` under `thumbsDir()`.

---

### Task 1: Server — folder removal

**Files:**
- Modify: `server/db/photos.js`
- Modify: `server/db/photos.test.js`
- Modify: `server/api.js`
- Modify: `server/api.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `deleteFolder(db, folderId)` returning `boolean` (`true` if a
  folder with that id existed and was removed, `false` if not found) — used
  only by this task's own route. `GET /api/library`'s response items gain an
  `id: number` field. `DELETE /api/folders/:id` returns `200 {removed:true}`
  or `404`. Task 3's client helpers consume this route's shape.

- [ ] **Step 1: Write the failing tests**

`server/db/photos.test.js`'s existing `beforeEach` already seeds a volume
row with id `1` (`INSERT INTO volumes (id, label, uuid, last_mount_path,
last_seen_at) VALUES (1, 'test-volume', ...)`) before each test, so
`upsertScan(db, path, 1, files)` (volume id `1`) is the right call to match
the existing fixture — no new setup needed. Add `deleteFolder` to the
existing import from `./photos.js` (find the line
`import { upsertScan, getPhotoById, setPhotoRating, setPhotoCover } from "./photos.js";`)
so it reads:

```js
import {
  upsertScan,
  getPhotoById,
  setPhotoRating,
  setPhotoCover,
  deleteFolder,
} from "./photos.js";
```

Then add this test block:

```js
describe("deleteFolder", () => {
  it("removes the folder and its photos, leaving other folders untouched", () => {
    const db = getDb();
    upsertScan(db, "/a", 1, [
      { name: "1.jpg", size: 10, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/b", 1, [
      { name: "2.jpg", size: 20, mtimeMs: 2, kind: "image" },
    ]);
    const folderAId = db
      .prepare(`SELECT id FROM folders WHERE abs_path = '/a'`)
      .get().id;

    const removed = deleteFolder(db, folderAId);
    expect(removed).toBe(true);

    expect(
      db.prepare(`SELECT * FROM folders WHERE id = ?`).get(folderAId)
    ).toBeUndefined();
    expect(
      db.prepare(`SELECT * FROM photos WHERE folder_id = ?`).all(folderAId)
    ).toEqual([]);

    // /b is untouched
    const folderBRow = db
      .prepare(`SELECT id FROM folders WHERE abs_path = '/b'`)
      .get();
    expect(folderBRow).toBeDefined();
    expect(
      db.prepare(`SELECT filename FROM photos WHERE folder_id = ?`).all(folderBRow.id)
    ).toEqual([{ filename: "2.jpg" }]);
  });

  it("returns false for an unknown folder id", () => {
    const db = getDb();
    expect(deleteFolder(db, 999999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/db/photos.test.js -t "deleteFolder"`
Expected: FAIL — `deleteFolder` is not exported yet.

- [ ] **Step 3: Implement `deleteFolder` in `server/db/photos.js`**

Add this function at the end of the file:

```js
/**
 * Remove a folder and its photos from the index. Real files on disk are
 * never touched — this only affects the `folders`/`photos` rows.
 * photo_album/tags aren't cleaned up here: album clustering (GH #3) isn't
 * implemented yet and those tables have no rows today.
 * @param {import("better-sqlite3").Database} db
 * @param {number} folderId
 * @returns {boolean} true if the folder existed and was removed
 */
export function deleteFolder(db, folderId) {
  const tx = db.transaction((id) => {
    const exists = db.prepare(`SELECT id FROM folders WHERE id = ?`).get(id);
    if (!exists) return false;
    db.prepare(`DELETE FROM photos WHERE folder_id = ?`).run(id);
    db.prepare(`DELETE FROM folders WHERE id = ?`).run(id);
    return true;
  });
  return tx(folderId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/db/photos.test.js -t "deleteFolder"`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing API tests**

Add to `server/api.test.js`, immediately after the existing
`describe("GET /api/library", ...)` block (search for
`describe("GET /api/library"` to find it):

```js
describe("GET /api/library id field", () => {
  it("includes each folder's id", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/library`);
    const body = await res.json();
    const entry = body.find((e) => e.path === photosDir);
    expect(entry).toBeDefined();
    expect(typeof entry.id).toBe("number");
  });
});

describe("DELETE /api/folders/:id", () => {
  it("404s for an unknown id", async () => {
    const res = await fetch(`${srv.base}/api/folders/999999`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("removes the folder and its photos; real files on disk are untouched", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ag-removeme-"));
    await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toFile(join(tempDir, "x.jpg"));

    await scan(srv.base, tempDir);
    const libRes = await fetch(`${srv.base}/api/library`);
    const lib = await libRes.json();
    const entry = lib.find((e) => e.path === tempDir);
    expect(entry).toBeDefined();

    const del = await fetch(`${srv.base}/api/folders/${entry.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const libRes2 = await fetch(`${srv.base}/api/library`);
    const lib2 = await libRes2.json();
    expect(lib2.some((e) => e.path === tempDir)).toBe(false);

    const stillOnDisk = await readdir(tempDir);
    expect(stillOnDisk).toEqual(["x.jpg"]);

    await rm(tempDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npx vitest run server/api.test.js -t "api/folders"`
Expected: FAIL — route doesn't exist (404 for the "removes" test's DELETE
call would currently be a generic Express 404, but the `id` field assertion
in the library test fails first since `entry.id` is `undefined`).

- [ ] **Step 7: Implement the route in `server/api.js`**

Add `deleteFolder` to the existing import from `./db/photos.js` (find the
line `import { upsertScan, getPhotoById, setPhotoRating, setPhotoCover } from "./db/photos.js";`):

```js
import {
  upsertScan,
  getPhotoById,
  setPhotoRating,
  setPhotoCover,
  deleteFolder,
} from "./db/photos.js";
```

Change the `GET /api/library` route's SELECT and mapping (find it by
searching for `app.get("/api/library"`) from:

```js
  app.get("/api/library", (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT folders.abs_path AS path, folders.last_scanned_at AS lastScannedAt,
                volumes.uuid AS volumeUuid, volumes.last_mount_path AS volumeMountPath
         FROM folders LEFT JOIN volumes ON volumes.id = folders.volume_id
         ORDER BY folders.last_scanned_at DESC`
      )
      .all();
    // isVolumeMounted shells out to `diskutil info` synchronously; memoize per
    // volume so N folders on the same volume cost one subprocess, not N.
    const mountedByVolumeKey = new Map();
    const entries = rows.map((r) => {
      const volumeKey = r.volumeUuid ?? r.volumeMountPath ?? null;
      let volumeMounted = true;
      if (volumeKey !== null) {
        if (!mountedByVolumeKey.has(volumeKey)) {
          mountedByVolumeKey.set(
            volumeKey,
            isVolumeMounted({
              uuid: r.volumeUuid,
              last_mount_path: r.volumeMountPath,
            })
          );
        }
        volumeMounted = mountedByVolumeKey.get(volumeKey);
      }
      return {
        path: r.path,
        name: basename(r.path),
        lastScannedAt: r.lastScannedAt,
        mounted: volumeMounted && existsSync(r.path),
      };
    });
    res.json(entries);
  });
```

to:

```js
  app.get("/api/library", (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT folders.id AS id, folders.abs_path AS path, folders.last_scanned_at AS lastScannedAt,
                volumes.uuid AS volumeUuid, volumes.last_mount_path AS volumeMountPath
         FROM folders LEFT JOIN volumes ON volumes.id = folders.volume_id
         ORDER BY folders.last_scanned_at DESC`
      )
      .all();
    // isVolumeMounted shells out to `diskutil info` synchronously; memoize per
    // volume so N folders on the same volume cost one subprocess, not N.
    const mountedByVolumeKey = new Map();
    const entries = rows.map((r) => {
      const volumeKey = r.volumeUuid ?? r.volumeMountPath ?? null;
      let volumeMounted = true;
      if (volumeKey !== null) {
        if (!mountedByVolumeKey.has(volumeKey)) {
          mountedByVolumeKey.set(
            volumeKey,
            isVolumeMounted({
              uuid: r.volumeUuid,
              last_mount_path: r.volumeMountPath,
            })
          );
        }
        volumeMounted = mountedByVolumeKey.get(volumeKey);
      }
      return {
        id: r.id,
        path: r.path,
        name: basename(r.path),
        lastScannedAt: r.lastScannedAt,
        mounted: volumeMounted && existsSync(r.path),
      };
    });
    res.json(entries);
  });

  app.delete("/api/folders/:id", (req, res) => {
    const db = getDb();
    const removed = deleteFolder(db, Number(req.params.id));
    if (!removed) return res.status(404).end();
    res.json({ removed: true });
  });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run server/api.test.js -t "api/folders"`
Run: `npx vitest run server/api.test.js -t "GET /api/library id field"`
Expected: PASS (3 tests total).

- [ ] **Step 9: Run the full server test suite**

Run: `npx vitest run server/`
Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add server/db/photos.js server/db/photos.test.js server/api.js server/api.test.js
git commit -m "feat: add folder removal (DELETE /api/folders/:id) and expose folder id in /api/library"
```

---

### Task 2: Server — cache management module and routes

**Files:**
- Create: `server/lib/cacheStats.js`
- Create: `server/lib/cacheStats.test.js`
- Modify: `server/api.js`
- Modify: `server/api.test.js`

**Interfaces:**
- Consumes: `thumbsDir()` from `server/lib/cachePaths.js` (existing).
- Produces: `getCacheStats()` → `{totalBytes:number, totalFiles:number}`.
  `getCacheBreakdown(db)` → `{folders: Array<{id:number, path:string,
  cachedBytes:number, cachedFiles:number}>}`. `clearCache()` →
  `{freedBytes:number, freedFiles:number}`. `pruneOrphanedCache(db)` →
  `{freedBytes:number, freedFiles:number}`. Four routes:
  `GET /api/cache/stats`, `GET /api/cache/breakdown`,
  `POST /api/cache/clear`, `POST /api/cache/prune`, each just JSON-ifying
  the corresponding function's return value. Task 3's client helpers consume
  these four routes.

- [ ] **Step 1: Write the failing tests**

Create `server/lib/cacheStats.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import {
  getCacheStats,
  getCacheBreakdown,
  clearCache,
  pruneOrphanedCache,
} from "./cacheStats.js";

let cacheDir;

function cacheKeyFor(path, mtime, size, bucket) {
  return createHash("sha1")
    .update(`${path}:${mtime}:${size}:${bucket}`)
    .digest("hex");
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-cachestats-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("getCacheStats", () => {
  it("sums bytes and counts files in the thumbnail cache dir", async () => {
    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.jpg"), Buffer.alloc(100));
    await writeFile(join(dir, "b.jpg"), Buffer.alloc(50));

    const stats = getCacheStats();
    expect(stats).toEqual({ totalBytes: 150, totalFiles: 2 });
  });

  it("returns zeros for an empty cache", () => {
    expect(getCacheStats()).toEqual({ totalBytes: 0, totalFiles: 0 });
  });
});

describe("getCacheBreakdown", () => {
  it("attributes a cached thumbnail's bytes to its source folder", async () => {
    const db = getDb();
    upsertScan(db, "/photos/folderA", 1, [
      { name: "a.jpg", size: 111, mtimeMs: 222, kind: "image" },
    ]);
    const folder = db
      .prepare(`SELECT id FROM folders WHERE abs_path = '/photos/folderA'`)
      .get();

    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    const key = cacheKeyFor(
      join("/photos/folderA", "a.jpg"),
      222,
      111,
      320 // one of THUMB_BUCKETS
    );
    await writeFile(join(dir, `${key}.jpg`), Buffer.alloc(77));

    const breakdown = getCacheBreakdown(db);
    expect(breakdown.folders).toEqual([
      {
        id: folder.id,
        path: "/photos/folderA",
        cachedBytes: 77,
        cachedFiles: 1,
      },
    ]);
  });

  it("returns an empty list when nothing is indexed", () => {
    const db = getDb();
    expect(getCacheBreakdown(db)).toEqual({ folders: [] });
  });
});

describe("clearCache", () => {
  it("deletes every file in the cache dir and reports what was freed", async () => {
    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.jpg"), Buffer.alloc(10));
    await writeFile(join(dir, "b.jpg"), Buffer.alloc(20));

    const result = clearCache();
    expect(result).toEqual({ freedBytes: 30, freedFiles: 2 });
    expect(getCacheStats()).toEqual({ totalBytes: 0, totalFiles: 0 });
  });
});

describe("pruneOrphanedCache", () => {
  it("removes only files with no corresponding indexed photo", async () => {
    const db = getDb();
    upsertScan(db, "/photos/folderB", 1, [
      { name: "live.jpg", size: 5, mtimeMs: 9, kind: "image" },
    ]);

    const dir = join(cacheDir, "cache", "thumbs");
    await mkdir(dir, { recursive: true });
    const liveKey = cacheKeyFor(join("/photos/folderB", "live.jpg"), 9, 5, 160);
    await writeFile(join(dir, `${liveKey}.jpg`), Buffer.alloc(10));
    await writeFile(join(dir, "orphan123.jpg"), Buffer.alloc(20));

    const result = pruneOrphanedCache(db);
    expect(result).toEqual({ freedBytes: 20, freedFiles: 1 });

    const remaining = getCacheStats();
    expect(remaining).toEqual({ totalBytes: 10, totalFiles: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/lib/cacheStats.test.js`
Expected: FAIL — `./cacheStats.js` doesn't exist yet.

- [ ] **Step 3: Implement `server/lib/cacheStats.js`**

```js
import { createHash } from "node:crypto";
import { existsSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { thumbsDir } from "./cachePaths.js";

// Every thumbnail size the client ever requests (ui/src/App.svelte snaps
// the displayed size to one of these five, specifically so the disk cache
// doesn't fragment per pixel) — the complete, exhaustive set to check.
const THUMB_BUCKETS = [160, 320, 480, 640, 1024];

/**
 * The exact cache-key formula from GET /api/thumb/:id (server/api.js) —
 * kept in sync manually since duplicating a one-line hash call is simpler
 * than adding a shared-module indirection for a single expression.
 * @param {{path:string, mtime:number, size:number}} photo
 * @param {number} bucket
 * @returns {string} sha1 hex key
 */
function cacheKeyFor(photo, bucket) {
  return createHash("sha1")
    .update(`${photo.path}:${photo.mtime}:${photo.size}:${bucket}`)
    .digest("hex");
}

/**
 * @param {{path:string, mtime:number, size:number}} photo
 * @returns {string[]} the cache key for every bucket this photo could have
 */
function expectedCacheKeys(photo) {
  return THUMB_BUCKETS.map((bucket) => cacheKeyFor(photo, bucket));
}

/** @returns {{totalBytes:number, totalFiles:number}} */
export function getCacheStats() {
  const dir = thumbsDir();
  const files = readdirSync(dir);
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += statSync(join(dir, f)).size;
  }
  return { totalBytes, totalFiles: files.length };
}

/**
 * Attributes cached thumbnail bytes to the folder each source photo lives
 * in. The flat, content-hash-keyed cache has no stored folder association,
 * so this recomputes each indexed photo's possible cache keys (one per
 * THUMB_BUCKETS entry) and checks which exist on disk — the only way to
 * attribute usage given the current cache design.
 * @param {import("better-sqlite3").Database} db
 * @returns {{folders: Array<{id:number, path:string, cachedBytes:number, cachedFiles:number}>}}
 */
export function getCacheBreakdown(db) {
  const rows = db
    .prepare(
      `SELECT photos.filename, photos.size, photos.mtime,
              folders.id AS folderId, folders.abs_path AS folderPath
       FROM photos JOIN folders ON folders.id = photos.folder_id`
    )
    .all();

  const dir = thumbsDir();
  const byFolder = new Map();
  for (const r of rows) {
    const photo = {
      path: join(r.folderPath, r.filename),
      mtime: r.mtime,
      size: r.size,
    };
    let entry = byFolder.get(r.folderId);
    if (!entry) {
      entry = {
        id: r.folderId,
        path: r.folderPath,
        cachedBytes: 0,
        cachedFiles: 0,
      };
      byFolder.set(r.folderId, entry);
    }
    for (const key of expectedCacheKeys(photo)) {
      const cachePath = join(dir, `${key}.jpg`);
      if (existsSync(cachePath)) {
        entry.cachedBytes += statSync(cachePath).size;
        entry.cachedFiles += 1;
      }
    }
  }
  return { folders: [...byFolder.values()] };
}

/** @returns {{freedBytes:number, freedFiles:number}} */
export function clearCache() {
  const dir = thumbsDir();
  const files = readdirSync(dir);
  let freedBytes = 0;
  for (const f of files) {
    const p = join(dir, f);
    freedBytes += statSync(p).size;
    unlinkSync(p);
  }
  return { freedBytes, freedFiles: files.length };
}

/**
 * Deletes cache files with no corresponding indexed photo (orphans left
 * behind by a removed photo/folder, or a stale entry whose source file
 * changed on disk before a rescan). Never touches a source folder.
 * @param {import("better-sqlite3").Database} db
 * @returns {{freedBytes:number, freedFiles:number}}
 */
export function pruneOrphanedCache(db) {
  const rows = db
    .prepare(
      `SELECT photos.filename, photos.size, photos.mtime, folders.abs_path AS folderPath
       FROM photos JOIN folders ON folders.id = photos.folder_id`
    )
    .all();

  const expected = new Set();
  for (const r of rows) {
    const photo = {
      path: join(r.folderPath, r.filename),
      mtime: r.mtime,
      size: r.size,
    };
    for (const key of expectedCacheKeys(photo)) expected.add(key);
  }

  const dir = thumbsDir();
  const files = readdirSync(dir);
  let freedBytes = 0;
  let freedFiles = 0;
  for (const f of files) {
    const key = f.endsWith(".jpg") ? f.slice(0, -4) : f;
    if (!expected.has(key)) {
      const p = join(dir, f);
      freedBytes += statSync(p).size;
      unlinkSync(p);
      freedFiles += 1;
    }
  }
  return { freedBytes, freedFiles };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/lib/cacheStats.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Add the routes to `server/api.js`**

Add this import near the top, alongside the existing `thumbsDir` import
(find the line `import { thumbsDir } from "./lib/cachePaths.js";`):

```js
import { thumbsDir } from "./lib/cachePaths.js";
import {
  getCacheStats,
  getCacheBreakdown,
  clearCache,
  pruneOrphanedCache,
} from "./lib/cacheStats.js";
```

Add these routes immediately after the `DELETE /api/folders/:id` route
added in Task 1:

```js
  app.get("/api/cache/stats", (_req, res) => {
    res.json(getCacheStats());
  });

  app.get("/api/cache/breakdown", (_req, res) => {
    res.json(getCacheBreakdown(getDb()));
  });

  app.post("/api/cache/clear", (_req, res) => {
    res.json(clearCache());
  });

  app.post("/api/cache/prune", (_req, res) => {
    res.json(pruneOrphanedCache(getDb()));
  });
```

- [ ] **Step 6: Write the failing route-level tests**

Add to `server/api.test.js`, after the `describe("DELETE /api/folders/:id"...)`
block added in Task 1:

```js
describe("cache management routes", () => {
  it("GET /api/cache/stats reflects real cache dir contents", async () => {
    await fetch(`${srv.base}/api/cache/clear`, { method: "POST" });
    const before = await (await fetch(`${srv.base}/api/cache/stats`)).json();
    expect(before).toEqual({ totalBytes: 0, totalFiles: 0 });

    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=64`);

    const after = await (await fetch(`${srv.base}/api/cache/stats`)).json();
    expect(after.totalFiles).toBe(1);
    expect(after.totalBytes).toBeGreaterThan(0);
  });

  it("GET /api/cache/breakdown attributes the cached thumbnail to its folder", async () => {
    await fetch(`${srv.base}/api/cache/clear`, { method: "POST" });
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=320`);

    const breakdown = await (
      await fetch(`${srv.base}/api/cache/breakdown`)
    ).json();
    const entry = breakdown.folders.find((f) => f.path === photosDir);
    expect(entry).toBeDefined();
    expect(entry.cachedFiles).toBeGreaterThanOrEqual(1);
    expect(entry.cachedBytes).toBeGreaterThan(0);
  });

  it("POST /api/cache/clear empties the cache", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=160`);
    expect((await (await fetch(`${srv.base}/api/cache/stats`)).json()).totalFiles).toBeGreaterThan(0);

    const result = await (
      await fetch(`${srv.base}/api/cache/clear`, { method: "POST" })
    ).json();
    expect(result.freedFiles).toBeGreaterThan(0);

    expect(await (await fetch(`${srv.base}/api/cache/stats`)).json()).toEqual({
      totalBytes: 0,
      totalFiles: 0,
    });
  });

  it("POST /api/cache/prune removes an orphaned file left after folder removal", async () => {
    await fetch(`${srv.base}/api/cache/clear`, { method: "POST" });
    const tempDir = await mkdtemp(join(tmpdir(), "ag-prunetest-"));
    await sharp({
      create: { width: 40, height: 30, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toFile(join(tempDir, "z.jpg"));

    const scanBody = await scan(srv.base, tempDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/thumb/${id}?size=160`);
    expect((await (await fetch(`${srv.base}/api/cache/stats`)).json()).totalFiles).toBe(1);

    const lib = await (await fetch(`${srv.base}/api/library`)).json();
    const entry = lib.find((e) => e.path === tempDir);
    await fetch(`${srv.base}/api/folders/${entry.id}`, { method: "DELETE" });

    const pruneResult = await (
      await fetch(`${srv.base}/api/cache/prune`, { method: "POST" })
    ).json();
    expect(pruneResult.freedFiles).toBe(1);
    expect(await (await fetch(`${srv.base}/api/cache/stats`)).json()).toEqual({
      totalBytes: 0,
      totalFiles: 0,
    });

    await rm(tempDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run server/api.test.js -t "cache management routes"`
Expected: PASS (4 tests).

- [ ] **Step 8: Run the full server test suite**

Run: `npx vitest run server/`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add server/lib/cacheStats.js server/lib/cacheStats.test.js server/api.js server/api.test.js
git commit -m "feat: add cache stats/breakdown/clear/prune module and routes"
```

---

### Task 3: Client — API helpers

**Files:**
- Modify: `ui/src/lib/api.js`

**Interfaces:**
- Consumes: the five routes from Tasks 1-2.
- Produces: `deleteFolder(id)`, `fetchCacheStats()`, `fetchCacheBreakdown()`,
  `clearCache()`, `pruneCache()`. Task 4 consumes all five.

No dedicated test file — matches this project's existing precedent for
`ui/src/lib/api.js` (thin fetch wrappers, exercised via the server's own
route tests and manual verification).

- [ ] **Step 1: Add the five functions**

In `ui/src/lib/api.js`, add these immediately after the existing
`fetchLibrary` function (find it by searching for
`export async function fetchLibrary`):

```js
/** @param {number} id */
export async function deleteFolder(id) {
  const res = await fetch(`/api/folders/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete folder failed (${res.status})`);
  return res.json();
}

/** @returns {Promise<{totalBytes:number, totalFiles:number}>} */
export async function fetchCacheStats() {
  const res = await fetch("/api/cache/stats");
  if (!res.ok) throw new Error(`cache stats failed (${res.status})`);
  return res.json();
}

/** @returns {Promise<{folders: Array<{id:number, path:string, cachedBytes:number, cachedFiles:number}>}>} */
export async function fetchCacheBreakdown() {
  const res = await fetch("/api/cache/breakdown");
  if (!res.ok) throw new Error(`cache breakdown failed (${res.status})`);
  return res.json();
}

/** @returns {Promise<{freedBytes:number, freedFiles:number}>} */
export async function clearCache() {
  const res = await fetch("/api/cache/clear", { method: "POST" });
  if (!res.ok) throw new Error(`cache clear failed (${res.status})`);
  return res.json();
}

/** @returns {Promise<{freedBytes:number, freedFiles:number}>} */
export async function pruneCache() {
  const res = await fetch("/api/cache/prune", { method: "POST" });
  if (!res.ok) throw new Error(`cache prune failed (${res.status})`);
  return res.json();
}
```

- [ ] **Step 2: Run the full client test suite to confirm nothing broke**

Run: `npx vitest run ui/`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/api.js
git commit -m "feat: add client API helpers for folder removal and cache management"
```

---

### Task 4: Client — `ManageLibrary.svelte` panel and `App.svelte` integration

**Files:**
- Create: `ui/src/lib/ManageLibrary.svelte`
- Modify: `ui/src/App.svelte`

**Interfaces:**
- Consumes: `deleteFolder`, `fetchCacheStats`, `fetchCacheBreakdown`,
  `clearCache`, `pruneCache` from Task 3; `library` (existing state, an
  array of `{id, path, name, lastScannedAt, mounted}` from `fetchLibrary`)
  passed in as a prop.
- Produces: dispatches `close` (panel dismissed) and `folderRemoved` (a
  folder was removed — `App.svelte` refreshes the library list and, since
  there's no existing notion of "which folder is currently being viewed"
  in this codebase's flat/paginated feed model, unconditionally calls
  `loadInitialFeed()` to guarantee the view can never be left pointing at
  since-removed data — simpler and equally correct as trying to detect
  whether the removed folder specifically overlapped the current view).

- [ ] **Step 1: Create `ui/src/lib/ManageLibrary.svelte`**

```svelte
<script>
  import { createEventDispatcher } from "svelte";
  import {
    deleteFolder,
    fetchCacheStats,
    fetchCacheBreakdown,
    clearCache,
    pruneCache,
  } from "./api.js";

  export let library = [];

  const dispatch = createEventDispatcher();

  let stats = null;
  let breakdown = null;
  let breakdownLoading = false;
  let busy = false;
  let message = "";

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  async function loadStats() {
    stats = await fetchCacheStats().catch(() => null);
  }
  loadStats();

  async function showBreakdown() {
    breakdownLoading = true;
    breakdown = await fetchCacheBreakdown().catch(() => ({ folders: [] }));
    breakdownLoading = false;
  }

  async function removeFolder(entry) {
    if (!confirm(`Remove "${entry.name}" from the library? Real files on disk are not affected.`)) {
      return;
    }
    busy = true;
    try {
      await deleteFolder(entry.id);
      dispatch("folderRemoved", { id: entry.id });
      message = `Removed "${entry.name}".`;
    } catch (e) {
      message = e.message;
    } finally {
      busy = false;
    }
  }

  async function doClearCache() {
    if (!confirm("Clear the entire thumbnail cache? It will regenerate automatically as photos are viewed again.")) {
      return;
    }
    busy = true;
    try {
      const result = await clearCache();
      message = `Cleared ${result.freedFiles} file(s), freed ${formatBytes(result.freedBytes)}.`;
      breakdown = null;
      await loadStats();
    } catch (e) {
      message = e.message;
    } finally {
      busy = false;
    }
  }

  async function doPruneCache() {
    busy = true;
    try {
      const result = await pruneCache();
      message = `Pruned ${result.freedFiles} orphaned file(s), freed ${formatBytes(result.freedBytes)}.`;
      breakdown = null;
      await loadStats();
    } catch (e) {
      message = e.message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="manage-library-backdrop" on:click={() => dispatch("close")}>
  <div class="manage-library-panel" on:click|stopPropagation>
    <header>
      <h2>Manage library</h2>
      <button class="close-btn" on:click={() => dispatch("close")}>✕</button>
    </header>

    {#if message}<p class="message">{message}</p>{/if}

    <section>
      <h3>Indexed folders</h3>
      {#if library.length === 0}
        <p class="empty">No folders scanned yet.</p>
      {/if}
      <ul class="folder-list">
        {#each library as entry (entry.id)}
          <li>
            <span class="folder-path" title={entry.path}>{entry.name}</span>
            {#if !entry.mounted}<span class="offline-badge">offline</span>{/if}
            <button
              class="remove-btn"
              disabled={busy}
              on:click={() => removeFolder(entry)}
            >
              Remove
            </button>
          </li>
        {/each}
      </ul>
    </section>

    <section>
      <h3>Thumbnail cache</h3>
      {#if stats}
        <p>{formatBytes(stats.totalBytes)} in {stats.totalFiles} file(s)</p>
      {:else}
        <p class="empty">Loading…</p>
      {/if}

      <div class="cache-actions">
        <button disabled={busy} on:click={showBreakdown}>
          {breakdownLoading ? "Computing…" : "Show breakdown"}
        </button>
        <button disabled={busy} on:click={doClearCache}>Clear cache</button>
        <button disabled={busy} on:click={doPruneCache}>Prune orphaned</button>
      </div>

      {#if breakdown}
        {#if breakdown.folders.length === 0}
          <p class="empty">No cached thumbnails attributed to any folder.</p>
        {:else}
          <ul class="breakdown-list">
            {#each breakdown.folders as f (f.id)}
              <li>
                <span class="folder-path" title={f.path}>{f.path}</span>
                <span>{formatBytes(f.cachedBytes)} ({f.cachedFiles} files)</span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </section>
  </div>
</div>

<style>
  .manage-library-backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .manage-library-panel {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 8px;
    width: min(560px, 90vw);
    max-height: 80vh;
    overflow-y: auto;
    padding: 1rem 1.25rem;
    color: inherit;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  h3 {
    margin: 0.75rem 0 0.4rem;
    font-size: 0.95rem;
    color: #ccc;
  }
  .close-btn {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
  }
  .message {
    background: #2a2a2a;
    border-radius: 4px;
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
  }
  .empty {
    color: #888;
    font-size: 0.85rem;
  }
  .folder-list,
  .breakdown-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .folder-list li,
  .breakdown-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid #2a2a2a;
  }
  .folder-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
  }
  .offline-badge {
    font-size: 0.7rem;
    color: #888;
  }
  .remove-btn,
  .cache-actions button {
    background: #333;
    color: inherit;
    border: none;
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .remove-btn:hover:not(:disabled),
  .cache-actions button:hover:not(:disabled) {
    background: #444;
  }
  .remove-btn:disabled,
  .cache-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cache-actions {
    display: flex;
    gap: 0.5rem;
    margin: 0.4rem 0;
  }
  .breakdown-list li span:last-child {
    font-size: 0.8rem;
    color: #aaa;
  }
</style>
```

- [ ] **Step 2: Wire it into `App.svelte`**

Add the import (find the line `import TreeSidebar from "./lib/TreeSidebar.svelte";`):

```js
  import TreeSidebar from "./lib/TreeSidebar.svelte";
  import ManageLibrary from "./lib/ManageLibrary.svelte";
```

Add new state near the existing `let libraryOpen` declaration (search for
`libraryOpen`):

```js
  let manageLibraryOpen = false;
```

Add a handler function near `refreshLibrary` (search for
`async function refreshLibrary`):

```js
  async function onFolderRemoved() {
    await refreshLibrary();
    loadInitialFeed();
  }
```

In the template, add a "Manage library…" entry to the existing library
panel (find the `{#if libraryOpen}` block, specifically the closing
`</ul>` right before `{/if}`):

```svelte
          {#each library as entry (entry.path)}
            <li>
              <button
                class="library-entry"
                class:offline={!entry.mounted}
                disabled={!entry.mounted}
                on:click={() => selectFromLibrary(entry)}
                title={entry.path}
              >
                {entry.name}
                {#if !entry.mounted}<span class="offline-badge">offline</span>{/if}
              </button>
            </li>
          {/each}
          <li>
            <button
              class="library-entry"
              on:click={() => {
                libraryOpen = false;
                manageLibraryOpen = true;
              }}
            >
              Manage library…
            </button>
          </li>
        </ul>
```

Add the panel itself right after the closing `</div>` of the `.library`
div (search for the end of the library dropdown block, right before the
next major template section):

```svelte
    {#if manageLibraryOpen}
      <ManageLibrary
        {library}
        on:close={() => (manageLibraryOpen = false)}
        on:folderRemoved={onFolderRemoved}
      />
    {/if}
```

- [ ] **Step 3: Run the full test suite and build**

Run: `npx vitest run`
Expected: All tests pass (this task touches only Svelte component code, no
pure-function logic covered by existing tests).

Run: `npm run build`
Expected: Builds successfully with no compile errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/ManageLibrary.svelte ui/src/App.svelte
git commit -m "feat: add Manage Library panel (folder removal + cache management UI)"
```

---

### Task 5: Manual validation against real indexed data

**Files:** none (verification only).

**Interfaces:** none — this task consumes the finished feature end-to-end.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify folder removal**

Scan a small, disposable test folder (not one of the real archives in
`docs/TEST_FOLDERS.local.md` — use a throwaway temp folder with a couple of
JPEGs instead, since this action is destructive to the index). Open
"Library ▾" → "Manage library…", confirm the folder appears with a photo
count, click "Remove", confirm the browser's confirm dialog appears,
confirm, and verify: the folder disappears from both the management panel
and the main `Library ▾` dropdown, the feed resets to its default view, and
the real files are still present on disk (`ls` the folder).

- [ ] **Step 3: Verify cache stats and breakdown**

With one of the real, already-scanned test folders from
`docs/TEST_FOLDERS.local.md`, open the Manage Library panel and confirm the
total cache size roughly matches `du -sh ~/.autogallery/cache/thumbs`. Click
"Show breakdown" and confirm it lists that folder with a nonzero size.

- [ ] **Step 4: Verify clear cache**

Click "Clear cache", confirm the confirmation dialog, confirm afterward that
`~/.autogallery/cache/thumbs` is empty (`ls` it) and that re-viewing the
same folder's grid regenerates thumbnails (no errors, thumbnails load as
before, just slower on first paint).

- [ ] **Step 5: Verify prune**

After removing a test folder (Step 2) whose thumbnails were already cached
before removal, click "Prune orphaned" and confirm it reports freeing at
least one file, and that a subsequent "Show breakdown" no longer lists that
folder.

- [ ] **Step 6: Check for console errors**

Confirm no unexpected console errors during the above.

- [ ] **Step 7: Stop the dev server**

No commit for this task — it's verification only.
