import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import {
  putFaces,
  ungroupedFaceCount,
  ungroupedFaceRows,
} from "../db/faces.js";
import { quantize } from "./quantize.js";
import {
  groupRemaining,
  clusterLeftovers,
  personCentroidVectors,
  bestPerson,
} from "./faceGrouping.js";

const MODEL = "buffalo_s";
const DIM = 32;
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-grouping-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  getDb()
    .prepare(
      `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
       VALUES (1, 'v', 'uuid-1', '/test', ?)`
    )
    .run(Date.now());
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

/** A unit vector pointing mostly along `axis`, nudged by `jitter`. */
function vec(axis, jitter = 0) {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  if (jitter) v[(axis + 1) % DIM] = jitter;
  return v;
}

/**
 * `n` faces along `axis`, each on its own photo in `folder`.
 * @returns {number[]} the photo ids
 */
function seedFaces(db, folder, axis, n, { jitter = 0.02 } = {}) {
  const files = Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}.jpg`,
    size: 100 + i,
    mtimeMs: 1700000000000 + i,
    kind: "image",
  }));
  const photos = upsertScan(db, folder, 1, files).map((r) => r.id);
  photos.forEach((pid, i) => {
    const { scale, bytes } = quantize(vec(axis, jitter * i));
    putFaces(db, {
      photoId: pid,
      model: MODEL,
      faces: [{ box: [0, 0, 10, 10], score: 0.9, dim: DIM, scale, bytes }],
    });
  });
  return photos;
}

const grouped = (db) =>
  db
    .prepare(`SELECT COUNT(*) n FROM photo_faces WHERE person_id IS NOT NULL`)
    .get().n;
const personCount = (db) =>
  db.prepare(`SELECT COUNT(*) n FROM persons`).get().n;

describe("the grouping worklist (#235)", () => {
  it("counts only what still NEEDS a person", () => {
    // The job's total. A scope includes faces already grouped, so counting the
    // scope would make the bar finish early and stop (#208's other half).
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 6);
    expect(ungroupedFaceCount(db, MODEL, null)).toBe(6);

    db.prepare(`INSERT INTO persons (id, name) VALUES (1, NULL)`).run();
    db.prepare(
      `UPDATE photo_faces SET person_id = 1 WHERE id IN (
         SELECT id FROM photo_faces LIMIT 2)`
    ).run();
    expect(ungroupedFaceCount(db, MODEL, null)).toBe(4);
  });

  it("restricts to a photo scope, and treats EMPTY as nothing", () => {
    // The distinction #206 keeps all the way into the SQL: `null` is the whole
    // library, `[]` is these zero photos. Collapsing them turns an empty
    // selection into a full-library pass.
    const db = getDb();
    const a = seedFaces(db, "/vol/a", 0, 4);
    seedFaces(db, "/vol/b", 5, 4);

    expect(ungroupedFaceCount(db, MODEL, null)).toBe(8);
    expect(ungroupedFaceCount(db, MODEL, a)).toBe(4);
    expect(ungroupedFaceCount(db, MODEL, [])).toBe(0);
    expect(ungroupedFaceRows(db, MODEL, { scopeIds: [] })).toEqual([]);
  });

  it("leaves a manually-detached face alone", () => {
    // person_source='manual' with no person is the user saying "not this
    // person". Re-filing it would undo their correction on the next run.
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 3);
    db.prepare(
      `UPDATE photo_faces SET person_source = 'manual'
        WHERE id = (SELECT MIN(id) FROM photo_faces)`
    ).run();
    expect(ungroupedFaceCount(db, MODEL, null)).toBe(2);
  });
});

describe("groupRemaining (#235)", () => {
  it("files alike faces together and unlike faces apart", () => {
    const db = getDb();
    seedFaces(db, "/vol/ana", 0, 5);
    seedFaces(db, "/vol/bob", 10, 5);

    return groupRemaining(db, MODEL, { batchSize: 100 }).then((r) => {
      expect(r.assigned).toBe(10);
      expect(r.remaining).toBe(0);
      // Two people, not ten and not one.
      expect(personCount(db)).toBe(2);
    });
  });

  it("is RESUMABLE: cancelling keeps what it committed", async () => {
    // The whole point of the issue. The old pass wrote nothing on cancel, so
    // a 118,371-face library could never be grouped in chunks.
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 40);
    seedFaces(db, "/vol/b", 10, 40);

    const ac = new AbortController();
    let batches = 0;
    await expect(
      groupRemaining(db, MODEL, {
        batchSize: 10,
        signal: ac.signal,
        onProgress: () => {
          if (++batches === 2) ac.abort();
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    const done = grouped(db);
    expect(done).toBeGreaterThan(0); // it kept its work...
    expect(done).toBeLessThan(80); // ...and did not finish

    // And it kept a WHOLE number of batches, which is the property that
    // actually distinguishes "commits as it goes" from "commits at the end".
    // An earlier version of this test only checked done > 0, and stayed GREEN
    // when the commit was moved after the abort check — because the batches
    // before the cancelled one had already landed either way.
    expect(done % 10).toBe(0);

    // Running again CONTINUES rather than restarting.
    const r = await groupRemaining(db, MODEL, { batchSize: 10 });
    expect(r.remaining).toBe(0);
    expect(grouped(db)).toBe(80);
  });

  it("never re-does a face an earlier run already filed", async () => {
    // `attach` guards on person_id IS NULL, so a replayed range is a no-op
    // rather than a second assignment.
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 12);
    const first = await groupRemaining(db, MODEL, { batchSize: 5 });
    const people = personCount(db);

    const second = await groupRemaining(db, MODEL, { batchSize: 5 });
    expect(second.assigned).toBe(0);
    expect(second.examined).toBe(0);
    expect(personCount(db)).toBe(people); // no duplicate people either
    expect(first.remaining).toBe(0);
  });

  it("honours a scope, leaving everything outside it untouched", async () => {
    const db = getDb();
    const ana = seedFaces(db, "/vol/ana", 0, 6);
    seedFaces(db, "/vol/bob", 10, 6);

    const r = await groupRemaining(db, MODEL, { scopeIds: ana });
    expect(r.assigned).toBe(6);
    // Bob's faces are still waiting.
    expect(ungroupedFaceCount(db, MODEL, null)).toBe(6);
  });

  it("refuses to widen an EMPTY scope into the whole library", async () => {
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 5);
    const r = await groupRemaining(db, MODEL, { scopeIds: [] });
    expect(r.assigned).toBe(0);
    expect(grouped(db)).toBe(0);
  });

  it("files new faces into people that ALREADY exist", async () => {
    // The everyday case: photos arrive, and they should join the person they
    // belong to rather than starting a rival group.
    const db = getDb();
    seedFaces(db, "/vol/ana", 0, 4);
    await groupRemaining(db, MODEL);
    const before = personCount(db);

    seedFaces(db, "/vol/ana2", 0, 3); // same direction = same person
    const r = await groupRemaining(db, MODEL);
    expect(r.assigned).toBe(3);
    expect(r.created).toBe(0);
    expect(personCount(db)).toBe(before);
  });

  it("reports progress against the REMAINING count, monotonically", async () => {
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 30);
    const seen = [];
    await groupRemaining(db, MODEL, {
      batchSize: 10,
      onProgress: (p) => seen.push(p),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((p) => p.total === 30)).toBe(true);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done);
    }
    expect(seen.at(-1).done).toBe(30);
  });

  it("does nothing, cheaply, when there is nothing to do", async () => {
    const db = getDb();
    const r = await groupRemaining(db, MODEL);
    expect(r).toEqual({ assigned: 0, created: 0, examined: 0, remaining: 0 });
  });
});

describe("the pieces", () => {
  it("clusterLeftovers groups by similarity and keeps strangers apart", () => {
    const f = (axis, id) => {
      const { scale, bytes } = quantize(vec(axis));
      return { id, bytes, scale };
    };
    const groups = clusterLeftovers([f(0, 1), f(0, 2), f(9, 3)], 0.8);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.length).sort()).toEqual([1, 2]);
  });

  it("personCentroidVectors gives one vector per person", () => {
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 3);
    db.prepare(`INSERT INTO persons (id, name) VALUES (1, NULL)`).run();
    db.prepare(`UPDATE photo_faces SET person_id = 1`).run();

    const cs = personCentroidVectors(db, MODEL);
    expect(cs).toHaveLength(1);
    expect(cs[0].personId).toBe(1);
    expect(cs[0].bytes).toBeInstanceOf(Int8Array);
  });

  it("bestPerson returns null rather than forcing a poor match", () => {
    // Forcing a face into the nearest person is how a stranger ends up in
    // someone's photos — far harder to spot than a match that was missed.
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 2);
    db.prepare(`INSERT INTO persons (id, name) VALUES (1, NULL)`).run();
    db.prepare(`UPDATE photo_faces SET person_id = 1`).run();
    const cs = personCentroidVectors(db, MODEL);

    const { scale, bytes } = quantize(vec(20));
    expect(bestPerson({ bytes, scale }, cs, 0.8)).toBe(null);
  });
});
