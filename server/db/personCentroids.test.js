import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { putFaces } from "./faces.js";
import { quantize } from "../ml/quantize.js";
import { personCentroids } from "./personCentroids.js";

const MODEL = "buffalo_s";
const DIM = 16;
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-centroids-"));
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

/**
 * Photos in their OWN folder per call. `upsertScan` reconciles a folder
 * against the file list it is given, so re-scanning "/vol/Trip" with new names
 * removes the previous photos — and photo_faces cascades on photo_id, so the
 * earlier person silently loses every face. (Found by these tests.)
 */
function seedPhotos(db, n, folder) {
  const files = Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}.jpg`,
    size: 1000 + i,
    mtimeMs: 1700000000000 + i,
    kind: "image",
  }));
  return upsertScan(db, folder, 1, files).map((r) => r.id);
}

/** A face pointing along one axis, so a centroid's direction is predictable. */
function axisFace(axis, score = 0.9) {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  const { scale, bytes } = quantize(v);
  return { box: [0, 0, 10, 10], score, dim: DIM, scale, bytes };
}

/** Put `faces` on their own photos and assign them all to a new person. */
function makePerson(db, personId, faces) {
  const photos = seedPhotos(db, faces.length, `/vol/p${personId}`);
  faces.forEach((f, i) => {
    putFaces(db, { photoId: photos[i], model: MODEL, faces: [f] });
  });
  db.prepare(`INSERT INTO persons (id, name) VALUES (?, NULL)`).run(personId);
  const ids = db
    .prepare(
      `SELECT id FROM photo_faces WHERE person_id IS NULL AND model = ?
        ORDER BY id`
    )
    .all(MODEL)
    .map((r) => r.id);
  for (const id of ids) {
    db.prepare(`UPDATE photo_faces SET person_id = ? WHERE id = ?`).run(
      personId,
      id
    );
  }
  return ids;
}

describe("personCentroids (#232)", () => {
  it("averages a person's faces into a unit-norm row", () => {
    const db = getDb();
    makePerson(db, 10, [axisFace(0), axisFace(1)]);

    const { ids, dim, data, faceCounts } = personCentroids(db, MODEL, {
      minFaces: 2,
    });
    expect(Array.from(ids)).toEqual([10]);
    expect(dim).toBe(DIM);
    expect(Array.from(faceCounts)).toEqual([2]);
    expect(data.length).toBe(DIM);

    // Unit length: every downstream cosine assumes it, and a non-normalized
    // centroid would make a person with more faces look "further away" purely
    // because their average is shorter.
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += data[i] * data[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);

    // The mean of two orthogonal axes points between them, equally.
    expect(data[0]).toBeCloseTo(data[1], 3);
    expect(data[0]).toBeGreaterThan(0.5);
    expect(data[2]).toBeCloseTo(0, 3);
  });

  it("minFaces excludes singletons, and minFaces 1 includes them", () => {
    // 20,259 of 25,758 persons in a real library are singletons — a stranger
    // in the background of one photo, and not a merge candidate. That is why
    // there is a floor at all, and why it must be a RUN parameter rather than
    // a filter applied after the layout. The floor's DEFAULT is
    // `DEFAULT_MIN_FACES` (5 since #255); this test passes the values it means
    // explicitly, so it is about the filter, not about the default.
    const db = getDb();
    makePerson(db, 10, [axisFace(0), axisFace(1)]);
    makePerson(db, 11, [axisFace(2)]);

    expect(Array.from(personCentroids(db, MODEL, { minFaces: 2 }).ids)).toEqual(
      [10]
    );
    expect(Array.from(personCentroids(db, MODEL, { minFaces: 1 }).ids)).toEqual(
      [10, 11]
    );
  });

  it("excludes a person with no faces instead of emitting a NaN point", () => {
    // A real state: a named person whose faces were all detached one by one.
    // A zero-face centroid divides by zero, and a single NaN is a dot that
    // cannot be drawn, cannot be hit-tested, and poisons fitExtent for the
    // whole map.
    const db = getDb();
    db.prepare(`INSERT INTO persons (id, name) VALUES (99, 'Ghost')`).run();

    const { ids, data } = personCentroids(db, MODEL, { minFaces: 1 });
    expect(Array.from(ids)).toEqual([]);
    expect(data.length).toBe(0);
    expect(Array.from(data).every(Number.isFinite)).toBe(true);
  });

  it("ignores faces from another model", () => {
    // A buffalo_l vector and a buffalo_s vector are different spaces; mixing
    // them yields confident nonsense rather than an error.
    const db = getDb();
    makePerson(db, 10, [axisFace(0), axisFace(1)]);
    db.prepare(`UPDATE photo_faces SET model = 'buffalo_l'`).run();

    expect(personCentroids(db, MODEL, { minFaces: 1 }).ids.length).toBe(0);
    expect(personCentroids(db, "buffalo_l", { minFaces: 1 }).ids.length).toBe(
      1
    );
  });

  it("throws on mixed dimensions rather than comparing garbage", () => {
    const db = getDb();
    makePerson(db, 10, [axisFace(0), axisFace(1)]);
    db.prepare(
      `UPDATE photo_faces SET dim = 8 WHERE id = (SELECT MIN(id) FROM photo_faces)`
    ).run();

    expect(() => personCentroids(db, MODEL, { minFaces: 1 })).toThrow(
      /mixed dimensions/
    );
  });

  it("returns a STABLE id order across calls", () => {
    // The run cache is keyed by params and UMAP is order-sensitive, so an
    // unstable member order means two runs the cache calls identical produce
    // different maps — and nothing would ever report the difference.
    const db = getDb();
    for (const p of [30, 10, 20]) makePerson(db, p, [axisFace(0), axisFace(1)]);

    const a = Array.from(personCentroids(db, MODEL, { minFaces: 2 }).ids);
    const b = Array.from(personCentroids(db, MODEL, { minFaces: 2 }).ids);
    expect(a).toEqual(b);
    expect(a).toEqual([10, 20, 30]);
  });

  it("lays rows out flat, row-major, one row per person", () => {
    const db = getDb();
    makePerson(db, 10, [axisFace(0), axisFace(0)]);
    makePerson(db, 11, [axisFace(1), axisFace(1)]);

    const { ids, dim, data } = personCentroids(db, MODEL, { minFaces: 2 });
    expect(Array.from(ids)).toEqual([10, 11]);
    expect(data.length).toBe(2 * dim);
    // person 10 points along axis 0, person 11 along axis 1
    expect(data[0]).toBeCloseTo(1, 3);
    expect(data[dim + 1]).toBeCloseTo(1, 3);
  });
});
