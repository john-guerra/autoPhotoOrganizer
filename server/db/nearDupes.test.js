import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import {
  replaceNearDupeGroups,
  nearDupeCounts,
  nearDupeCountsForIds,
} from "./nearDupes.js";

const SIGLIP = "Xenova/siglip-base-patch16-224";
const CLIP = "Xenova/clip-vit-base-patch32";
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-neardupe-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  const db = getDb();
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'test-volume', 'test-uuid-1', '/test', ?)`
  ).run(Date.now());
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

/** `n` photos in one folder; returns their ids in filename order. */
function seed(db, n) {
  const files = Array.from({ length: n }, (_, i) => ({
    name: `IMG_${String(i).padStart(5, "0")}.jpg`,
    size: 1000 + i,
    mtimeMs: 1700000000000 + i,
    kind: "image",
  }));
  return upsertScan(db, "/vol/Trip", 1, files).map((r) => r.id);
}

describe("nearDupeCountsForIds (#211)", () => {
  it("counts only the groups the given photos touch", () => {
    const db = getDb();
    const ids = seed(db, 6);
    // Two groups of two, and two ungrouped photos.
    replaceNearDupeGroups(db, SIGLIP, [
      { photoId: ids[0], groupId: 1 },
      { photoId: ids[1], groupId: 1 },
      { photoId: ids[2], groupId: 2 },
      { photoId: ids[3], groupId: 2 },
    ]);

    // Selecting one whole group plus an ungrouped photo sees ONE group.
    const got = nearDupeCountsForIds(db, SIGLIP, [ids[0], ids[1], ids[4]]);
    expect(got).toEqual({ photos: 2, groups: 1, spillGroups: 0 });

    // The library still reports both — the sweep was never scoped.
    expect(nearDupeCounts(db, SIGLIP)).toMatchObject({ groups: 2, photos: 4 });
  });

  it("flags a group that reaches beyond the selection", () => {
    const db = getDb();
    const ids = seed(db, 4);
    replaceNearDupeGroups(db, SIGLIP, [
      { photoId: ids[0], groupId: 1 },
      { photoId: ids[1], groupId: 1 },
      { photoId: ids[2], groupId: 1 },
    ]);

    // Two of the group's three members selected: the group is touched, but
    // reporting it as "in your selection" without qualification would claim a
    // photo the user did not select.
    const got = nearDupeCountsForIds(db, SIGLIP, [ids[0], ids[1]]);
    expect(got).toEqual({ photos: 2, groups: 1, spillGroups: 1 });

    // All three selected: nothing spills.
    expect(nearDupeCountsForIds(db, SIGLIP, [ids[0], ids[1], ids[2]])).toEqual({
      photos: 3,
      groups: 1,
      spillGroups: 0,
    });
  });

  it("handles a selection larger than one SQL parameter chunk", () => {
    const db = getDb();
    // Over the 900-id chunk size, and deliberately not a multiple of it, so a
    // truncated final chunk would show up as a wrong count rather than pass.
    const ids = seed(db, 2050);
    const rows = ids.map((photoId, i) => ({
      photoId,
      // 1025 groups of two: every photo is in a group, so a dropped chunk
      // undercounts visibly.
      groupId: Math.floor(i / 2) + 1,
    }));
    replaceNearDupeGroups(db, SIGLIP, rows);

    const got = nearDupeCountsForIds(db, SIGLIP, ids);
    expect(got).toEqual({ photos: 2050, groups: 1025, spillGroups: 0 });
  });

  it("survives a selection past SQLite's parameter ceiling", () => {
    const db = getDb();
    const ids = seed(db, 4);
    replaceNearDupeGroups(db, SIGLIP, [
      { photoId: ids[0], groupId: 1 },
      { photoId: ids[1], groupId: 1 },
    ]);

    // Measured on this build: a statement takes 32,766 parameters and throws
    // "too many SQL variables" at 32,767. Select-all on the library this was
    // built against is 34,812 photos, so an unchunked query does not degrade
    // here — it throws, and the user's select-all gets an error instead of an
    // answer. The padding ids need not exist: the failure is in PREPARING the
    // statement, before any row is read.
    const huge = [
      ...ids,
      ...Array.from({ length: 40_000 }, (_, i) => 900_000 + i),
    ];

    expect(() => nearDupeCountsForIds(db, SIGLIP, huge)).not.toThrow();
    expect(nearDupeCountsForIds(db, SIGLIP, huge)).toEqual({
      photos: 2,
      groups: 1,
      spillGroups: 0,
    });
  });

  it("does not count another model's grouping", () => {
    const db = getDb();
    const ids = seed(db, 2);
    replaceNearDupeGroups(db, CLIP, [
      { photoId: ids[0], groupId: 1 },
      { photoId: ids[1], groupId: 1 },
    ]);

    expect(nearDupeCountsForIds(db, SIGLIP, ids)).toEqual({
      photos: 0,
      groups: 0,
      spillGroups: 0,
    });
    expect(nearDupeCountsForIds(db, CLIP, ids)).toEqual({
      photos: 2,
      groups: 1,
      spillGroups: 0,
    });
  });

  it("answers zero for an empty selection without touching the db", () => {
    const db = getDb();
    expect(nearDupeCountsForIds(db, SIGLIP, [])).toEqual({
      photos: 0,
      groups: 0,
      spillGroups: 0,
    });
  });
});
