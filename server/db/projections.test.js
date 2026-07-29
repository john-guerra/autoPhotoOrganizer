import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { putFaces } from "./faces.js";
import { quantize } from "../ml/quantize.js";
import {
  paramsKey,
  findRun,
  createRun,
  savePoints,
  pointsForRun,
  pruneRuns,
  runStaleness,
  personIdsMatchingFilter,
} from "./projections.js";

const MODEL = "buffalo_s";
const DIM = 8;
const KEY = { kind: "person", model: MODEL, algorithm: "umap" };
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-proj-"));
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

/** A person with `n` faces, each on its own photo in its own folder. */
function makePerson(db, personId, n = 2, name = null) {
  const files = Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}.jpg`,
    size: 1000 + i,
    mtimeMs: 1700000000000 + i,
    kind: "image",
  }));
  const photos = upsertScan(db, `/vol/p${personId}`, 1, files).map((r) => r.id);
  const v = new Float32Array(DIM);
  v[personId % DIM] = 1;
  const { scale, bytes } = quantize(v);
  for (const pid of photos) {
    putFaces(db, {
      photoId: pid,
      model: MODEL,
      faces: [{ box: [0, 0, 10, 10], score: 0.9, dim: DIM, scale, bytes }],
    });
  }
  db.prepare(`INSERT INTO persons (id, name) VALUES (?, ?)`).run(
    personId,
    name
  );
  db.prepare(
    `UPDATE photo_faces SET person_id = ? WHERE person_id IS NULL`
  ).run(personId);
}

describe("paramsKey", () => {
  it("is stable under key order — two spellings of one run are ONE run", () => {
    // Keying on raw JSON would store the same map twice while looking like it
    // was working.
    expect(paramsKey({ a: 1, b: 2 })).toBe(paramsKey({ b: 2, a: 1 }));
  });

  it("is stable for nested objects too", () => {
    expect(paramsKey({ x: { p: 1, q: 2 } })).toBe(
      paramsKey({ x: { q: 2, p: 1 } })
    );
  });

  it("distinguishes different values", () => {
    expect(paramsKey({ a: 1 })).not.toBe(paramsKey({ a: 2 }));
    expect(paramsKey({ minFaces: 2 })).not.toBe(paramsKey({ minFaces: 3 }));
  });
});

describe("the run cache (#232)", () => {
  it("round-trips a run and its points", () => {
    const db = getDb();
    makePerson(db, 10);
    makePerson(db, 11);
    const pk = paramsKey({ minFaces: 2, seed: 1 });

    const runId = createRun(db, {
      ...KEY,
      paramsKey: pk,
      params: { minFaces: 2, seed: 1 },
      members: 2,
    });
    savePoints(
      db,
      runId,
      Int32Array.from([10, 11]),
      Float32Array.from([1, 2, 3, 4])
    );

    expect(pointsForRun(db, runId)).toEqual([
      {
        personId: 10,
        x: 1,
        y: 2,
        name: null,
        // null is a REAL state, not a gap in the fixture: a person whose
        // cover face was detached. PeopleView draws initials for it, and the
        // map must draw a dot rather than a broken image.
        coverFaceId: null,
        faces: 2,
        photos: 2,
      },
      {
        personId: 11,
        x: 3,
        y: 4,
        name: null,
        coverFaceId: null,
        faces: 2,
        photos: 2,
      },
    ]);
    expect(findRun(db, { ...KEY, paramsKey: pk }).id).toBe(runId);
  });

  it("findRun misses on ANY one field of the key", () => {
    // An incomplete key would serve a buffalo_l map to a buffalo_s library, or
    // a t-SNE map to someone who asked for UMAP.
    const db = getDb();
    const pk = paramsKey({ minFaces: 2 });
    createRun(db, { ...KEY, paramsKey: pk, params: {}, members: 0 });

    expect(findRun(db, { ...KEY, paramsKey: pk })).toBeTruthy();
    expect(
      findRun(db, { ...KEY, paramsKey: paramsKey({ minFaces: 3 }) })
    ).toBeNull();
    expect(
      findRun(db, { ...KEY, model: "buffalo_l", paramsKey: pk })
    ).toBeNull();
    expect(
      findRun(db, { ...KEY, algorithm: "tsne", paramsKey: pk })
    ).toBeNull();
    expect(findRun(db, { ...KEY, kind: "photo", paramsKey: pk })).toBeNull();
  });

  it("reports PHOTOS as well as faces, since dot size encodes photos", () => {
    // Two faces of one person in a single frame is ONE photo. Sizing by faces
    // would make a person photographed once with a mirror look twice as
    // present as they are.
    const db = getDb();
    makePerson(db, 10, 2); // 2 faces on 2 distinct photos
    const runId = createRun(db, {
      ...KEY,
      paramsKey: "k",
      params: {},
      members: 1,
    });
    savePoints(db, runId, Int32Array.from([10]), Float32Array.from([1, 2]));
    expect(pointsForRun(db, runId)[0]).toMatchObject({ faces: 2, photos: 2 });

    // Put a second face of the same person on a photo they are already in.
    const photoId = db
      .prepare(`SELECT photo_id FROM photo_faces WHERE person_id = 10 LIMIT 1`)
      .get().photo_id;
    db.prepare(
      `INSERT INTO photo_faces
         (photo_id, model, box_x, box_y, box_w, box_h, det_score, dim, scale,
          vec, person_id)
       VALUES (?, ?, 0,0,1,1, 0.5, 2, 1, x'0000', 10)`
    ).run(photoId, MODEL);
    expect(pointsForRun(db, runId)[0]).toMatchObject({ faces: 3, photos: 2 });
  });

  it("reads name and face count LIVE, so a rename needs no re-projection", () => {
    const db = getDb();
    makePerson(db, 10);
    const runId = createRun(db, {
      ...KEY,
      paramsKey: "k",
      params: {},
      members: 1,
    });
    savePoints(db, runId, Int32Array.from([10]), Float32Array.from([1, 2]));

    expect(pointsForRun(db, runId)[0].name).toBe(null);
    db.prepare(`UPDATE persons SET name = 'Mafe' WHERE id = 10`).run();
    expect(pointsForRun(db, runId)[0].name).toBe("Mafe");
  });

  it("a merged-away person's dot VANISHES with no re-projection", () => {
    // The whole point of the INNER JOIN: the map stays truthful about who
    // exists the moment a merge lands, and only positions go stale.
    const db = getDb();
    makePerson(db, 10);
    makePerson(db, 11);
    const runId = createRun(db, {
      ...KEY,
      paramsKey: "k",
      params: {},
      members: 2,
    });
    savePoints(
      db,
      runId,
      Int32Array.from([10, 11]),
      Float32Array.from([1, 2, 3, 4])
    );

    expect(pointsForRun(db, runId)).toHaveLength(2);
    db.prepare(`DELETE FROM persons WHERE id = 11`).run();
    expect(pointsForRun(db, runId).map((p) => p.personId)).toEqual([10]);
  });

  it("KEEPS the point row after the person is gone, so undo brings the dot back", () => {
    // Deliberately no ON DELETE CASCADE on ref_id. The join already hides the
    // row; deleting it would silently break undo, and adding a cascade LOOKS
    // like tightening the schema.
    const db = getDb();
    makePerson(db, 10);
    const runId = createRun(db, {
      ...KEY,
      paramsKey: "k",
      params: {},
      members: 1,
    });
    savePoints(db, runId, Int32Array.from([10]), Float32Array.from([1, 2]));

    db.prepare(`DELETE FROM persons WHERE id = 10`).run();
    expect(pointsForRun(db, runId)).toHaveLength(0);
    expect(
      db
        .prepare(`SELECT COUNT(*) n FROM projection_point WHERE run_id = ?`)
        .get(runId).n
    ).toBe(1);

    // ...and an undo that re-creates the person restores the dot, position
    // intact.
    db.prepare(`INSERT INTO persons (id, name) VALUES (10, NULL)`).run();
    expect(pointsForRun(db, runId)).toEqual([
      expect.objectContaining({ personId: 10, x: 1, y: 2 }),
    ]);
  });

  it("refuses a points/ids mismatch rather than shifting every dot", () => {
    // Off by one here is a map that looks fine and puts every person on
    // someone else's coordinates.
    const db = getDb();
    const runId = createRun(db, {
      ...KEY,
      paramsKey: "k",
      params: {},
      members: 2,
    });
    expect(() =>
      savePoints(db, runId, Int32Array.from([1, 2]), Float32Array.from([1, 2]))
    ).toThrow(/ids but/);
  });

  it("pruneRuns keeps the newest N and drops their points with them", () => {
    const db = getDb();
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = createRun(db, {
        ...KEY,
        paramsKey: `k${i}`,
        params: {},
        members: 1,
        createdAt: 1000 + i,
      });
      savePoints(db, id, Int32Array.from([10]), Float32Array.from([1, 2]));
      ids.push(id);
    }

    pruneRuns(db, { kind: "person", model: MODEL, keep: 2 });

    expect(
      db
        .prepare(`SELECT id FROM projection_runs ORDER BY id`)
        .all()
        .map((r) => r.id)
    ).toEqual(ids.slice(-2));
    expect(
      db
        .prepare(
          `SELECT COUNT(*) n FROM projection_point
            WHERE run_id NOT IN (SELECT id FROM projection_runs)`
        )
        .get().n
    ).toBe(0);
  });

  it("pruneRuns leaves another model's runs alone", () => {
    const db = getDb();
    createRun(db, { ...KEY, paramsKey: "a", params: {}, members: 1 });
    createRun(db, {
      ...KEY,
      model: "buffalo_l",
      paramsKey: "b",
      params: {},
      members: 1,
    });
    pruneRuns(db, { kind: "person", model: MODEL, keep: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM projection_runs`).get().n).toBe(
      1
    );
  });
});

describe("personIdsMatchingFilter (#232)", () => {
  it("returns everyone when nothing is filtering", () => {
    const db = getDb();
    makePerson(db, 10);
    makePerson(db, 11);
    expect(personIdsMatchingFilter(db, MODEL, {})).toEqual([10, 11]);
  });

  it("narrows to the people in the photos the filter is showing", () => {
    // The point of the feature: filter the feed to a keep-only set, and the
    // map shows only the people who are in it.
    const db = getDb();
    makePerson(db, 10);
    makePerson(db, 11);
    // Rate one person's photos so a rating filter separates them.
    db.prepare(
      `UPDATE photos SET rating = 5
        WHERE id IN (SELECT photo_id FROM photo_faces WHERE person_id = 10)`
    ).run();

    expect(personIdsMatchingFilter(db, MODEL, { minRating: 5 })).toEqual([10]);
    expect(personIdsMatchingFilter(db, MODEL, { minRating: 1 })).toEqual([10]);
    expect(personIdsMatchingFilter(db, MODEL, { minRating: 0 })).toEqual([
      10, 11,
    ]);
  });

  it("returns EMPTY rather than everyone when the filter matches nobody", () => {
    // Empty and "no filter" must stay distinct all the way to the view: an
    // empty result that fell back to showing everyone would silently
    // contradict the filter the user set.
    const db = getDb();
    makePerson(db, 10);
    expect(personIdsMatchingFilter(db, MODEL, { minRating: 5 })).toEqual([]);
  });

  it("ignores faces on stale photos", () => {
    // A photo whose file vanished at the last scan is not "in view".
    const db = getDb();
    makePerson(db, 10);
    db.prepare(`UPDATE photos SET stale = 1`).run();
    expect(personIdsMatchingFilter(db, MODEL, {})).toEqual([]);
  });

  it("ignores another model's faces", () => {
    const db = getDb();
    makePerson(db, 10);
    expect(personIdsMatchingFilter(db, "buffalo_l", {})).toEqual([]);
  });
});

describe("runStaleness", () => {
  it("counts people added since the run, against the population it was drawn from", () => {
    // Comparing against EVERY person would report the 20,259 singletons as
    // missing from a minFaces:2 map — true, and useless.
    const db = getDb();
    makePerson(db, 10);
    const runId = createRun(db, {
      ...KEY,
      paramsKey: "k",
      params: {},
      members: 1,
    });
    savePoints(db, runId, Int32Array.from([10]), Float32Array.from([1, 2]));

    expect(runStaleness(db, runId, { minFaces: 2 })).toEqual({
      peopleOnMap: 1,
      peopleNow: 1,
      missing: 0,
    });

    makePerson(db, 11); // 2 faces — inside the minFaces:2 population
    makePerson(db, 12, 1); // a singleton — outside it
    expect(runStaleness(db, runId, { minFaces: 2 })).toEqual({
      peopleOnMap: 1,
      peopleNow: 2,
      missing: 1,
    });
  });
});
