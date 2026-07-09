import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { setKeepScope } from "./keepScope.js";

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
