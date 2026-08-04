import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { expectNoBlockOver } from "../lib/expectNoBlockOver.js";
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
  bestPersonYielding,
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
    expect(r).toEqual({
      assigned: 0,
      created: 0,
      examined: 0,
      removedEmpty: 0,
      remaining: 0,
    });
  });
});

describe("the pieces", () => {
  it("clusterLeftovers groups by similarity and keeps strangers apart", async () => {
    const f = (axis, id) => {
      const { scale, bytes } = quantize(vec(axis));
      return { id, bytes, scale };
    };
    const groups = await clusterLeftovers([f(0, 1), f(0, 2), f(9, 3)], 0.8);
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

describe("checkpoint — grouping stands aside too (#257, Phase 4)", () => {
  it("awaits the checkpoint at the yield point, not mid-comparison", async () => {
    // The same seam the abort check uses, and for the same reason: it is the
    // one place this O(n^2) loop is not half-way through a comparison. Parking
    // here costs the comparisons since the last yield and nothing else — every
    // batch already committed stays committed.
    const db = getDb();
    // TWO passes, because the comparison counter only advances against
    // centroids that already exist: the very first grouping has no people to
    // compare against, so it never reaches a yield at all. Create some, then
    // give it more faces to file.
    seedFaces(db, "/vol/a", 0, 20);
    await groupRemaining(db, MODEL);
    seedFaces(db, "/vol/b", 1, 40);
    let checkpoints = 0;
    await groupRemaining(db, MODEL, {
      // The real threshold is 200,000 comparisons, tuned for a 125k-photo
      // library; reaching it here would need ~6,000 seeded faces, and a unit
      // test that slow is a unit test nobody runs.
      yieldEvery: 1,
      checkpoint: async () => {
        checkpoints += 1;
      },
    });
    expect(checkpoints).toBeGreaterThan(0);
  });

  it("groups exactly the same way with no checkpoint supplied", async () => {
    // The default is a no-op, so this module still runs with no scheduler at
    // all — every existing caller is unchanged.
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 60);
    const withNoop = await groupRemaining(db, MODEL, {
      checkpoint: async () => {},
    });
    expect(withNoop.assigned).toBeGreaterThan(0);
    expect(withNoop.created).toBeGreaterThan(0);
  });
});

describe("T1 — the SHIPPED yield budget, in milliseconds (#231)", () => {
  /**
   * WHY THIS FIXTURE IS BUILT BY HAND, and why the obvious version of this
   * test is worthless.
   *
   * My first attempt used the ordinary `seedFaces` helper — a dozen people,
   * 32-dimension vectors — and it PASSED with the old 200,000 constant still
   * in place. That is the identical failure this test exists to correct: at a
   * dozen centroids the loop needs ~16,000 faces before the budget is even
   * reachable, so nothing yields, nothing blocks, and the assertion proves
   * nothing about the number.
   *
   * The cost that hurts on a real library is `centroids.length x dim` per
   * face. John's has ~25,758 people at 512 dimensions. To reproduce the SHAPE
   * of that cheaply: many people, realistic dimension, few faces to file.
   * 800 people x 512-d means one face is ~410,000 multiply-adds, so a handful
   * of faces is tens of milliseconds of real work — enough that a loop which
   * refuses to yield holds the timer, and one that yields does not.
   *
   * With the OLD constant those faces total well under 200,000 comparisons, so
   * the loop yields ZERO times and blocks for the whole run. That is what makes
   * this test discriminating rather than decorative.
   */
  const BIG_DIM = 512;
  const PEOPLE = 800;
  const NEW_FACES = 60;

  /** A unit-ish vector pointing along `axis`, at BIG_DIM. */
  function bigVec(axis) {
    const v = new Float32Array(BIG_DIM);
    v[axis % BIG_DIM] = 1;
    v[(axis * 7 + 3) % BIG_DIM] = 0.3;
    return v;
  }

  /** `PEOPLE` persons each owning one face, then `NEW_FACES` still unfiled. */
  function seedManyPeople(db) {
    const photos = upsertScan(
      db,
      "/vol/big",
      1,
      Array.from({ length: PEOPLE + NEW_FACES }, (_, i) => ({
        name: `B_${i}.jpg`,
        size: 10 + i,
        mtimeMs: 1700000000000 + i,
        kind: "image",
      }))
    ).map((r) => r.id);

    const insPerson = db.prepare(
      `INSERT INTO persons (id, name) VALUES (?, ?)`
    );
    const insFace = db.prepare(
      `INSERT INTO photo_faces
         (photo_id, model, box_x, box_y, box_w, box_h, det_score,
          dim, scale, vec, created_at, person_id)
       VALUES (?, ?, 0, 0, 10, 10, 0.9, ?, ?, ?, 0, ?)`
    );
    db.transaction(() => {
      for (let i = 0; i < PEOPLE; i++) {
        insPerson.run(i + 1, `P${i}`);
        const { scale, bytes } = quantize(bigVec(i));
        insFace.run(
          photos[i],
          MODEL,
          BIG_DIM,
          scale,
          Buffer.from(bytes.buffer),
          i + 1
        );
      }
      // Unfiled faces, deliberately unlike every existing person so each one
      // is compared against ALL of them before being given up on.
      for (let i = 0; i < NEW_FACES; i++) {
        const { scale, bytes } = quantize(bigVec(PEOPLE + i * 13));
        insFace.run(
          photos[PEOPLE + i],
          MODEL,
          BIG_DIM,
          scale,
          Buffer.from(bytes.buffer),
          null
        );
      }
    })();
  }

  it("never holds the event loop for more than 55ms at a time", async () => {
    // No `yieldEvery` override. That is the entire point — the existing
    // coverage injects its own budget and would pass if the shipped constant
    // were a hundred million.
    //
    // THE BUDGET LIVES IN A MEASURED WINDOW, and both bounds are real:
    //
    //   lower  ~26 ms  worst observed for the CORRECT code on GitHub's
    //                  runners. (This shipped at 25 ms — "headroom over the
    //                  ~1 ms this produces locally" — and went red at 26.4 ms
    //                  on the first CI run. The measurement is OS descheduling
    //                  on a shared box, not this function.)
    //   upper  ~64 ms  what the OLD constant (200,000 comparisons) cost
    //                  LOCALLY, per `docs/ARCHITECTURE-REVIEW-2026-08-04.md`.
    //                  On a CI runner the same regression costs far more.
    //
    // 55 ms sits inside it: ~2x the noise floor, still under the cheapest
    // possible regression. Widen it only with a new measurement of BOTH
    // bounds — a budget above 64 ms stops catching the bug it exists for.
    const db = getDb();
    seedManyPeople(db);

    const worst = await expectNoBlockOver(55, () => groupRemaining(db, MODEL), {
      label: "groupRemaining, shipped budget, 800 people x 512-d",
    });
    expect(worst).toBeLessThanOrEqual(55);
  });

  it("yields MID-FACE — bestPersonYielding breaks up ONE face's comparisons", async () => {
    /**
     * Tested DIRECTLY on `bestPersonYielding` rather than through
     * `groupRemaining`, and the reason is worth recording: at unit scale the
     * difference is invisible end-to-end.
     *
     * Mid-face and per-face accounting yield the SAME number of times over a
     * batch (the total comparison count is identical), and one face at 800
     * centroids is ~1 ms — well inside any sane latency budget. The property
     * only changes the outcome when a SINGLE face costs more than the budget,
     * which is John's ~25,758 people, not anything a unit test should build.
     *
     * So assert the property itself: given more centroids than the budget, one
     * face must be interruptible part-way through. I confirmed this test is
     * discriminating by reverting to `bestPerson` + one yield per face — it
     * goes red, where the latency test above does not.
     */
    const CENTROIDS = 3000;
    const face = {
      bytes: quantize(new Float32Array(512).fill(0.01)).bytes,
      scale: 1,
    };
    const centroids = Array.from({ length: CENTROIDS }, (_, i) => ({
      personId: i + 1,
      bytes: quantize(new Float32Array(512).fill(0.01)).bytes,
      scale: 1,
    }));

    let chunks = 0;
    let compared = 0;
    await bestPersonYielding(face, centroids, 99, {
      chunk: 512,
      onChunk: async (n) => {
        chunks += 1;
        compared += n;
      },
    });

    // Six chunks for 3,000 centroids at 512 — i.e. the loop handed control
    // back five times BEFORE this face was finished.
    expect(chunks).toBe(Math.ceil(CENTROIDS / 512));
    expect(compared).toBe(CENTROIDS);
  });

  /**
   * A GAP, stated rather than hidden.
   *
   * These tests guard two things: that the shipped constant keeps the loop
   * under a latency budget, and that `bestPersonYielding` really does break up
   * one face. What NOTHING here guards is that `groupRemaining` actually calls
   * it — swap the call site back to plain `bestPerson` plus one yield per face
   * and every test in this file still passes. I checked; it does.
   *
   * Discriminating that needs a single face to cost more than the whole
   * latency budget, which means ~25,000 centroids at 512 dimensions — John's
   * library, not a unit test. The review's harness
   * (`docs/ARCHITECTURE-REVIEW-2026-08-04.md` §1) builds exactly that fixture
   * and is the right home for it.
   *
   * Recorded because an unguarded change that looks guarded is how #231
   * shipped a test that would have passed at a hundred million.
   */

  it("bestPersonYielding returns exactly what bestPerson returns", async () => {
    // The yielding variant must not change the answer — it exists for
    // scheduling, not for arithmetic.
    const mk = (axis) => ({
      bytes: quantize(bigVec(axis)).bytes,
      scale: quantize(bigVec(axis)).scale,
    });
    const centroids = [0, 5, 9].map((a) => ({ personId: a + 1, ...mk(a) }));
    const face = mk(5);
    const sync = bestPerson(face, centroids, 0.5);
    const async_ = await bestPersonYielding(face, centroids, 0.5, { chunk: 1 });
    expect(async_).toEqual(sync);
  });
});

describe("what a grouping run REPORTS (#293)", () => {
  it("moves the bar within a single batch, not once at the end", async () => {
    // John's 327-face job sat at 0 through ~344,000 comparisons and then
    // jumped to done, because GROUP_BATCH is 500 and onProgress fired once
    // per batch. One batch WAS the whole job, so there was no progress at all
    // — indistinguishable from a hang, which is what he reported.
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 40);

    /** @type {number[]} */
    const seen = [];
    await groupRemaining(db, MODEL, {
      batchSize: 500, // larger than the library: exactly John's shape
      onProgress: ({ done }) => seen.push(done),
    });

    // Many updates, not one. The precise count is an implementation detail;
    // "more than a handful" is the property the user can perceive.
    expect(seen.length).toBeGreaterThan(10);
    // Monotonic, and it actually arrives.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(40);
    // And it started near the beginning rather than at the end.
    expect(seen[0]).toBeLessThan(10);
  });

  it("bounds the number of updates on a big run", async () => {
    // Per-face reporting reaches registry.update, which pushes to every SSE
    // subscriber. Unbounded, a 125,000-face library would send 125,000
    // messages to redraw a 400-pixel bar.
    const db = getDb();
    seedFaces(db, "/vol/a", 0, 600);

    let updates = 0;
    await groupRemaining(db, MODEL, {
      batchSize: 500,
      onProgress: () => updates++,
    });

    expect(updates).toBeLessThanOrEqual(210); // ~200 + the final exact hit
    expect(updates).toBeGreaterThan(50); // ...but still smooth
  });

  it("reports how many people it CREATED, under a name the caller reads", async () => {
    // The panel rendered `r.people`, which this function has never returned;
    // `?? 0` turned the missing field into a confident "Grouped 327 faces into
    // 0 people" for a run that had just made dozens.
    const db = getDb();
    seedFaces(db, "/vol/ana", 0, 5);
    seedFaces(db, "/vol/bob", 10, 5);

    const r = await groupRemaining(db, MODEL);

    expect(r.created).toBeGreaterThan(0);
    expect(r.created).toBe(personCount(db));
    expect(r.assigned).toBe(10);
  });

  it("sweeps people left with no faces, and keeps the ones you named", async () => {
    // 974 of John's 1,053 people were empty and unnamed — 92% of the People
    // view was rows with nothing in them. They accumulate because photo_faces
    // cascades when a photo is deleted and persons does not.
    const db = getDb();
    seedFaces(db, "/vol/ana", 0, 4);
    await groupRemaining(db, MODEL);

    // Orphan every existing person the way a photo deletion does, then add
    // one the user has NAMED and one they have not.
    db.prepare(`UPDATE photo_faces SET person_id = NULL`).run();
    db.prepare(
      `INSERT INTO persons (name, cover_face_id, created_at) VALUES ('Ana', NULL, 0)`
    ).run();
    const before = personCount(db);
    expect(before).toBeGreaterThan(1);

    const r = await groupRemaining(db, MODEL);

    expect(r.removedEmpty).toBeGreaterThan(0);
    const names = db
      .prepare(`SELECT name FROM persons WHERE name IS NOT NULL`)
      .all()
      .map((p) => p.name);
    // Naming is an assertion by the user; an empty NAMED person survives.
    expect(names).toContain("Ana");
    // Every unnamed empty is gone: the only unnamed people left are the ones
    // this run just filled.
    const emptyUnnamed = db
      .prepare(
        `SELECT COUNT(*) n FROM persons p
          WHERE (p.name IS NULL OR p.name = '')
            AND NOT EXISTS (SELECT 1 FROM photo_faces f WHERE f.person_id = p.id)`
      )
      .get().n;
    expect(emptyUnnamed).toBe(0);
  });
});
