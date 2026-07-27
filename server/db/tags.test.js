import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { buildFilter } from "./filters.js";
import {
  saveTag,
  listTags,
  deleteTag,
  taggedAmong,
  DIMENSION,
} from "./tags.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-tags-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  getDb()
    .prepare(
      `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
       VALUES (1, 'test-volume', 'test-uuid-1', '/test', ?)`
    )
    .run(Date.now());
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function seed(db, n) {
  const files = Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}.jpg`,
    size: 1000 + i,
    mtimeMs: 1700000000000 + i,
    kind: "image",
  }));
  return upsertScan(db, "/vol/Trip", 1, files).map((r) => r.id);
}

describe("saved semantic tags (#164)", () => {
  it("saves a phrase with its photos and reports them back", () => {
    const db = getDb();
    const ids = seed(db, 5);
    const r = saveTag(db, "sunset", [ids[0], ids[1], ids[2]]);

    expect(r.photos).toBe(3);
    expect(listTags(db)).toEqual([{ id: r.tagId, value: "sunset", photos: 3 }]);
  });

  it("REPLACES membership on re-save rather than unioning", () => {
    // Narrowing a cut from 3 photos to 1 and saving again is a correction. A
    // union would make that correction impossible to express.
    const db = getDb();
    const ids = seed(db, 5);
    saveTag(db, "sunset", [ids[0], ids[1], ids[2]]);
    const r = saveTag(db, "sunset", [ids[0]]);

    expect(r.photos).toBe(1);
    expect([...taggedAmong(db, "sunset", ids)]).toEqual([ids[0]]);
  });

  it("keeps a hand-made membership when the model's opinion changes", () => {
    // This is the entire reason photo_tags.source exists: a re-save is the
    // model changing its mind, and it has no business discarding a decision a
    // person made.
    const db = getDb();
    const ids = seed(db, 5);
    saveTag(db, "sunset", [ids[0]]);
    const tagId = listTags(db)[0].id;
    db.prepare(
      `INSERT INTO photo_tags (photo_id, tag_id, source) VALUES (?, ?, 'manual')`
    ).run(ids[4], tagId);

    const r = saveTag(db, "sunset", [ids[1]]);

    expect(r.keptManual).toBe(1);
    const members = taggedAmong(db, "sunset", ids);
    expect(members.has(ids[4])).toBe(true); // the manual one survived
    expect(members.has(ids[1])).toBe(true); // the new model one is in
    expect(members.has(ids[0])).toBe(false); // the old model one is gone
  });

  it("trims the name and refuses an empty one", () => {
    const db = getDb();
    const ids = seed(db, 2);
    saveTag(db, "  sunset  ", [ids[0]]);
    expect(listTags(db)[0].value).toBe("sunset");
    expect(() => saveTag(db, "   ", [ids[0]])).toThrow(/needs a name/);
  });

  it("deletes a tag and its memberships", () => {
    const db = getDb();
    const ids = seed(db, 3);
    saveTag(db, "sunset", ids);

    expect(deleteTag(db, "sunset")).toEqual({ removed: 1 });
    expect(listTags(db)).toEqual([]);
    expect(taggedAmong(db, "sunset", ids).size).toBe(0);
    expect(deleteTag(db, "sunset")).toEqual({ removed: 0 });
  });

  it("stores under the dimension the filter facet reads", () => {
    // The storage key and the facet's WHERE clause are written in two files
    // and drift silently: the tag saves fine, the filter matches nothing.
    const db = getDb();
    const ids = seed(db, 2);
    saveTag(db, "sunset", [ids[0]]);

    const stored = db
      .prepare(`SELECT dimension_name FROM tags WHERE value = 'sunset'`)
      .get();
    expect(stored.dimension_name).toBe(DIMENSION);

    const { sql, params } = buildFilter({ tag: "sunset" });
    const matched = db
      .prepare(`SELECT photos.id FROM photos WHERE ${sql}`)
      .all(...params)
      .map((r) => r.id);
    expect(matched).toEqual([ids[0]]);
  });
});
