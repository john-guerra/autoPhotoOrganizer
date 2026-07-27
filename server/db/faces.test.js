import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { EMBED_STAGE, putEmbedding } from "./embeddings.js";
import { quantize } from "../ml/quantize.js";
import { buildFilter } from "./filters.js";
import {
  FACES_STAGE,
  putFaces,
  facesFor,
  pendingFaceRows,
  faceCounts,
  faceVectors,
  purgeFaces,
  saveClusters,
  listPersons,
  renamePerson,
  mergePersons,
  detachFace,
} from "./faces.js";

const MODEL = "buffalo_l";
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-faces-"));
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

function seed(db, n, folder = "/vol/Trip") {
  const files = Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}.jpg`,
    size: 1000 + i,
    mtimeMs: 1700000000000 + i,
    kind: "image",
  }));
  return upsertScan(db, folder, 1, files).map((r) => r.id);
}

/** A face whose vector is a distinct direction, so cosines are meaningful. */
function face(box, seedVal, score = 0.9) {
  const v = new Float32Array(512);
  for (let i = 0; i < 512; i++) v[i] = Math.sin(i * 0.1 + seedVal);
  const { scale, bytes } = quantize(v);
  return { box, score, dim: 512, scale, bytes };
}

describe("face storage (#166)", () => {
  it("stores boxes as x/y/w/h and hands them back as corners", () => {
    const db = getDb();
    const [id] = seed(db, 1);
    putFaces(db, {
      photoId: id,
      model: MODEL,
      faces: [face([10, 20, 60, 90], 1)],
    });

    const [f] = facesFor(db, id, MODEL);
    expect(f.box).toEqual([10, 20, 60, 90]);
    expect(f.score).toBe(0.9);
    expect(f.dim).toBe(512);
    expect(f.personId).toBe(null);
    expect(f.bytes).toBeInstanceOf(Int8Array);
    expect(f.bytes.length).toBe(512);
  });

  it("REPLACES a photo's faces on re-run instead of appending", () => {
    // Detection returns "the faces in this photo" as one complete answer. An
    // append would double every face on the second run -- and a duplicated
    // face is invisible: it clusters perfectly with itself and quietly
    // inflates whoever it belongs to.
    const db = getDb();
    const [id] = seed(db, 1);
    putFaces(db, {
      photoId: id,
      model: MODEL,
      faces: [face([0, 0, 10, 10], 1), face([20, 20, 30, 30], 2)],
    });
    putFaces(db, {
      photoId: id,
      model: MODEL,
      faces: [face([5, 5, 15, 15], 3)],
    });

    const all = facesFor(db, id, MODEL);
    expect(all).toHaveLength(1);
    expect(all[0].box).toEqual([5, 5, 15, 15]);
  });

  it("keeps another model's faces when one model re-runs", () => {
    const db = getDb();
    const [id] = seed(db, 1);
    putFaces(db, {
      photoId: id,
      model: "buffalo_l",
      faces: [face([0, 0, 9, 9], 1)],
    });
    putFaces(db, {
      photoId: id,
      model: "buffalo_s",
      faces: [face([1, 1, 8, 8], 2)],
    });
    putFaces(db, { photoId: id, model: "buffalo_l", faces: [] });

    expect(facesFor(db, id, "buffalo_l")).toHaveLength(0);
    expect(facesFor(db, id, "buffalo_s")).toHaveLength(1);
  });

  it("returns the strongest detection first", () => {
    const db = getDb();
    const [id] = seed(db, 1);
    putFaces(db, {
      photoId: id,
      model: MODEL,
      faces: [face([0, 0, 9, 9], 1, 0.6), face([9, 9, 18, 18], 2, 0.95)],
    });
    expect(facesFor(db, id, MODEL).map((f) => f.score)).toEqual([0.95, 0.6]);
  });
});

describe("the zero-face sentinel", () => {
  it("takes a faceless photo out of the worklist", () => {
    // Most of a real archive is landscapes and screenshots. Without a marker
    // for "looked, found nobody", every one of them is pending forever and
    // each sweep re-detects half the library -- the shape of #169.
    const db = getDb();
    const ids = seed(db, 3);
    expect(pendingFaceRows(db, MODEL, 10).map((r) => r.id)).toEqual(ids);

    putFaces(db, { photoId: ids[0], model: MODEL, faces: [] });

    expect(pendingFaceRows(db, MODEL, 10).map((r) => r.id)).toEqual([
      ids[1],
      ids[2],
    ]);
    expect(facesFor(db, ids[0], MODEL)).toEqual([]);
  });

  it("counts a scanned-but-empty photo as scanned, not as having a face", () => {
    const db = getDb();
    const ids = seed(db, 4);
    putFaces(db, { photoId: ids[0], model: MODEL, faces: [] });
    putFaces(db, {
      photoId: ids[1],
      model: MODEL,
      faces: [face([0, 0, 9, 9], 1)],
    });

    const c = faceCounts(db, MODEL);
    expect(c.total).toBe(4);
    expect(c.scanned).toBe(2); // both were LOOKED AT
    expect(c.withFaces).toBe(1); // only one held anyone
    expect(c.faces).toBe(1);
    expect(c.total - c.scanned - c.failed).toBe(2); // genuinely pending
  });

  it("does not share ml_status rows with the embed stage", () => {
    // The two stages key the same table by (photo_id, stage, model). If the
    // names ever collided, embedding a photo would mark it face-scanned and
    // vice versa -- both sweeps silently marking each other complete, with
    // nothing missing from either table to notice.
    expect(FACES_STAGE).not.toBe(EMBED_STAGE);

    const db = getDb();
    const [id] = seed(db, 1);
    const { scale, bytes } = quantize(new Float32Array(512).fill(0.5));
    putEmbedding(db, { photoId: id, model: MODEL, dim: 512, scale, bytes });

    // Embedded, but nobody has looked for faces yet.
    expect(pendingFaceRows(db, MODEL, 10).map((r) => r.id)).toEqual([id]);
  });
});

describe("invalidation when the bytes change", () => {
  it("drops a photo's faces on rescan, so an edit cannot keep the old ones", () => {
    // The worklist only asks whether a photo was LOOKED AT, never whether the
    // answer still describes the current bytes -- so nothing downstream would
    // ever notice a stale face. Same reasoning as the vector, different table.
    const db = getDb();
    const [id] = seed(db, 1);
    putFaces(db, {
      photoId: id,
      model: MODEL,
      faces: [face([0, 0, 40, 40], 1)],
    });
    expect(facesFor(db, id, MODEL)).toHaveLength(1);

    // Rescan the same filename with different bytes.
    upsertScan(db, "/vol/Trip", 1, [
      {
        name: "IMG_0.jpg",
        size: 999999,
        mtimeMs: 1800000000000,
        kind: "image",
      },
    ]);

    expect(facesFor(db, id, MODEL)).toHaveLength(0);
    // ...and it is pending again, rather than silently marked done with none.
    expect(pendingFaceRows(db, MODEL, 10).map((r) => r.id)).toEqual([id]);
  });

  it("keeps faces when a rescan finds the file unchanged", () => {
    const db = getDb();
    const [id] = seed(db, 1);
    putFaces(db, {
      photoId: id,
      model: MODEL,
      faces: [face([0, 0, 40, 40], 1)],
    });

    upsertScan(db, "/vol/Trip", 1, [
      { name: "IMG_0.jpg", size: 1000, mtimeMs: 1700000000000, kind: "image" },
    ]);

    expect(facesFor(db, id, MODEL)).toHaveLength(1);
    expect(pendingFaceRows(db, MODEL, 10)).toEqual([]);
  });

  it("lets a photo be deleted rather than throwing on the foreign key", () => {
    // better-sqlite3 enables PRAGMA foreign_keys, so a plain REFERENCES here
    // would make every DELETE FROM photos path throw the moment a photo has a
    // face. That was #161's Critical 1, reproduced exactly.
    const db = getDb();
    const [id] = seed(db, 1);
    putFaces(db, {
      photoId: id,
      model: MODEL,
      faces: [face([0, 0, 40, 40], 1)],
    });

    expect(() =>
      db.prepare(`DELETE FROM photos WHERE id = ?`).run(id)
    ).not.toThrow();
    expect(facesFor(db, id, MODEL)).toEqual([]);
  });

  it("keeps faces when the PERSON they were assigned to is deleted", () => {
    // Deleting a person corrects the clustering; it does not assert the faces
    // were never there. The asymmetry with photo_id's CASCADE is deliberate.
    const db = getDb();
    const [id] = seed(db, 1);
    putFaces(db, {
      photoId: id,
      model: MODEL,
      faces: [face([0, 0, 40, 40], 1)],
    });
    db.prepare(`INSERT INTO persons (id, name) VALUES (7, 'Ana')`).run();
    db.prepare(`UPDATE photo_faces SET person_id = 7`).run();

    db.prepare(`DELETE FROM persons WHERE id = 7`).run();

    const [f] = facesFor(db, id, MODEL);
    expect(f).toBeDefined();
    expect(f.personId).toBe(null);
  });
});

describe("bulk reads and purge", () => {
  it("lays every vector out flat, tagged by face and photo", () => {
    const db = getDb();
    const ids = seed(db, 2);
    putFaces(db, {
      photoId: ids[0],
      model: MODEL,
      faces: [face([0, 0, 9, 9], 1), face([9, 9, 18, 18], 2)],
    });
    putFaces(db, {
      photoId: ids[1],
      model: MODEL,
      faces: [face([0, 0, 9, 9], 3)],
    });

    const v = faceVectors(db, MODEL);
    expect(v.dim).toBe(512);
    expect(v.ids).toHaveLength(3);
    expect(v.data.length).toBe(3 * 512);
    expect([...v.photoIds]).toEqual([ids[0], ids[0], ids[1]]);
    expect(v.scales.every((s) => s > 0)).toBe(true);
  });

  it("refuses to lay out mixed dimensions rather than truncating", () => {
    // Two models writing under one name is a bug worth stopping for; silently
    // truncating to the first row's width would compare garbage.
    const db = getDb();
    const [id] = seed(db, 1);
    putFaces(db, { photoId: id, model: MODEL, faces: [face([0, 0, 9, 9], 1)] });
    db.prepare(`UPDATE photo_faces SET dim = 128 WHERE id = 1`).run();
    db.prepare(
      `INSERT INTO photo_faces (photo_id, model, box_x, box_y, box_w, box_h,
                                det_score, dim, scale, vec, created_at)
       VALUES (?, ?, 0, 0, 1, 1, 0.5, 512, 0.01, x'00', 0)`
    ).run(id, MODEL);

    expect(() => faceVectors(db, MODEL)).toThrow(/mixed dimensions/);
  });

  it("is empty, not broken, before anything has been detected", () => {
    const db = getDb();
    seed(db, 2);
    const v = faceVectors(db, MODEL);
    expect(v.ids).toHaveLength(0);
    expect(v.dim).toBe(0);
    expect(faceCounts(db, MODEL)).toMatchObject({ scanned: 0, faces: 0 });
  });

  it("purges the markers alongside the rows", () => {
    // Dropping rows but keeping the `done` markers leaves a library that
    // reports itself fully scanned and finds nobody -- with no way back short
    // of deleting index.db, which also destroys ratings and album names.
    const db = getDb();
    const ids = seed(db, 2);
    putFaces(db, {
      photoId: ids[0],
      model: MODEL,
      faces: [face([0, 0, 9, 9], 1)],
    });
    putFaces(db, { photoId: ids[1], model: MODEL, faces: [] });

    expect(purgeFaces(db, MODEL)).toEqual({ faces: 1, markers: 2 });
    expect(faceCounts(db, MODEL)).toMatchObject({ scanned: 0, faces: 0 });
    expect(pendingFaceRows(db, MODEL, 10)).toHaveLength(2);
  });
});

describe("people (#167)", () => {
  const face = (box, seedVal, score = 0.9) => {
    const v = new Float32Array(512);
    for (let i = 0; i < 512; i++) v[i] = Math.sin(i * 0.1 + seedVal);
    const { scale, bytes } = quantize(v);
    return { box, score, dim: 512, scale, bytes };
  };

  function seedFaces(db, n) {
    const ids = seed(db, n);
    ids.forEach((id, i) =>
      putFaces(db, {
        photoId: id,
        model: MODEL,
        faces: [face([0, 0, 50, 50], i)],
      })
    );
    return db
      .prepare(`SELECT id FROM photo_faces ORDER BY id`)
      .all()
      .map((r) => r.id);
  }

  it("creates a person per cluster and assigns its faces", () => {
    const db = getDb();
    const f = seedFaces(db, 4);
    const r = saveClusters(db, [[f[0], f[1], f[2]], [f[3]]], { model: MODEL });

    expect(r.people).toBe(2);
    expect(r.assigned).toBe(4);
    const people = listPersons(db);
    expect(people.map((p) => p.faces)).toEqual([3, 1]); // largest first
    expect(people[0].name).toBe(null); // unnamed, and still browsable
  });

  it("keeps a NAME across a re-cluster", () => {
    // Losing a name to a re-run makes naming feel unsafe, which is fatal for
    // a feature whose whole cost is ten minutes of typing.
    const db = getDb();
    const f = seedFaces(db, 3);
    saveClusters(db, [[f[0], f[1], f[2]]], { model: MODEL });
    const id = listPersons(db)[0].id;
    renamePerson(db, id, "Ana");

    saveClusters(db, [[f[0]], [f[1], f[2]]], { model: MODEL });

    // NOT `some(p => p.name === "Ana")` — that passes with Ana at ZERO faces,
    // which is exactly the bug it was supposed to catch and did not. Naming a
    // cluster asserts "these faces are Ana"; the assertion is worthless if the
    // photos walk away to a new unnamed person on the next pass.
    const ana = listPersons(db).find((p) => p.name === "Ana");
    expect(ana).toBeDefined();
    expect(ana.faces).toBe(3);
    expect(ana.photos).toBe(3);
    // ...and no shadow person was created holding the same faces.
    expect(listPersons(db)).toHaveLength(1);
  });

  it("keeps a MANUAL assignment when the model changes its mind", () => {
    // #167: the correction must be durable across the next sweep. Same
    // contract photo_tags.source has for semantic tags.
    const db = getDb();
    const f = seedFaces(db, 3);
    saveClusters(db, [[f[0], f[1], f[2]]], { model: MODEL });
    const personId = listPersons(db)[0].id;
    db.prepare(
      `UPDATE photo_faces SET person_id = ?, person_source = 'manual' WHERE id = ?`
    ).run(personId, f[2]);

    const r = saveClusters(db, [[f[0]], [f[1]]], { model: MODEL });

    expect(r.keptManual).toBe(1);
    const still = db
      .prepare(`SELECT person_id FROM photo_faces WHERE id = ?`)
      .get(f[2]);
    expect(still.person_id).toBe(personId);
  });

  it("trims a name and treats blank as clearing it", () => {
    const db = getDb();
    const f = seedFaces(db, 1);
    saveClusters(db, [[f[0]]], { model: MODEL });
    const id = listPersons(db)[0].id;
    expect(renamePerson(db, id, "  Ana  ").name).toBe("Ana");
    expect(renamePerson(db, id, "   ").name).toBe(null);
    expect(() => renamePerson(db, 9999, "X")).toThrow(/no such person/);
  });

  it("filters the feed by person through buildFilter", () => {
    // The facet has to survive client spec -> server allowlist -> SQL. This
    // covers the SQL end; a facet missing from any layer is silently dropped.
    const db = getDb();
    const f = seedFaces(db, 3);
    saveClusters(db, [[f[0], f[1]], [f[2]]], { model: MODEL });
    const personId = listPersons(db)[0].id;

    const { sql, params } = buildFilter({ personId });
    const matched = db
      .prepare(`SELECT photos.id FROM photos WHERE ${sql}`)
      .all(...params);
    expect(matched).toHaveLength(2);
  });

  it("is phrased as a subquery, never a JOIN", () => {
    // Required rather than stylistic: a facet written as a JOIN works in
    // getFeedPage and silently breaks getTreeNode and countGroupPath, which
    // do not join extra tables.
    const { sql } = buildFilter({ personId: 1 });
    expect(sql).toMatch(/photos\.id IN \(SELECT photo_id FROM photo_faces/);
    expect(sql).not.toMatch(/\bJOIN\b/);
  });
});

describe("correcting the clustering, durably (#167)", () => {
  const face = (seedVal) => {
    const v = new Float32Array(512);
    for (let i = 0; i < 512; i++) v[i] = Math.sin(i * 0.1 + seedVal);
    const { scale, bytes } = quantize(v);
    return { box: [0, 0, 50, 50], score: 0.9, dim: 512, scale, bytes };
  };
  function seedFaces(db, n) {
    const ids = seed(db, n);
    ids.forEach((id, i) =>
      putFaces(db, { photoId: id, model: MODEL, faces: [face(i)] })
    );
    return db
      .prepare(`SELECT id FROM photo_faces ORDER BY id`)
      .all()
      .map((r) => r.id);
  }

  it("merges two people and SURVIVES the next grouping pass", () => {
    // The whole point. Without the manual mark the next pass undoes the
    // merge and the user does it again, and again -- worse than not
    // offering it at all.
    const db = getDb();
    const f = seedFaces(db, 4);
    saveClusters(
      db,
      [
        [f[0], f[1]],
        [f[2], f[3]],
      ],
      { model: MODEL }
    );
    const [a, b] = listPersons(db);

    const r = mergePersons(db, a.id, b.id);
    expect(r.moved).toBe(2);
    expect(listPersons(db)).toHaveLength(1);
    expect(listPersons(db)[0].faces).toBe(4);

    // The model changes its mind and proposes the ORIGINAL split again.
    saveClusters(
      db,
      [
        [f[0], f[1]],
        [f[2], f[3]],
      ],
      { model: MODEL }
    );
    expect(listPersons(db).some((p) => p.faces === 4)).toBe(true);
  });

  it("keeps a name when merging an unnamed person into a named one, and vice versa", () => {
    const db = getDb();
    const f = seedFaces(db, 4);
    saveClusters(
      db,
      [
        [f[0], f[1]],
        [f[2], f[3]],
      ],
      { model: MODEL }
    );
    const [a, b] = listPersons(db);
    renamePerson(db, b.id, "Ana");

    // Merge the NAMED one into the unnamed one: the name must not vanish.
    const r = mergePersons(db, a.id, b.id);
    expect(r.name).toBe("Ana");
    expect(listPersons(db)[0].name).toBe("Ana");
  });

  it("refuses to merge a person into themselves, or a stranger", () => {
    const db = getDb();
    const f = seedFaces(db, 2);
    saveClusters(db, [[f[0], f[1]]], { model: MODEL });
    const [a] = listPersons(db);
    expect(() => mergePersons(db, a.id, a.id)).toThrow(/into themselves/);
    expect(() => mergePersons(db, a.id, 9999)).toThrow(/no such person/);
  });

  it("detaches a face and the next pass does not put it back", () => {
    // The correction that matters when clustering OVER-merges: a stranger
    // inside someone's photo set.
    const db = getDb();
    const f = seedFaces(db, 3);
    saveClusters(db, [[f[0], f[1], f[2]]], { model: MODEL });
    expect(listPersons(db)[0].faces).toBe(3);

    detachFace(db, f[2]);
    expect(listPersons(db)[0].faces).toBe(2);

    saveClusters(db, [[f[0], f[1], f[2]]], { model: MODEL });
    const still = db
      .prepare(`SELECT person_id FROM photo_faces WHERE id = ?`)
      .get(f[2]);
    expect(still.person_id).toBe(null);
  });

  it("refuses to detach a face that does not exist", () => {
    expect(() => detachFace(getDb(), 9999)).toThrow(/no such face/);
  });
});

describe("saveClusters is scoped and deliberate", () => {
  /** Score is separate from the vector seed here, so id order and confidence
   *  order can be made to DISAGREE -- the only arrangement that can tell
   *  "first member" from "best member" apart. */
  const face = (seedVal, score = 0.9) => {
    const v = new Float32Array(512);
    for (let i = 0; i < 512; i++) v[i] = Math.sin(i * 0.1 + seedVal);
    const { scale, bytes } = quantize(v);
    return { box: [0, 0, 50, 50], score, dim: 512, scale, bytes };
  };

  it("covers a person with their most CONFIDENT face, not their oldest", () => {
    // clusterFaces returns members in faceVectors' order, which is ORDER BY
    // id -- so "the first member" is the oldest face, not the best one. The
    // comment claimed otherwise for the whole of this branch. A cover chosen
    // effectively at random is how someone ends up represented by the back of
    // their head.
    const db = getDb();
    const ids = seed(db, 3);
    ids.forEach((id, i) =>
      putFaces(db, {
        photoId: id,
        model: MODEL,
        // The LAST face is the confident one, so id order and score order
        // disagree -- which is the only arrangement that can tell them apart.
        faces: [face(i, 0.5 + i * 0.2)],
      })
    );
    const f = db
      .prepare(`SELECT id FROM photo_faces ORDER BY id`)
      .all()
      .map((r) => r.id);

    saveClusters(db, [f], { model: MODEL });
    expect(listPersons(db)[0].coverFaceId).toBe(f[2]);
  });

  it("does not clear another model's people", () => {
    // Everything else in this file is keyed by model, because a buffalo_s
    // vector and a buffalo_l vector describe different spaces. saveClusters
    // cleared person_id across ALL of them, so grouping under one pack wiped
    // the other's assignments -- silently, since the two never appear on
    // screen together.
    const db = getDb();
    const ids = seed(db, 2);
    ids.forEach((id, i) => {
      putFaces(db, {
        photoId: id,
        model: MODEL,
        faces: [face(i)],
      });
      putFaces(db, {
        photoId: id,
        model: "buffalo_s",
        faces: [face(i)],
      });
    });
    const idsOf = (m) =>
      db
        .prepare(`SELECT id FROM photo_faces WHERE model = ? ORDER BY id`)
        .all(m)
        .map((r) => r.id);

    saveClusters(db, [idsOf("buffalo_s")], { model: "buffalo_s" });
    const small = listPersons(db)[0];
    expect(small.faces).toBe(2);

    // Now group the OTHER pack. buffalo_s's person must be untouched.
    saveClusters(db, [idsOf(MODEL)], { model: MODEL });
    const after = listPersons(db).find((p) => p.id === small.id);
    expect(after.faces).toBe(2);
  });

  it("refuses to run without a model rather than clearing everything", () => {
    expect(() => saveClusters(getDb(), [])).toThrow(/needs a model/);
  });
});
