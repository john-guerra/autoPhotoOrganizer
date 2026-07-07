# Persistent Multi-Drive Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory single-folder scan session with a persistent
SQLite index (`~/.autogallery/index.db`) spanning multiple folders across
multiple drives, giving every photo a stable id, tracking which physical
volume each folder lives on, and making exact-duplicate/backup-coverage
detection a free query.

**Architecture:** `better-sqlite3` (synchronous, matches the existing
Express request/response style). New `server/db/` module: `connection.js`
(singleton DB handle + schema bootstrap), `schema.js` (DDL), `volumes.js`
(diskutil-backed volume identity), `photos.js` (folder/photo upsert +
lookup + rating/cover setters), `hashing.js` (lazy background content-hash
job), `backupCoverage.js` (exact-hash cross-volume queries). A one-time
`server/migrateLegacyJson.js` imports the existing `ratings.json` /
`coverChoices.json` / `library.json` / `metacache.json` into the new
schema, then those four legacy modules and their JSON files are retired.
`server/api.js` is cut over to read/write through the DB instead of the
in-memory `session` object.

**Tech Stack:** Node.js (ESM), Express, `better-sqlite3`, vitest.

## Global Constraints

- ESM everywhere (`"type": "module"`) — no TypeScript.
- No comments explaining *what* code does; only non-obvious *why* (existing
  project convention, see `CLAUDE.md`).
- Every test is colocated as `*.test.js` next to its source, vitest.
- Real photo folders (`docs/TEST_FOLDERS.local.md`) are **strictly
  read-only** — tests use synthetic temp fixtures only, never those real
  folders; only the final manual validation task touches a real folder,
  and only to read.
- All app writes land under `~/.autogallery/` (`AUTOGALLERY_HOME` env var
  override for tests — see `server/lib/cachePaths.js`), never back into a
  scanned folder.
- `node >=22` (`package.json` engines).

---

## Task 1: SQLite dependency, schema, and connection

**Files:**
- Modify: `package.json` (add `better-sqlite3` dependency, add
  `node_modules/better-sqlite3/**` to the `build.asarUnpack` array next to
  the existing `node_modules/sharp/**` entry — same reasoning: native
  binary must survive Electron's asar packaging)
- Modify: `server/lib/cachePaths.js` (add `indexDbFile()`)
- Create: `server/db/schema.js`
- Create: `server/db/connection.js`
- Test: `server/db/connection.test.js`

**Interfaces:**
- Produces: `indexDbFile(): string` (from `cachePaths.js`) — absolute path
  to `~/.autogallery/index.db`, respects `AUTOGALLERY_HOME`.
- Produces: `applySchema(db: BetterSqlite3.Database): void` (from
  `schema.js`).
- Produces: `getDb(): BetterSqlite3.Database` and
  `_resetDbForTest(): void` (from `connection.js`) — every later task
  imports `getDb` from here.

- [ ] **Step 1: Install the dependency**

Run: `npm install better-sqlite3@^12`
Expected: `package.json` and `package-lock.json` updated, install
completes without a native-build error (prebuilt binary for darwin/arm64
already confirmed to work in this environment).

- [ ] **Step 2: Add `indexDbFile()` to `cachePaths.js`**

Add this function to `server/lib/cachePaths.js`, following the exact same
pattern as the other functions in that file:

```js
/** @returns {string} Absolute path to the SQLite index database file. */
export function indexDbFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "index.db");
}
```

- [ ] **Step 3: Add the Electron asarUnpack entry**

In `package.json`, under `build.asarUnpack`, add
`"node_modules/better-sqlite3/**"` so the array becomes:

```json
"asarUnpack": [
  "node_modules/sharp/**",
  "node_modules/@img/**",
  "node_modules/better-sqlite3/**"
]
```

- [ ] **Step 4: Write the schema module**

Create `server/db/schema.js`:

```js
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS volumes (
  id INTEGER PRIMARY KEY,
  label TEXT,
  uuid TEXT UNIQUE,
  last_mount_path TEXT,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  abs_path TEXT NOT NULL UNIQUE,
  volume_id INTEGER REFERENCES volumes(id),
  last_scanned_at INTEGER
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  content_hash TEXT,
  taken_at INTEGER,
  width INTEGER,
  height INTEGER,
  camera TEXT,
  kind TEXT NOT NULL,
  perceptual_hash TEXT,
  rating INTEGER NOT NULL DEFAULT 0,
  preferred_cover INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  UNIQUE(folder_id, filename)
);
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_content_hash ON photos(content_hash);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  name TEXT,
  start_at INTEGER,
  end_at INTEGER
);
CREATE TABLE IF NOT EXISTS photo_album (
  photo_id INTEGER REFERENCES photos(id),
  album_id INTEGER REFERENCES albums(id),
  PRIMARY KEY (photo_id, album_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  dimension_name TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(dimension_name, value)
);
CREATE TABLE IF NOT EXISTS photo_tags (
  photo_id INTEGER REFERENCES photos(id),
  tag_id INTEGER REFERENCES tags(id),
  source TEXT NOT NULL,
  PRIMARY KEY (photo_id, tag_id)
);
`;

/** @param {import("better-sqlite3").Database} db */
export function applySchema(db) {
  db.exec(SCHEMA_SQL);
}
```

- [ ] **Step 5: Write the connection module**

Create `server/db/connection.js`:

```js
import Database from "better-sqlite3";
import { indexDbFile } from "../lib/cachePaths.js";
import { applySchema } from "./schema.js";

/** @type {import("better-sqlite3").Database | null} */
let db = null;

/** @returns {import("better-sqlite3").Database} */
export function getDb() {
  if (db) return db;
  db = new Database(indexDbFile());
  db.pragma("journal_mode = WAL");
  applySchema(db);
  return db;
}

/** Close and drop the cached connection (tests only). */
export function _resetDbForTest() {
  if (db) {
    db.close();
    db = null;
  }
}
```

- [ ] **Step 6: Write the failing test**

Create `server/db/connection.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("getDb", () => {
  it("creates all expected tables", () => {
    const db = getDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "volumes",
        "folders",
        "photos",
        "albums",
        "photo_album",
        "tags",
        "photo_tags",
      ])
    );
  });

  it("returns the same connection on repeated calls", () => {
    expect(getDb()).toBe(getDb());
  });

  it("is idempotent to re-apply the schema on an existing db file", () => {
    getDb();
    _resetDbForTest();
    expect(() => getDb()).not.toThrow();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run server/db/connection.test.js`
Expected: FAIL — `Cannot find module './connection.js'` (files don't exist
yet if you're doing steps out of order; if you followed steps 4-5 first,
skip to Step 8).

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run server/db/connection.test.js`
Expected: 3 passed.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json server/lib/cachePaths.js server/db/schema.js server/db/connection.js server/db/connection.test.js
git commit -m "feat: add SQLite index schema and connection module"
```

---

## Task 2: Volume identity (diskutil-backed)

**Files:**
- Create: `server/db/volumes.js`
- Test: `server/db/volumes.test.js`

**Interfaces:**
- Consumes: `getDb()` from `server/db/connection.js` (Task 1).
- Produces: `volumeRootForPath(absPath: string): string`,
  `getVolumeInfo(mountRoot: string, exec?: (mountRoot: string) => string): {uuid: string|null, label: string}`,
  `upsertVolume(db, mountRoot: string, exec?): number` (returns volume id),
  `isVolumeMounted(volumeRow: {uuid: string|null, last_mount_path: string}, exec?): boolean`
  — all consumed by Task 3 (`photos.js`) and Task 9 (`api.js` cutover).

- [ ] **Step 1: Write the failing tests**

Create `server/db/volumes.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import {
  volumeRootForPath,
  getVolumeInfo,
  upsertVolume,
  isVolumeMounted,
} from "./volumes.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("volumeRootForPath", () => {
  it("returns the /Volumes/<Name> prefix for an external drive path", () => {
    expect(volumeRootForPath("/Volumes/EOS_DIG_256/DCIM/101CANON")).toBe(
      "/Volumes/EOS_DIG_256"
    );
  });

  it("returns / for a path on the internal disk", () => {
    expect(volumeRootForPath("/Users/john/Pictures/trip")).toBe("/");
  });
});

describe("getVolumeInfo", () => {
  it("parses Volume UUID and Volume Name from diskutil output", () => {
    const fakeExec = () =>
      "   Volume Name:               EOS_DIG_256\n" +
      "   Volume UUID:               34B1102D-EC2C-431A-B14A-AE1381C18125\n";
    const info = getVolumeInfo("/Volumes/EOS_DIG_256", fakeExec);
    expect(info).toEqual({
      uuid: "34B1102D-EC2C-431A-B14A-AE1381C18125",
      label: "EOS_DIG_256",
    });
  });

  it("falls back to a null uuid and basename label when exec throws", () => {
    const throwingExec = () => {
      throw new Error("diskutil not found");
    };
    const info = getVolumeInfo("/Volumes/Whatever", throwingExec);
    expect(info).toEqual({ uuid: null, label: "Whatever" });
  });
});

describe("upsertVolume", () => {
  it("creates a volume row keyed by uuid and returns its id", () => {
    const db = getDb();
    const fakeExec = () => "   Volume Name:  Foo\n   Volume UUID:  AAA-111\n";
    const id1 = upsertVolume(db, "/Volumes/Foo", fakeExec);
    const id2 = upsertVolume(db, "/Volumes/Foo", fakeExec);
    expect(id1).toBe(id2);
    const row = db.prepare("SELECT * FROM volumes WHERE id = ?").get(id1);
    expect(row).toMatchObject({ uuid: "AAA-111", label: "Foo" });
  });

  it("re-links to the same volume row even if the mount path changes", () => {
    const db = getDb();
    const fakeExec = () => "   Volume Name:  Foo\n   Volume UUID:  AAA-111\n";
    const id1 = upsertVolume(db, "/Volumes/Foo", fakeExec);
    const id2 = upsertVolume(db, "/Volumes/Foo 1", fakeExec); // remounted with a suffix
    expect(id1).toBe(id2);
  });

  it("falls back to mount-path keying when no uuid is available", () => {
    const db = getDb();
    const throwingExec = () => {
      throw new Error("no diskutil");
    };
    const id1 = upsertVolume(db, "/Volumes/NoUuid", throwingExec);
    const id2 = upsertVolume(db, "/Volumes/NoUuid", throwingExec);
    expect(id1).toBe(id2);
  });
});

describe("isVolumeMounted", () => {
  it("returns true when the current mount path reports the same uuid", () => {
    const fakeExec = () => "   Volume UUID:  AAA-111\n";
    expect(
      isVolumeMounted(
        { uuid: "AAA-111", last_mount_path: "/Volumes/Foo" },
        fakeExec
      )
    ).toBe(true);
  });

  it("returns false when a different drive is now at the same mount path", () => {
    const fakeExec = () => "   Volume UUID:  DIFFERENT-999\n";
    expect(
      isVolumeMounted(
        { uuid: "AAA-111", last_mount_path: "/Volumes/Foo" },
        fakeExec
      )
    ).toBe(false);
  });

  it("returns false when diskutil throws (drive unmounted)", () => {
    const throwingExec = () => {
      throw new Error("not mounted");
    };
    expect(
      isVolumeMounted(
        { uuid: "AAA-111", last_mount_path: "/Volumes/Foo" },
        throwingExec
      )
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/db/volumes.test.js`
Expected: FAIL with "Cannot find module './volumes.js'".

- [ ] **Step 3: Write the implementation**

Create `server/db/volumes.js`:

```js
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/** @param {string} absPath @returns {string} */
export function volumeRootForPath(absPath) {
  const match = /^(\/Volumes\/[^/]+)/.exec(absPath);
  return match ? match[1] : "/";
}

function defaultExec(mountRoot) {
  return execFileSync("diskutil", ["info", mountRoot], { encoding: "utf8" });
}

/**
 * @param {string} mountRoot
 * @param {(mountRoot: string) => string} [exec]
 * @returns {{uuid: string|null, label: string}}
 */
export function getVolumeInfo(mountRoot, exec = defaultExec) {
  try {
    const output = exec(mountRoot);
    const uuid = /Volume UUID:\s+(\S+)/.exec(output)?.[1] ?? null;
    const label =
      /Volume Name:\s+(.+)/.exec(output)?.[1]?.trim() ?? basename(mountRoot);
    return { uuid, label };
  } catch {
    return { uuid: null, label: basename(mountRoot) };
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} mountRoot
 * @param {(mountRoot: string) => string} [exec]
 * @returns {number} the volume's id
 */
export function upsertVolume(db, mountRoot, exec = defaultExec) {
  const { uuid, label } = getVolumeInfo(mountRoot, exec);
  const now = Date.now();

  if (uuid) {
    db.prepare(
      `INSERT INTO volumes (label, uuid, last_mount_path, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         label = excluded.label,
         last_mount_path = excluded.last_mount_path,
         last_seen_at = excluded.last_seen_at`
    ).run(label, uuid, mountRoot, now);
    return db.prepare(`SELECT id FROM volumes WHERE uuid = ?`).get(uuid).id;
  }

  // No stable identifier available (non-macOS, or diskutil failed): key on
  // mount path instead, same degraded behavior as today's path-only check.
  const existing = db
    .prepare(`SELECT id FROM volumes WHERE last_mount_path = ? AND uuid IS NULL`)
    .get(mountRoot);
  if (existing) {
    db.prepare(`UPDATE volumes SET label = ?, last_seen_at = ? WHERE id = ?`).run(
      label,
      now,
      existing.id
    );
    return existing.id;
  }
  return db
    .prepare(
      `INSERT INTO volumes (label, uuid, last_mount_path, last_seen_at)
       VALUES (?, NULL, ?, ?)`
    )
    .run(label, mountRoot, now).lastInsertRowid;
}

/**
 * @param {{uuid: string|null, last_mount_path: string}} volumeRow
 * @param {(mountRoot: string) => string} [exec]
 * @returns {boolean}
 */
export function isVolumeMounted(volumeRow, exec = defaultExec) {
  if (!volumeRow.uuid) {
    try {
      exec(volumeRow.last_mount_path);
      return true;
    } catch {
      return false;
    }
  }
  const current = getVolumeInfo(volumeRow.last_mount_path, exec);
  return current.uuid === volumeRow.uuid;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/volumes.test.js`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add server/db/volumes.js server/db/volumes.test.js
git commit -m "feat: add diskutil-backed volume identity tracking"
```

---

## Task 3: Folder/photo upsert and lookup

**Files:**
- Create: `server/db/photos.js`
- Test: `server/db/photos.test.js`

**Interfaces:**
- Consumes: `getDb()` (Task 1).
- Produces: `upsertScan(db, folderAbsPath: string, volumeId: number, files: Array<{name: string, size: number, mtimeMs: number, kind: string}>): Array<{id: number, name: string, size: number, mtimeMs: number, rating: number, preferredCover: number}>`,
  `getPhotoById(db, id: number): {id, folder_id, filename, size, mtime, content_hash, taken_at, width, height, camera, kind, perceptual_hash, rating, preferred_cover, stale, folder_abs_path, path} | undefined`,
  `setPhotoRating(db, id: number, rating: number): void`,
  `setPhotoCover(db, id: number, isCover: boolean): void` — all consumed by
  Task 9 (`api.js` cutover) and Task 6 (`hashing.js`).

- [ ] **Step 1: Write the failing tests**

Create `server/db/photos.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import {
  upsertScan,
  getPhotoById,
  setPhotoRating,
  setPhotoCover,
} from "./photos.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

const FILES = [
  { name: "a.jpg", size: 100, mtimeMs: 1000, kind: "image" },
  { name: "b.jpg", size: 200, mtimeMs: 2000, kind: "image" },
];

describe("upsertScan", () => {
  it("inserts new photos sorted by filename", () => {
    const db = getDb();
    const rows = upsertScan(db, "/photos/trip", 1, FILES);
    expect(rows.map((r) => r.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(rows[0]).toMatchObject({
      name: "a.jpg",
      size: 100,
      mtimeMs: 1000,
      rating: 0,
      preferredCover: 0,
    });
    expect(Number.isInteger(rows[0].id)).toBe(true);
  });

  it("is idempotent: rescanning unchanged files keeps the same ids", () => {
    const db = getDb();
    const first = upsertScan(db, "/photos/trip", 1, FILES);
    const second = upsertScan(db, "/photos/trip", 1, FILES);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  it("preserves content_hash when a file is unchanged, clears it when changed", () => {
    const db = getDb();
    const [first] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    db.prepare("UPDATE photos SET content_hash = ? WHERE id = ?").run(
      "deadbeef",
      first.id
    );

    // Rescan unchanged: hash survives.
    upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    expect(getPhotoById(db, first.id).content_hash).toBe("deadbeef");

    // Rescan with a changed size: hash is cleared.
    upsertScan(db, "/photos/trip", 1, [{ ...FILES[0], size: 999 }]);
    expect(getPhotoById(db, first.id).content_hash).toBeNull();
  });

  it("marks a file no longer present as stale instead of deleting it", () => {
    const db = getDb();
    const rows = upsertScan(db, "/photos/trip", 1, FILES);
    const bId = rows.find((r) => r.name === "b.jpg").id;

    upsertScan(db, "/photos/trip", 1, [FILES[0]]); // b.jpg no longer scanned

    const stale = db.prepare("SELECT stale FROM photos WHERE id = ?").get(bId);
    expect(stale.stale).toBe(1);
    // Excluded from the non-stale result set:
    const rescan = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    expect(rescan.map((r) => r.name)).toEqual(["a.jpg"]);
  });

  it("reuses the same folder row across scans of the same path", () => {
    const db = getDb();
    upsertScan(db, "/photos/trip", 1, FILES);
    upsertScan(db, "/photos/trip", 1, FILES);
    const count = db.prepare("SELECT COUNT(*) AS c FROM folders").get().c;
    expect(count).toBe(1);
  });
});

describe("getPhotoById", () => {
  it("returns the row with a computed absolute path", () => {
    const db = getDb();
    const [row] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    const photo = getPhotoById(db, row.id);
    expect(photo.path).toBe(join("/photos/trip", "a.jpg"));
    expect(photo.filename).toBe("a.jpg");
  });

  it("returns undefined for an unknown id", () => {
    const db = getDb();
    expect(getPhotoById(db, 9999)).toBeUndefined();
  });
});

describe("setPhotoRating / setPhotoCover", () => {
  it("updates rating and preferred_cover on the photo row", () => {
    const db = getDb();
    const [row] = upsertScan(db, "/photos/trip", 1, [FILES[0]]);
    setPhotoRating(db, row.id, 4);
    setPhotoCover(db, row.id, true);
    const photo = getPhotoById(db, row.id);
    expect(photo.rating).toBe(4);
    expect(photo.preferred_cover).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/db/photos.test.js`
Expected: FAIL with "Cannot find module './photos.js'".

- [ ] **Step 3: Write the implementation**

Create `server/db/photos.js`:

```js
import { join } from "node:path";

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} folderAbsPath
 * @param {number} volumeId
 * @param {Array<{name: string, size: number, mtimeMs: number, kind: string}>} files
 * @returns {Array<{id: number, name: string, size: number, mtimeMs: number, rating: number, preferredCover: number}>}
 */
export function upsertScan(db, folderAbsPath, volumeId, files) {
  const now = Date.now();

  db.prepare(
    `INSERT INTO folders (abs_path, volume_id, last_scanned_at)
     VALUES (?, ?, ?)
     ON CONFLICT(abs_path) DO UPDATE SET
       volume_id = excluded.volume_id,
       last_scanned_at = excluded.last_scanned_at`
  ).run(folderAbsPath, volumeId, now);
  const folderId = db
    .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
    .get(folderAbsPath).id;

  const upsertPhoto = db.prepare(`
    INSERT INTO photos (folder_id, filename, size, mtime, kind, stale)
    VALUES (@folderId, @filename, @size, @mtime, @kind, 0)
    ON CONFLICT(folder_id, filename) DO UPDATE SET
      size = excluded.size,
      mtime = excluded.mtime,
      kind = excluded.kind,
      stale = 0,
      content_hash = CASE
        WHEN photos.size = excluded.size AND photos.mtime = excluded.mtime
        THEN photos.content_hash
        ELSE NULL
      END
  `);
  const markAllStale = db.prepare(`UPDATE photos SET stale = 1 WHERE folder_id = ?`);

  const tx = db.transaction((files) => {
    markAllStale.run(folderId);
    for (const f of files) {
      upsertPhoto.run({
        folderId,
        filename: f.name,
        size: f.size,
        mtime: f.mtimeMs,
        kind: f.kind,
      });
    }
  });
  tx(files);

  return db
    .prepare(
      `SELECT id, filename AS name, size, mtime AS mtimeMs, rating,
              preferred_cover AS preferredCover
       FROM photos WHERE folder_id = ? AND stale = 0 ORDER BY filename`
    )
    .all(folderId);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} id
 */
export function getPhotoById(db, id) {
  const row = db
    .prepare(
      `SELECT photos.*, folders.abs_path AS folder_abs_path
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.id = ?`
    )
    .get(id);
  if (!row) return undefined;
  return { ...row, path: join(row.folder_abs_path, row.filename) };
}

/** @param {import("better-sqlite3").Database} db @param {number} id @param {number} rating */
export function setPhotoRating(db, id, rating) {
  db.prepare(`UPDATE photos SET rating = ? WHERE id = ?`).run(rating, id);
}

/** @param {import("better-sqlite3").Database} db @param {number} id @param {boolean} isCover */
export function setPhotoCover(db, id, isCover) {
  db.prepare(`UPDATE photos SET preferred_cover = ? WHERE id = ?`).run(
    isCover ? 1 : 0,
    id
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/photos.test.js`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add server/db/photos.js server/db/photos.test.js
git commit -m "feat: add folder/photo upsert, lookup, and rating/cover setters"
```

---

## Task 4: Lazy content-hash background job

**Files:**
- Create: `server/db/hashing.js`
- Test: `server/db/hashing.test.js`

**Interfaces:**
- Consumes: `getDb()` (Task 1), `upsertScan`/`getPhotoById` (Task 3).
- Produces: `hashFile(path: string): Promise<string>`,
  `hashPendingPhotos(db, opts?: {limit?: number}): Promise<{hashed: number, remaining: boolean}>`
  — consumed by Task 9 (`api.js` cutover, fire-and-forget after scan).

- [ ] **Step 1: Write the failing tests**

Create `server/db/hashing.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan, getPhotoById } from "./photos.js";
import { hashFile, hashPendingPhotos } from "./hashing.js";

let cacheDir;
let photosDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  photosDir = await mkdtemp(join(tmpdir(), "ag-photos-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  await rm(photosDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("hashFile", () => {
  it("computes the SHA1 of the file's bytes", async () => {
    const path = join(photosDir, "a.txt");
    await writeFile(path, "hello world");
    const expected = createHash("sha1").update("hello world").digest("hex");
    expect(await hashFile(path)).toBe(expected);
  });
});

describe("hashPendingPhotos", () => {
  it("hashes every photo with a NULL content_hash", async () => {
    const db = getDb();
    await writeFile(join(photosDir, "a.jpg"), "content-a");
    await writeFile(join(photosDir, "b.jpg"), "content-b");
    const rows = upsertScan(db, photosDir, 1, [
      { name: "a.jpg", size: 9, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 9, mtimeMs: 1, kind: "image" },
    ]);

    const result = await hashPendingPhotos(db);
    expect(result.hashed).toBe(2);
    expect(result.remaining).toBe(false);

    const expectedA = createHash("sha1").update("content-a").digest("hex");
    expect(getPhotoById(db, rows[0].id).content_hash).toBe(expectedA);
  });

  it("respects the limit and reports remaining work", async () => {
    const db = getDb();
    await writeFile(join(photosDir, "a.jpg"), "content-a");
    await writeFile(join(photosDir, "b.jpg"), "content-b");
    upsertScan(db, photosDir, 1, [
      { name: "a.jpg", size: 9, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 9, mtimeMs: 1, kind: "image" },
    ]);

    const result = await hashPendingPhotos(db, { limit: 1 });
    expect(result.hashed).toBe(1);
    expect(result.remaining).toBe(true);
  });

  it("leaves content_hash NULL for an unreadable file instead of throwing", async () => {
    const db = getDb();
    const rows = upsertScan(db, photosDir, 1, [
      { name: "missing.jpg", size: 9, mtimeMs: 1, kind: "image" },
    ]);
    const result = await hashPendingPhotos(db);
    expect(result.hashed).toBe(0);
    expect(getPhotoById(db, rows[0].id).content_hash).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/db/hashing.test.js`
Expected: FAIL with "Cannot find module './hashing.js'".

- [ ] **Step 3: Write the implementation**

Create `server/db/hashing.js`:

```js
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

/** @param {string} path @returns {Promise<string>} */
export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Hash photos whose content_hash is still NULL. Never blocks a scan's grid
 * paint — callers invoke this after already responding to the request.
 * @param {import("better-sqlite3").Database} db
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{hashed: number, remaining: boolean}>}
 */
export async function hashPendingPhotos(db, { limit = 50 } = {}) {
  const rows = db
    .prepare(
      `SELECT photos.id, folders.abs_path AS folder_abs_path, photos.filename
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.content_hash IS NULL AND photos.stale = 0
       LIMIT ?`
    )
    .all(limit);

  const update = db.prepare(`UPDATE photos SET content_hash = ? WHERE id = ?`);
  let hashed = 0;
  for (const row of rows) {
    const path = join(row.folder_abs_path, row.filename);
    try {
      const hash = await hashFile(path);
      update.run(hash, row.id);
      hashed++;
    } catch {
      // Unreadable file: leave content_hash NULL. Hashing failure must
      // never block culling on an otherwise-usable photo.
    }
  }
  return { hashed, remaining: rows.length === limit };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/hashing.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/db/hashing.js server/db/hashing.test.js
git commit -m "feat: add lazy content-hash background job"
```

---

## Task 5: Backup-coverage queries

**Files:**
- Create: `server/db/backupCoverage.js`
- Test: `server/db/backupCoverage.test.js`

**Interfaces:**
- Consumes: `getDb()` (Task 1), `upsertScan` (Task 3).
- Produces: `getBackupCoverage(db, photoId: number): {volumeIds: number[]}`,
  `getUnbackedUpPhotos(db, volumeId: number): Array<{id, filename, folder_abs_path}>`
  — not yet consumed by any HTTP endpoint (deliberately: the spec scopes
  the feed/backup-coverage UI to a follow-up plan); this task's deliverable
  is the query layer, proven by its own tests.

- [ ] **Step 1: Write the failing tests**

Create `server/db/backupCoverage.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getBackupCoverage, getUnbackedUpPhotos } from "./backupCoverage.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function withHash(db, id, hash) {
  db.prepare("UPDATE photos SET content_hash = ? WHERE id = ?").run(hash, id);
}

describe("getBackupCoverage", () => {
  it("finds another volume holding the same content hash", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/drive1/trip", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [b] = upsertScan(db, "/drive2/backup/trip", 2, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    withHash(db, a.id, "sharedhash");
    withHash(db, b.id, "sharedhash");

    expect(getBackupCoverage(db, a.id).volumeIds.sort()).toEqual([1, 2]);
  });

  it("returns no other volumes when the hash is unique", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/drive1/trip", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    withHash(db, a.id, "onlyhere");
    expect(getBackupCoverage(db, a.id).volumeIds).toEqual([1]);
  });

  it("returns an empty list when the hash is not yet computed", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/drive1/trip", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    expect(getBackupCoverage(db, a.id).volumeIds).toEqual([]);
  });
});

describe("getUnbackedUpPhotos", () => {
  it("lists photos on a volume with no matching hash elsewhere", () => {
    const db = getDb();
    const [a] = upsertScan(db, "/drive1/trip", 1, [
      { name: "unique.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [b] = upsertScan(db, "/drive1/trip2", 1, [
      { name: "backed-up.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [c] = upsertScan(db, "/drive2/backup", 2, [
      { name: "backed-up-copy.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    withHash(db, a.id, "onlyondrive1");
    withHash(db, b.id, "sharedhash");
    withHash(db, c.id, "sharedhash");

    const result = getUnbackedUpPhotos(db, 1);
    expect(result.map((r) => r.filename)).toEqual(["unique.jpg"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/db/backupCoverage.test.js`
Expected: FAIL with "Cannot find module './backupCoverage.js'".

- [ ] **Step 3: Write the implementation**

Create `server/db/backupCoverage.js`:

```js
/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} photoId
 * @returns {{volumeIds: number[]}}
 */
export function getBackupCoverage(db, photoId) {
  const photo = db
    .prepare(`SELECT content_hash FROM photos WHERE id = ?`)
    .get(photoId);
  if (!photo || !photo.content_hash) return { volumeIds: [] };

  const rows = db
    .prepare(
      `SELECT DISTINCT folders.volume_id AS volumeId
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.content_hash = ? AND photos.stale = 0`
    )
    .all(photo.content_hash);
  return { volumeIds: rows.map((r) => r.volumeId).filter((v) => v != null) };
}

/**
 * Photos on `volumeId` whose content hash has no match on any other volume.
 * @param {import("better-sqlite3").Database} db
 * @param {number} volumeId
 * @returns {Array<{id: number, filename: string, folder_abs_path: string}>}
 */
export function getUnbackedUpPhotos(db, volumeId) {
  return db
    .prepare(
      `SELECT photos.id, photos.filename, folders.abs_path AS folder_abs_path
       FROM photos
       JOIN folders ON folders.id = photos.folder_id
       WHERE folders.volume_id = ? AND photos.stale = 0
         AND photos.content_hash IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM photos p2
           JOIN folders f2 ON f2.id = p2.folder_id
           WHERE p2.content_hash = photos.content_hash
             AND f2.volume_id != ?
             AND p2.stale = 0
         )`
    )
    .all(volumeId, volumeId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/backupCoverage.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/db/backupCoverage.js server/db/backupCoverage.test.js
git commit -m "feat: add exact-hash backup-coverage queries"
```

---

## Task 6: Legacy JSON migration

**Files:**
- Create: `server/migrateLegacyJson.js`
- Test: `server/migrateLegacyJson.test.js`

**Interfaces:**
- Consumes: `getDb()` (Task 1), `ratingsFile()`, `coverChoicesFile()`,
  `libraryFile()`, `cacheRoot()` (all from `server/lib/cachePaths.js`,
  already exist).
- Produces: `migrateLegacyJsonIfNeeded(db): {migrated: boolean}` —
  consumed by Task 8 (`server/index.js` startup wiring).

- [ ] **Step 1: Write the failing tests**

Create `server/migrateLegacyJson.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./db/connection.js";
import { migrateLegacyJsonIfNeeded } from "./migrateLegacyJson.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("migrateLegacyJsonIfNeeded", () => {
  it("imports ratings, cover choices, library folders, and metadata", async () => {
    const photoPath = "/photos/trip/a.jpg";
    await writeFile(
      join(cacheDir, "ratings.json"),
      JSON.stringify({ [photoPath]: 4 })
    );
    await writeFile(
      join(cacheDir, "coverChoices.json"),
      JSON.stringify({ [photoPath]: true })
    );
    await writeFile(
      join(cacheDir, "library.json"),
      JSON.stringify({ "/photos/trip": { name: "trip", lastScannedAt: 123 } })
    );
    await writeFile(
      join(cacheDir, "metacache.json"),
      JSON.stringify({
        [`${photoPath} 999`]: { w: 48, h: 32, t: "2020-01-01T00:00:00.000Z" },
      })
    );

    const result = migrateLegacyJsonIfNeeded(getDb());
    expect(result.migrated).toBe(true);

    const db = getDb();
    const row = db
      .prepare(
        `SELECT photos.rating, photos.preferred_cover, photos.width, photos.height, photos.taken_at
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
         WHERE folders.abs_path = ? AND photos.filename = ?`
      )
      .get("/photos/trip", "a.jpg");
    expect(row).toMatchObject({
      rating: 4,
      preferred_cover: 1,
      width: 48,
      height: 32,
    });
    expect(row.taken_at).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
  });

  it("is a no-op when photos already exist", async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO folders (abs_path, last_scanned_at) VALUES ('/x', 1)`
    ).run();
    db.prepare(
      `INSERT INTO photos (folder_id, filename, size, mtime, kind)
       VALUES (1, 'already-here.jpg', 1, 1, 'image')`
    ).run();

    await writeFile(
      join(cacheDir, "ratings.json"),
      JSON.stringify({ "/should/not/import.jpg": 5 })
    );

    const result = migrateLegacyJsonIfNeeded(db);
    expect(result.migrated).toBe(false);
    const imported = db
      .prepare(`SELECT COUNT(*) AS c FROM photos WHERE filename = ?`)
      .get("import.jpg");
    expect(imported.c).toBe(0);
  });

  it("does nothing (no throw) when no legacy JSON files exist", () => {
    const result = migrateLegacyJsonIfNeeded(getDb());
    expect(result.migrated).toBe(true);
    const count = getDb().prepare(`SELECT COUNT(*) AS c FROM photos`).get().c;
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/migrateLegacyJson.test.js`
Expected: FAIL with "Cannot find module './migrateLegacyJson.js'".

- [ ] **Step 3: Write the implementation**

Create `server/migrateLegacyJson.js`:

```js
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ratingsFile,
  coverChoicesFile,
  libraryFile,
  cacheRoot,
} from "./lib/cachePaths.js";

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * One-time import of the pre-index JSON stores into the SQLite schema.
 * Guarded so it only ever runs against a fresh (empty) `photos` table —
 * safe to call unconditionally on every startup.
 * @param {import("better-sqlite3").Database} db
 * @returns {{migrated: boolean}}
 */
export function migrateLegacyJsonIfNeeded(db) {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM photos`).get();
  if (count > 0) return { migrated: false };

  const ratings = readJsonIfExists(ratingsFile()) ?? {};
  const coverChoices = readJsonIfExists(coverChoicesFile()) ?? {};
  const library = readJsonIfExists(libraryFile()) ?? {};
  const metacache = readJsonIfExists(join(cacheRoot(), "metacache.json")) ?? {};

  const upsertFolder = db.prepare(
    `INSERT INTO folders (abs_path, last_scanned_at) VALUES (?, ?)
     ON CONFLICT(abs_path) DO UPDATE SET last_scanned_at = excluded.last_scanned_at`
  );
  for (const [absPath, entry] of Object.entries(library)) {
    upsertFolder.run(absPath, entry.lastScannedAt ?? Date.now());
  }

  const upsertPhotoStub = db.prepare(`
    INSERT INTO photos (folder_id, filename, size, mtime, kind, stale)
    VALUES (@folderId, @filename, 0, 0, 'image', 0)
    ON CONFLICT(folder_id, filename) DO NOTHING
  `);
  const folderIdByPath = new Map();

  function folderIdFor(folderPath) {
    if (folderIdByPath.has(folderPath)) return folderIdByPath.get(folderPath);
    upsertFolder.run(folderPath, Date.now());
    const id = db
      .prepare(`SELECT id FROM folders WHERE abs_path = ?`)
      .get(folderPath).id;
    folderIdByPath.set(folderPath, id);
    return id;
  }

  function photoIdFor(absPath) {
    const folderId = folderIdFor(dirname(absPath));
    const filename = basename(absPath);
    upsertPhotoStub.run({ folderId, filename });
    return db
      .prepare(`SELECT id FROM photos WHERE folder_id = ? AND filename = ?`)
      .get(folderId, filename).id;
  }

  const setRating = db.prepare(`UPDATE photos SET rating = ? WHERE id = ?`);
  for (const [absPath, rating] of Object.entries(ratings)) {
    setRating.run(rating, photoIdFor(absPath));
  }

  const setCover = db.prepare(
    `UPDATE photos SET preferred_cover = 1 WHERE id = ?`
  );
  for (const absPath of Object.keys(coverChoices)) {
    setCover.run(photoIdFor(absPath));
  }

  const setMeta = db.prepare(
    `UPDATE photos SET taken_at = ?, width = ?, height = ? WHERE id = ?`
  );
  for (const [key, entry] of Object.entries(metacache)) {
    // Key is "<absPath> <mtimeMs>" (see metaCache.js's keyFor) — mtimeMs is
    // always the last space-separated token, so dropping it back off is
    // unambiguous even when absPath itself contains spaces.
    const parts = key.split(" ");
    const absPath = parts.slice(0, -1).join(" ");
    if (!absPath) continue;
    const takenAtMs = entry.t ? Date.parse(entry.t) : null;
    setMeta.run(
      takenAtMs,
      entry.w ?? null,
      entry.h ?? null,
      photoIdFor(absPath)
    );
  }

  return { migrated: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/migrateLegacyJson.test.js`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add server/migrateLegacyJson.js server/migrateLegacyJson.test.js
git commit -m "feat: add one-time legacy JSON to SQLite migration"
```

---

## Task 7: Cut over `server/api.js` to the DB and retire the legacy JSON modules

This is the integration task: it must land as one unit since the API can't
be half on the old session model and half on the DB.

**Files:**
- Modify: `server/api.js` (full rewrite of the session-based lookups)
- Modify: `server/api.test.js` (rewrite the assertions that depended on
  0-based sequential ids and on the retired modules)
- Delete: `server/ratings.js`, `server/coverChoices.js`,
  `server/metaCache.js`, `server/library.js`

**Interfaces:**
- Consumes: `getDb()` (Task 1), `volumeRootForPath`/`upsertVolume`/
  `isVolumeMounted` (Task 2), `upsertScan`/`getPhotoById`/`setPhotoRating`/
  `setPhotoCover` (Task 3), `hashPendingPhotos` (Task 4).
- Produces: the same public HTTP contract as before for
  `POST /api/scan`, `GET /api/meta`, `GET /api/thumb/:id`,
  `GET /api/image/:id`, `POST /api/rating`, `POST /api/cover`,
  `GET /api/library` — except ids are now stable DB ids (not 0-based
  session-array indices), and `GET /api/ratings` is removed (its data is
  already returned inline by `/api/scan`'s `items[].rating`, and nothing
  in `ui/src/` calls it).

- [ ] **Step 1: Rewrite `server/api.js`**

Replace the full contents of `server/api.js` with:

```js
import { createHash } from "node:crypto";
import { existsSync, statSync, createReadStream } from "node:fs";
import { writeFile, rename, stat } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { NodeProcessingService } from "./processing/NodeProcessingService.js";
import { thumbsDir } from "./lib/cachePaths.js";
import { getDb } from "./db/connection.js";
import { volumeRootForPath, upsertVolume, isVolumeMounted } from "./db/volumes.js";
import {
  upsertScan,
  getPhotoById,
  setPhotoRating,
  setPhotoCover,
} from "./db/photos.js";
import { hashPendingPhotos } from "./db/hashing.js";

const processing = new NodeProcessingService();

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Register the API routes on an Express app.
 * @param {import("express").Express} app
 */
export function registerApi(app) {
  // --- Scan ---------------------------------------------------------------
  app.post("/api/scan", async (req, res) => {
    const dir = req.body?.dir;
    if (typeof dir !== "string" || dir.length === 0) {
      return res.status(400).json({ error: "dir is required" });
    }
    let st;
    try {
      st = statSync(dir);
    } catch {
      return res.status(404).json({ error: `not found: ${dir}` });
    }
    if (!st.isDirectory()) {
      return res.status(400).json({ error: `not a directory: ${dir}` });
    }

    const db = getDb();
    const volumeId = upsertVolume(db, volumeRootForPath(dir));

    const t0 = performance.now();
    const files = await processing.scan(dir);
    const rows = upsertScan(db, dir, volumeId, files);
    const elapsedMs = Math.round(performance.now() - t0);

    // Never blocks the response — see server/db/hashing.js.
    hashPendingPhotos(db).catch(() => {});

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      size: r.size,
      mtimeMs: r.mtimeMs,
      rating: r.rating,
      preferredCover: r.preferredCover === 1,
    }));
    res.json({ root: dir, count: items.length, elapsedMs, items });
  });

  // --- Lazy metadata enrichment --------------------------------------------
  // GET /api/meta?ids=1,2,3 -> [{ id, takenAt, width, height }].
  // width is used as the "already attempted extraction" marker (sharp
  // successfully reads dimensions for any valid image, so a NULL width
  // reliably means "never tried", regardless of whether taken_at ended up
  // null for lack of EXIF).
  app.get("/api/meta", async (req, res) => {
    const db = getDb();
    const idsParam = String(req.query.ids ?? "");
    const ids = idsParam
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n));

    const photosById = new Map();
    const need = [];
    for (const id of ids) {
      const photo = getPhotoById(db, id);
      if (!photo) continue;
      photosById.set(id, photo);
      if (photo.width === null) need.push(photo);
    }

    if (need.length) {
      const metas = await processing.metadata(need.map((p) => p.path));
      const update = db.prepare(
        `UPDATE photos SET taken_at = ?, width = ?, height = ? WHERE id = ?`
      );
      metas.forEach((m, i) => {
        const photo = need[i];
        const takenAtMs = m.createDate ? new Date(m.createDate).getTime() : null;
        update.run(takenAtMs, m.width ?? null, m.height ?? null, photo.id);
        photosById.set(photo.id, {
          ...photo,
          taken_at: takenAtMs,
          width: m.width ?? null,
          height: m.height ?? null,
        });
      });
    }

    const out = ids
      .map((id) => photosById.get(id))
      .filter(Boolean)
      .map((p) => ({
        id: p.id,
        takenAt: p.taken_at ? new Date(p.taken_at).toISOString() : null,
        width: p.width ?? null,
        height: p.height ?? null,
      }));
    res.json(out);
  });

  // --- Thumbnail ----------------------------------------------------------
  app.get("/api/thumb/:id", async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).end();
    const size = Math.min(1024, Math.max(64, Number(req.query.size) || 320));

    const key = createHash("sha1")
      .update(`${it.path}:${it.mtime}:${it.size}:${size}`)
      .digest("hex");
    const cachePath = join(thumbsDir(), `${key}.jpg`);

    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("image/jpeg");

    if (existsSync(cachePath)) {
      res.set("X-Cache", "hit");
      return createReadStream(cachePath).pipe(res);
    }

    try {
      const { data } = await processing.thumbnail(it.path, size);
      const tmp = `${cachePath}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, cachePath);
      res.set("X-Cache", "miss");
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: `thumbnail failed: ${err.message}` });
    }
  });

  // --- Full image (loupe) -------------------------------------------------
  app.get("/api/image/:id", async (req, res) => {
    const db = getDb();
    const it = getPhotoById(db, Number(req.params.id));
    if (!it) return res.status(404).end();
    let st;
    try {
      st = await stat(it.path);
    } catch {
      return res.status(404).end();
    }
    res.set("Cache-Control", "public, max-age=3600");
    res.type(
      MIME_BY_EXT[extname(it.path).toLowerCase()] || "application/octet-stream"
    );
    res.set("Content-Length", String(st.size));
    createReadStream(it.path).pipe(res);
  });

  // --- Ratings / cover choices ----------------------------------------------
  app.post("/api/rating", (req, res) => {
    const { id, rating } = req.body ?? {};
    const db = getDb();
    const it = getPhotoById(db, Number(id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      return res.status(400).json({ error: "rating must be an integer 0-5" });
    }
    setPhotoRating(db, it.id, rating);
    res.json({ id: it.id, rating });
  });

  app.post("/api/cover", (req, res) => {
    const { id, isCover } = req.body ?? {};
    const db = getDb();
    const it = getPhotoById(db, Number(id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (typeof isCover !== "boolean") {
      return res.status(400).json({ error: "isCover must be a boolean" });
    }
    setPhotoCover(db, it.id, isCover);
    res.json({ id: it.id, preferredCover: isCover });
  });

  // --- Library (previously-scanned folders) --------------------------------
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
    const entries = rows.map((r) => ({
      path: r.path,
      name: basename(r.path),
      lastScannedAt: r.lastScannedAt,
      mounted: r.volumeUuid
        ? isVolumeMounted({ uuid: r.volumeUuid, last_mount_path: r.volumeMountPath })
        : existsSync(r.path),
    }));
    res.json(entries);
  });
}
```

- [ ] **Step 2: Delete the retired legacy modules**

```bash
rm server/ratings.js server/coverChoices.js server/metaCache.js server/library.js
```

- [ ] **Step 3: Rewrite `server/api.test.js`**

Replace the full contents of `server/api.test.js` with:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import sharp from "sharp";
import { createApp } from "./index.js";
import { getDb, _resetDbForTest } from "./db/connection.js";

/** Start the app on an ephemeral port; return { base, close }. */
async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function scan(base, dir) {
  const res = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  return res.json();
}

let photosDir;
let cacheDir;
let srv;

beforeAll(async () => {
  photosDir = await mkdtemp(join(tmpdir(), "ag-photos-"));
  cacheDir = await mkdtemp(join(tmpdir(), "ag-cache-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();

  // Three tiny distinct JPEGs + a non-image that must be ignored.
  const colors = [
    { r: 200, g: 30, b: 30 },
    { r: 30, g: 200, b: 30 },
    { r: 30, g: 30, b: 200 },
  ];
  for (let i = 0; i < colors.length; i++) {
    await sharp({
      create: { width: 48, height: 32, channels: 3, background: colors[i] },
    })
      .jpeg()
      .toFile(join(photosDir, `img_${i}.jpg`));
  }
  await mkdir(join(photosDir, "subdir")); // must be skipped (non-recursive)
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toFile(join(photosDir, "note.txt.png")); // a 4th image (png)

  srv = await startServer();
});

afterAll(async () => {
  await srv?.close();
  await rm(photosDir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("POST /api/scan", () => {
  it("returns sorted image items with stable ids and ignores dirs", async () => {
    const body = await scan(srv.base, photosDir);
    expect(body.count).toBe(4); // 3 jpg + 1 png, subdir excluded
    const names = body.items.map((i) => i.name);
    expect(names).toEqual([...names].sort()); // sorted by name
    expect(body.items.every((i) => Number.isInteger(i.id))).toBe(true);
    expect(body.items[0]).toHaveProperty("size");
    expect(body.items[0]).toHaveProperty("mtimeMs");
    expect(typeof body.elapsedMs).toBe("number");
  });

  it("returns the same ids across a rescan of the same folder", async () => {
    const first = await scan(srv.base, photosDir);
    const second = await scan(srv.base, photosDir);
    expect(second.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
  });

  it("404s a missing dir and 400s a file/empty dir", async () => {
    const missing = await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: join(photosDir, "nope") }),
    });
    expect(missing.status).toBe(404);
    const empty = await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "" }),
    });
    expect(empty.status).toBe(400);
  });
});

describe("GET /api/meta", () => {
  it("returns dimensions and takenAt for the requested ids", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const ids = scanBody.items.slice(0, 2).map((i) => i.id);
    const res = await fetch(`${srv.base}/api/meta?ids=${ids.join(",")}`);
    expect(res.status).toBe(200);
    const metas = await res.json();
    expect(metas).toHaveLength(2);
    // Fixture JPEGs are 48x32.
    expect(metas[0]).toMatchObject({ id: ids[0], width: 48, height: 32 });
    expect(metas[0]).toHaveProperty("takenAt"); // null: fixtures carry no EXIF
  });

  it("persists extracted metadata and reuses it on a later request", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    await fetch(`${srv.base}/api/meta?ids=${id}`);

    const db = getDb();
    const row = db.prepare("SELECT width, height FROM photos WHERE id = ?").get(id);
    expect(row).toMatchObject({ width: 48, height: 32 });

    const again = await (await fetch(`${srv.base}/api/meta?ids=${id}`)).json();
    expect(again[0]).toMatchObject({ id, width: 48, height: 32 });
  });
});

describe("GET /api/thumb/:id", () => {
  it("generates a JPEG, then serves from cache on the second request", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;

    const first = await fetch(`${srv.base}/api/thumb/${id}?size=64`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("image/jpeg");
    expect(first.headers.get("x-cache")).toBe("miss");
    const bytes = Buffer.from(await first.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0xff); // JPEG magic number
    expect(bytes[1]).toBe(0xd8);

    const cached = await readdir(join(cacheDir, "cache", "thumbs"));
    expect(cached.some((f) => f.endsWith(".jpg"))).toBe(true);

    const second = await fetch(`${srv.base}/api/thumb/${id}?size=64`);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("hit");
  });

  it("404s an unknown id", async () => {
    const res = await fetch(`${srv.base}/api/thumb/999999?size=64`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/image/:id", () => {
  it("streams the original bytes", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    const res = await fetch(`${srv.base}/api/image/${id}`);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("rating round-trip", () => {
  it("persists a rating on the photo row across a rescan", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;

    const set = await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, rating: 4 }),
    });
    expect(set.status).toBe(200);

    const rescan = await scan(srv.base, photosDir);
    expect(rescan.items.find((i) => i.id === id).rating).toBe(4);

    await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, rating: 0 }),
    });
    const after = await scan(srv.base, photosDir);
    expect(after.items.find((i) => i.id === id).rating).toBe(0);
  });

  it("rejects an out-of-range rating", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    const res = await fetch(`${srv.base}/api/rating`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, rating: 9 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("manual cover choice round-trip", () => {
  it("persists a manual cover choice across a rescan", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[1].id;

    const set = await fetch(`${srv.base}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, isCover: true }),
    });
    expect(set.status).toBe(200);

    const rescan = await scan(srv.base, photosDir);
    expect(rescan.items.find((i) => i.id === id).preferredCover).toBe(true);

    await fetch(`${srv.base}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, isCover: false }),
    });
    const after = await scan(srv.base, photosDir);
    expect(after.items.find((i) => i.id === id).preferredCover).toBe(false);
  });

  it("rejects a non-boolean isCover", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const id = scanBody.items[0].id;
    const res = await fetch(`${srv.base}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, isCover: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/library", () => {
  it("records the scanned folder and reports it as mounted", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/library`);
    expect(res.status).toBe(200);
    const entries = await res.json();
    const entry = entries.find((e) => e.path === photosDir);
    expect(entry).toBeDefined();
    expect(entry.mounted).toBe(true);
    expect(entry.name).toBe(basename(photosDir));
  });

  it("reports a since-removed folder as not mounted", async () => {
    const goneDir = join(photosDir, "does-not-exist-anymore");
    getDb()
      .prepare(
        `INSERT INTO folders (abs_path, last_scanned_at) VALUES (?, ?)
         ON CONFLICT(abs_path) DO NOTHING`
      )
      .run(goneDir, Date.now());
    const res = await fetch(`${srv.base}/api/library`);
    const entries = await res.json();
    const entry = entries.find((e) => e.path === goneDir);
    expect(entry).toBeDefined();
    expect(entry.mounted).toBe(false);
  });
});
```

Note the `beforeAll` no longer resets between individual `it` blocks (matching
the original file's structure — one shared server/DB per file, tests build on
each other's scans within the same photosDir, exactly as before).

- [ ] **Step 4: Run the full server test suite**

Run: `npx vitest run server/`
Expected: All tests pass (this includes every task's tests plus the
rewritten `api.test.js` and the untouched `ProcessingService.test.js` /
`safeResolve.test.js`).

- [ ] **Step 5: Commit**

```bash
git add server/api.js server/api.test.js
git rm server/ratings.js server/coverChoices.js server/metaCache.js server/library.js
git commit -m "feat: cut over api.js to the SQLite index, retire legacy JSON stores"
```

---

## Task 8: Wire migration into server startup

**Files:**
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `getDb()` (Task 1), `migrateLegacyJsonIfNeeded` (Task 6).

- [ ] **Step 1: Call the migration once at app creation**

In `server/index.js`, add the import and the call inside `createApp()`,
right before `registerApi(app)`:

```js
import { getDb } from "./db/connection.js";
import { migrateLegacyJsonIfNeeded } from "./migrateLegacyJson.js";
```

```js
export function createApp() {
  const app = express();
  app.use(express.json());

  migrateLegacyJsonIfNeeded(getDb());

  // Health check — proves the dev loop end to end.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version });
  });

  // Persistent multi-drive index API: scan, thumbnails, full images, ratings.
  registerApi(app);
  ...
```

- [ ] **Step 2: Run the full server test suite again**

Run: `npx vitest run server/`
Expected: All tests still pass — `createApp()` now runs the migration
guard on every test server start, which is a no-op once `photos` is
non-empty (proven by Task 6's tests) and a no-op when no legacy JSON files
exist in the test's ephemeral `AUTOGALLERY_HOME` (also proven there).

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: run the legacy-JSON migration once at server startup"
```

---

## Task 9: Manual validation against real data

This task is manual verification, not new code — it exists to catch
anything the synthetic tests can't (real EXIF variety, real directory
sizes, real diskutil behavior on the actual dev machine).

**Files:** none (read-only verification).

- [ ] **Step 1: Run the dev server**

Run: `npm run dev`
Expected: Express on `:4321`, Vite UI on `:5173`, no errors on boot (watch
for the migration-guard log/absence of thrown errors).

- [ ] **Step 2: Scan the real multi-year archive**

In the running UI (or via `curl`), scan
`/Users/aguerra/Pictures/fotos_peq` (per
`docs/TEST_FOLDERS.local.md` — READ-ONLY, do not write into it). Note the
reported `elapsedMs` for the initial scan.

- [ ] **Step 3: Confirm the hash job catches up**

A few seconds after the scan, check that `content_hash` is being
populated:

```bash
sqlite3 ~/.autogallery/index.db "SELECT COUNT(*) AS total, COUNT(content_hash) AS hashed FROM photos;"
```

Expected: `hashed` climbing toward `total` over subsequent requests
(each `/api/scan` call triggers another batch — see `hashPendingPhotos`'s
`limit`).

- [ ] **Step 4: Spot-check backup coverage**

Scan one of the SD-card test folders from `docs/TEST_FOLDERS.local.md`
(e.g. `/Volumes/EOS_DIG_256/DCIM/101CANON`, if mounted), then run:

```bash
node -e "
import('./server/db/connection.js').then(async ({ getDb }) => {
  const { getUnbackedUpPhotos } = await import('./server/db/backupCoverage.js');
  const db = getDb();
  const volumes = db.prepare('SELECT * FROM volumes').all();
  console.log(volumes);
});
"
```

Report which volume ids exist and, for one of them, call
`getUnbackedUpPhotos(db, volumeId)` to confirm it returns a sensible
(possibly empty) list.

- [ ] **Step 5: Report results**

Summarize: scan time for the ~111K-file archive, hash-job throughput
(files/sec, extrapolated full-archive completion time), and whether the
backup-coverage spot-check returned expected results. No commit for this
task — it's a verification report back to John.

---

## Plan self-review notes

- **Spec coverage:** schema (Task 1), volume identity via diskutil UUID
  (Task 2), folder/photo upsert with stale-marking and content-hash
  preservation (Task 3), lazy background hashing (Task 4), backup-coverage
  queries (Task 5), legacy JSON migration incl. the rating/cover-choice
  columns added when the spec gap was found (Task 6), full API cutover
  (Task 7), startup wiring (Task 8), real-data validation (Task 9). All
  "Out of scope" items from the spec (perceptual hashing, feed UI, tag
  population, Windows/Linux volume identity) are correctly absent here.
- **Type consistency:** `getPhotoById` returns raw DB column names
  (`content_hash`, `preferred_cover`, `folder_abs_path`, `path`) — Tasks
  4-7 consistently use these exact names rather than the camelCase
  `upsertScan`/API-response shape, which is deliberately different (that
  shape is the external HTTP contract, not the DB row shape).
- **No placeholders**: every step above has complete, runnable code — no
  TBD/TODO markers.
