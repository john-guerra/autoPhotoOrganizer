import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import {
  putFaces,
  saveClusters,
  listPersons,
  renamePerson,
  detachFace,
} from "../db/faces.js";
import { quantize } from "./quantize.js";
import { assignNewFaces } from "./faceAssign.js";

const MODEL = "buffalo_l";
let cacheDir;
let n = 0;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-assign-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  n = 0;
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

/** A vector pointing down one axis: same axis = the same person. */
function vec(axis, noise = 0, seed = 0) {
  const v = new Float32Array(512);
  v[axis] = 1;
  for (let i = 0; i < 512; i++) {
    if (i !== axis) v[i] = noise * Math.sin(i * 3.1 + seed * 7.7);
  }
  return v;
}

/** Add one photo holding one face on `axis`, and return its face id. */
function addFace(db, axis, { noise = 0.02, model = MODEL } = {}) {
  const i = n++;
  const [photoId] = upsertScan(db, "/vol/Trip", 1, [
    { name: `IMG_${i}.jpg`, size: 1000 + i, mtimeMs: 17e11 + i, kind: "image" },
  ]).map((r) => r.id);
  const { scale, bytes } = quantize(vec(axis, noise, i));
  putFaces(db, {
    photoId,
    model,
    faces: [{ box: [0, 0, 50, 50], score: 0.9, dim: 512, scale, bytes }],
  });
  return db
    .prepare(`SELECT id FROM photo_faces WHERE photo_id = ? AND model = ?`)
    .get(photoId, model).id;
}

const personOf = (db, faceId) =>
  db.prepare(`SELECT person_id FROM photo_faces WHERE id = ?`).get(faceId)
    .person_id;

describe("filing new faces under people who already have names (#167)", () => {
  it("adds an imported face to the named person it resembles", () => {
    // Without this the only route from a new photo to a person is a full
    // re-cluster -- the O(n^2) pass over the whole library, to file the six
    // faces that arrived this morning.
    const db = getDb();
    const a1 = addFace(db, 0);
    const a2 = addFace(db, 0);
    saveClusters(db, [[a1, a2]], { model: MODEL });
    renamePerson(db, listPersons(db)[0].id, "Ana");
    const anaId = listPersons(db)[0].id;

    const fresh = addFace(db, 0); // same person, newly imported
    const r = assignNewFaces(db, MODEL);

    expect(r).toEqual({ assigned: 1, people: 1 });
    expect(personOf(db, fresh)).toBe(anaId);
  });

  it("leaves a stranger unassigned rather than forcing the nearest person", () => {
    // A stranger inside someone's photo set is far harder to notice and undo
    // than a match that was missed, which is one click to merge.
    const db = getDb();
    const a1 = addFace(db, 0);
    saveClusters(db, [[a1]], { model: MODEL });
    renamePerson(db, listPersons(db)[0].id, "Ana");

    const stranger = addFace(db, 40);
    expect(assignNewFaces(db, MODEL)).toEqual({ assigned: 0, people: 0 });
    expect(personOf(db, stranger)).toBe(null);
  });

  it("will not grow an UNNAMED cluster", () => {
    // An unnamed cluster is the model's own guess; growing it silently
    // compounds whatever it got wrong, and there is nobody to notice. A name
    // is the user saying "this cluster is a person".
    const db = getDb();
    const a1 = addFace(db, 0);
    saveClusters(db, [[a1]], { model: MODEL }); // person exists, but unnamed

    const fresh = addFace(db, 0);
    expect(assignNewFaces(db, MODEL)).toEqual({ assigned: 0, people: 0 });
    expect(personOf(db, fresh)).toBe(null);
  });

  it("does not put back a face the user DETACHED", () => {
    // A detach is the user saying "not this person". Re-attaching it on the
    // next sweep is the undo-my-undo loop #167 warns about, and it would look
    // to the user like the button did nothing.
    const db = getDb();
    const a1 = addFace(db, 0);
    const a2 = addFace(db, 0);
    saveClusters(db, [[a1, a2]], { model: MODEL });
    renamePerson(db, listPersons(db)[0].id, "Ana");

    detachFace(db, a2);
    expect(personOf(db, a2)).toBe(null);

    assignNewFaces(db, MODEL);
    expect(personOf(db, a2)).toBe(null);
  });

  it("does not touch another model's faces", () => {
    const db = getDb();
    const a1 = addFace(db, 0);
    saveClusters(db, [[a1]], { model: MODEL });
    renamePerson(db, listPersons(db)[0].id, "Ana");

    const other = addFace(db, 0, { model: "buffalo_s" });
    expect(assignNewFaces(db, MODEL).assigned).toBe(0);
    expect(personOf(db, other)).toBe(null);
  });

  it("counts PEOPLE touched, not just faces", () => {
    // "Assigned 40" says nothing about whether that was one person or twenty.
    const db = getDb();
    const a = addFace(db, 0);
    const b = addFace(db, 20);
    saveClusters(db, [[a], [b]], { model: MODEL });
    for (const p of listPersons(db)) renamePerson(db, p.id, `P${p.id}`);

    addFace(db, 0);
    addFace(db, 0);
    addFace(db, 20);
    expect(assignNewFaces(db, MODEL)).toEqual({ assigned: 3, people: 2 });
  });

  it("is a no-op, not a crash, when nobody has been named yet", () => {
    const db = getDb();
    addFace(db, 0);
    expect(assignNewFaces(db, MODEL)).toEqual({ assigned: 0, people: 0 });
  });
});
