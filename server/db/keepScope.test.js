import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { setKeepScope, keepScopeIds } from "./keepScope.js";
import { upsertScan } from "./photos.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-scope-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function scopeIds(db) {
  return db
    .prepare(`SELECT photo_id FROM keep_scope ORDER BY photo_id`)
    .all()
    .map((r) => r.photo_id);
}

describe("setKeepScope", () => {
  it("stores the id set and returns its count", () => {
    const db = getDb();
    expect(setKeepScope(db, [3, 1, 2])).toBe(3);
    expect(scopeIds(db)).toEqual([1, 2, 3]);
  });

  it("replaces the previous scope atomically (not appends)", () => {
    const db = getDb();
    setKeepScope(db, [1, 2, 3]);
    expect(setKeepScope(db, [9])).toBe(1);
    expect(scopeIds(db)).toEqual([9]);
  });

  it("clears the scope on an empty array", () => {
    const db = getDb();
    setKeepScope(db, [1, 2]);
    expect(setKeepScope(db, [])).toBe(0);
    expect(scopeIds(db)).toEqual([]);
  });

  it("handles a large scope well past the old 5000 cap", () => {
    const db = getDb();
    const big = Array.from({ length: 12000 }, (_, i) => i + 1);
    expect(setKeepScope(db, big)).toBe(12000);
  });

  it("ignores non-integer ids", () => {
    const db = getDb();
    expect(setKeepScope(db, [1, "x", 2.5, 3])).toBe(2);
    expect(scopeIds(db)).toEqual([1, 3]);
  });
});

describe("keepScopeIds — reading the working set back (#212)", () => {
  /** `n` photos in one folder. @returns {number[]} their ids */
  function seedPhotos(db, n) {
    db.prepare(
      `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
       VALUES (1, 'v', 'uuid-1', '/test', ?)`
    ).run(Date.now());
    const files = Array.from({ length: n }, (_, i) => ({
      name: `IMG_${i}.jpg`,
      size: 100 + i,
      mtimeMs: 1700000000000 + i,
      kind: "image",
    }));
    return upsertScan(db, "/vol/a", 1, files).map((r) => r.id);
  }

  it("is empty when no scope is in force", () => {
    expect(keepScopeIds(getDb())).toEqual([]);
  });

  it("round-trips what setKeepScope stored", () => {
    const db = getDb();
    const ids = seedPhotos(db, 4);
    setKeepScope(db, [ids[2], ids[0]]);
    expect(keepScopeIds(db)).toEqual([ids[0], ids[2]].sort((a, b) => a - b));
  });

  it("drops rows whose photo is GONE, so the chip's count is honest", () => {
    // keep_scope has no foreign key (schema.js: `photo_id INTEGER PRIMARY KEY`,
    // no REFERENCES), so removing a folder leaves its ids behind. The FEED is
    // unaffected — buildFilter phrases it `photos.id IN (SELECT …)`, which
    // ignores the dead rows — but a restore that trusted the table would put
    // "4 photos" on the scope chip above a grid showing 2.
    const db = getDb();
    const ids = seedPhotos(db, 4);
    setKeepScope(db, ids);

    db.prepare(`DELETE FROM photos WHERE id IN (?, ?)`).run(ids[1], ids[3]);
    expect(keepScopeIds(db)).toEqual([ids[0], ids[2]]);
  });

  it("comes back empty after the scope is cleared", () => {
    const db = getDb();
    const ids = seedPhotos(db, 3);
    setKeepScope(db, ids);
    setKeepScope(db, []);
    expect(keepScopeIds(db)).toEqual([]);
  });
});
