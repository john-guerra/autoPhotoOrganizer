import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("preserves lastScannedAt from library.json even when folder is referenced by ratings", async () => {
    const photoPath = "/photos/trip/b.jpg";
    const libraryTimestamp = 1234567890;
    await writeFile(
      join(cacheDir, "library.json"),
      JSON.stringify({ "/photos/trip": { name: "trip", lastScannedAt: libraryTimestamp } })
    );
    await writeFile(
      join(cacheDir, "ratings.json"),
      JSON.stringify({ [photoPath]: 3 })
    );

    const result = migrateLegacyJsonIfNeeded(getDb());
    expect(result.migrated).toBe(true);

    const db = getDb();
    const folder = db
      .prepare(`SELECT last_scanned_at FROM folders WHERE abs_path = ?`)
      .get("/photos/trip");
    expect(folder.last_scanned_at).toBe(libraryTimestamp);
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
