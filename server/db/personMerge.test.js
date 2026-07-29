import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { putFaces } from "./faces.js";
import { quantize } from "../ml/quantize.js";
import {
  mergePersonsBulk,
  undoMerge,
  distinctNames,
  UNDO_KEEP,
  MAX_MERGE_FACES,
} from "./personMerge.js";

const MODEL = "buffalo_s";
const DIM = 8;
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-merge-"));
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

/** A person with `faces` faces, each on its own photo in its own folder. */
function makePerson(
  db,
  personId,
  { faces = 2, name = null, score = 0.5 } = {}
) {
  const files = Array.from({ length: faces }, (_, i) => ({
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
      faces: [{ box: [0, 0, 10, 10], score, dim: DIM, scale, bytes }],
    });
  }
  db.prepare(`INSERT INTO persons (id, name, created_at) VALUES (?, ?, ?)`).run(
    personId,
    name,
    1000 + personId
  );
  db.prepare(
    `UPDATE photo_faces SET person_id = ?, person_source = 'model'
      WHERE person_id IS NULL`
  ).run(personId);
  return photos;
}

const personCount = (db) =>
  db.prepare(`SELECT COUNT(*) n FROM persons`).get().n;
const sourceOf = (db, personId) =>
  db
    .prepare(`SELECT person_source s FROM photo_faces WHERE person_id = ?`)
    .all(personId)
    .map((r) => r.s);

describe("mergePersonsBulk (#232)", () => {
  it("moves every source's faces into the target in one pass", () => {
    const db = getDb();
    for (let p = 1; p <= 5; p++) makePerson(db, p);

    const r = mergePersonsBulk(db, 1, [2, 3, 4, 5], { name: "Mafe" });
    expect(r.mergedCount).toBe(4);
    expect(r.moved).toBe(8);
    expect(r.name).toBe("Mafe");
    expect(personCount(db)).toBe(1);
    expect(
      db.prepare(`SELECT COUNT(*) n FROM photo_faces WHERE person_id = 1`).get()
        .n
    ).toBe(10);
  });

  it("does not go quadratic on the target's own faces", () => {
    // Looping mergePersons re-marks the TARGET's whole (growing) face set per
    // source. This is the shape that made a 500-person lasso onto a 3,512-face
    // person a million redundant updates.
    const db = getDb();
    makePerson(db, 1, { faces: 60 });
    for (let p = 2; p <= 60; p++) makePerson(db, p, { faces: 2 });
    const t0 = performance.now();
    const r = mergePersonsBulk(
      db,
      1,
      [...Array(59)].map((_, i) => i + 2),
      {
        name: "X",
      }
    );
    const ms = performance.now() - t0;
    expect(r.mergedCount).toBe(59);
    expect(ms).toBeLessThan(1500);
  });

  it("marks BOTH sides manual, so regrouping keeps the decision", () => {
    // Marking only the movers lets the next pass clear the target's own faces,
    // and the merged person silently loses half their photos — the bug
    // mergePersons' own comment records.
    const db = getDb();
    makePerson(db, 1);
    makePerson(db, 2);
    mergePersonsBulk(db, 1, [2], { name: "X" });
    expect(sourceOf(db, 1)).toEqual(["manual", "manual", "manual", "manual"]);
  });

  it("recomputes the cover to the best face across the WHOLE merged set", () => {
    const db = getDb();
    makePerson(db, 1, { score: 0.4 });
    makePerson(db, 2, { score: 0.99 });
    const best = db
      .prepare(
        `SELECT id FROM photo_faces ORDER BY det_score DESC, id ASC LIMIT 1`
      )
      .get().id;
    mergePersonsBulk(db, 1, [2], { name: "X" });
    expect(
      db.prepare(`SELECT cover_face_id c FROM persons WHERE id = 1`).get().c
    ).toBe(best);
  });

  it("SKIPS a person deleted mid-flight and reports it", () => {
    // Failing the whole merge over one stale row would throw away every good
    // one. The caller can then say "merged 2; 1 was already gone".
    const db = getDb();
    for (let p = 1; p <= 3; p++) makePerson(db, p);
    const r = mergePersonsBulk(db, 1, [2, 3, 999], { name: "X" });
    expect(r.missing).toEqual([999]);
    expect(r.mergedCount).toBe(2);
    expect(personCount(db)).toBe(1);
  });

  it("filters the target out of the sources rather than throwing", () => {
    // A lasso around the target naturally includes it.
    const db = getDb();
    makePerson(db, 1);
    makePerson(db, 2);
    expect(() => mergePersonsBulk(db, 1, [1, 2], { name: "X" })).not.toThrow();
    expect(personCount(db)).toBe(1);
  });

  it("never applies the into.name || from.name heuristic", () => {
    // Correct for a two-person merge where the user pointed at a row; in a
    // lasso there is no such row, and quietly keeping one of two names is
    // invisible data loss. An explicit null means "no name".
    const db = getDb();
    makePerson(db, 1, { name: null });
    makePerson(db, 2, { name: "Edwin" });
    const r = mergePersonsBulk(db, 1, [2], { name: null });
    expect(r.name).toBe(null);
    expect(db.prepare(`SELECT name FROM persons WHERE id = 1`).get().name).toBe(
      null
    );
  });

  it("refuses an oversized merge rather than writing an undo it cannot honour", () => {
    // maxFaces is injectable precisely so this is reachable without building
    // 250,000 rows — a guard no test can reach is a guard nobody knows is
    // broken.
    const db = getDb();
    makePerson(db, 1, { faces: 3 });
    makePerson(db, 2, { faces: 3 });
    expect(() =>
      mergePersonsBulk(db, 1, [2], { name: "X", maxFaces: 4 })
    ).toThrow(/too many to merge/i);

    // ...and it refuses cleanly: nothing merged, nothing to undo.
    expect(personCount(db)).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) n FROM person_merge_undo`).get().n).toBe(
      0
    );
    expect(new Set(sourceOf(db, 1))).toEqual(new Set(["model"]));
  });

  it("does nothing and returns no token when every source is gone", () => {
    const db = getDb();
    makePerson(db, 1);
    const r = mergePersonsBulk(db, 1, [42, 43], { name: "X" });
    expect(r.mergedCount).toBe(0);
    expect(r.token).toBe(null);
    expect(personCount(db)).toBe(1);
  });
});

describe("undoMerge", () => {
  it("restores person_source PER FACE to its prior value", () => {
    // THE field everyone forgets. Restoring person_id alone leaves those faces
    // frozen as 'manual', which no future grouping pass can revise — a silent,
    // permanent change to data the user asked to put back.
    const db = getDb();
    makePerson(db, 1);
    makePerson(db, 2);
    makePerson(db, 3);
    // Person 2 was already a human decision; 1 and 3 were the model's.
    db.prepare(
      `UPDATE photo_faces SET person_source = 'manual' WHERE person_id = 2`
    ).run();

    const { token } = mergePersonsBulk(db, 1, [2, 3], { name: "X" });
    expect(new Set(sourceOf(db, 1))).toEqual(new Set(["manual"]));

    undoMerge(db, token);
    expect(new Set(sourceOf(db, 1))).toEqual(new Set(["model"]));
    expect(new Set(sourceOf(db, 2))).toEqual(new Set(["manual"]));
    expect(new Set(sourceOf(db, 3))).toEqual(new Set(["model"]));
  });

  it("restores the deleted people AT THEIR ORIGINAL IDS", () => {
    // The ids matter: a cached projection point references them, and reusing
    // them is what makes the dot reappear in place rather than vanishing.
    const db = getDb();
    for (let p = 1; p <= 3; p++) makePerson(db, p);
    const { token } = mergePersonsBulk(db, 1, [2, 3], { name: "X" });
    expect(personCount(db)).toBe(1);

    const r = undoMerge(db, token);
    expect(r.restored).toBe(2);
    expect(
      db
        .prepare(`SELECT id FROM persons ORDER BY id`)
        .all()
        .map((x) => x.id)
    ).toEqual([1, 2, 3]);
  });

  it("restores the target's previous name and cover", () => {
    const db = getDb();
    makePerson(db, 1, { name: "Old", score: 0.9 });
    makePerson(db, 2, { name: null, score: 0.99 });
    const coverBefore = db
      .prepare(`SELECT cover_face_id c FROM persons WHERE id = 1`)
      .get().c;

    const { token } = mergePersonsBulk(db, 1, [2], { name: "New" });
    expect(db.prepare(`SELECT name FROM persons WHERE id=1`).get().name).toBe(
      "New"
    );

    undoMerge(db, token);
    expect(db.prepare(`SELECT name FROM persons WHERE id=1`).get().name).toBe(
      "Old"
    );
    expect(
      db.prepare(`SELECT cover_face_id c FROM persons WHERE id=1`).get().c
    ).toBe(coverBefore);
  });

  it("puts every face back with its original owner", () => {
    const db = getDb();
    for (let p = 1; p <= 4; p++) makePerson(db, p, { faces: 3 });
    const before = db
      .prepare(`SELECT id, person_id FROM photo_faces ORDER BY id`)
      .all();

    const { token } = mergePersonsBulk(db, 1, [2, 3, 4], { name: "X" });
    undoMerge(db, token);

    expect(
      db.prepare(`SELECT id, person_id FROM photo_faces ORDER BY id`).all()
    ).toEqual(before);
  });

  it("cannot be applied twice", () => {
    const db = getDb();
    makePerson(db, 1);
    makePerson(db, 2);
    const { token } = mergePersonsBulk(db, 1, [2], { name: "X" });
    undoMerge(db, token);
    expect(() => undoMerge(db, token)).toThrow(/no longer undoable/i);
  });

  it("keeps only the newest UNDO_KEEP records, oldest first to go", () => {
    const db = getDb();
    makePerson(db, 1, { faces: 1 });
    const tokens = [];
    for (let p = 2; p <= 2 + UNDO_KEEP + 2; p++) {
      makePerson(db, p, { faces: 1 });
      tokens.push(mergePersonsBulk(db, 1, [p], { name: "X" }).token);
    }
    expect(db.prepare(`SELECT COUNT(*) n FROM person_merge_undo`).get().n).toBe(
      UNDO_KEEP
    );
    // The oldest is gone, and says so specifically rather than "not found".
    expect(() => undoMerge(db, tokens[0])).toThrow(/no longer undoable/i);
    // The newest still works.
    expect(() => undoMerge(db, tokens.at(-1))).not.toThrow();
  });
});

describe("the merge size cap", () => {
  it("is large enough for any real lasso", () => {
    // 250,000 faces is far beyond a plausible selection in a library of
    // 118,371 — the cap exists to bound the undo record, not to get in the way.
    expect(MAX_MERGE_FACES).toBeGreaterThan(118_371);
  });
});

describe("distinctNames", () => {
  it("finds the name conflict a lasso must not resolve silently", () => {
    const db = getDb();
    makePerson(db, 1, { name: "Mafe" });
    makePerson(db, 2, { name: null });
    makePerson(db, 3, { name: "John" });
    expect(distinctNames(db, [1, 2, 3])).toEqual(["John", "Mafe"]);
    expect(distinctNames(db, [1, 2])).toEqual(["Mafe"]);
    expect(distinctNames(db, [2])).toEqual([]);
  });

  it("ignores whitespace-only names rather than counting them as a conflict", () => {
    const db = getDb();
    makePerson(db, 1, { name: "  " });
    makePerson(db, 2, { name: "Mafe" });
    expect(distinctNames(db, [1, 2])).toEqual(["Mafe"]);
  });

  it("is total for nonsense input", () => {
    expect(distinctNames(getDb(), [])).toEqual([]);
    expect(distinctNames(getDb(), null)).toEqual([]);
    expect(distinctNames(getDb(), ["x"])).toEqual([]);
  });
});
