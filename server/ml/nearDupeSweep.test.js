import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan, deletePhotosByIds } from "../db/photos.js";
import { putEmbedding } from "../db/embeddings.js";
import { nearDupeCounts } from "../db/nearDupes.js";
import { quantize } from "./quantize.js";
import { groupNearDupes, _resetNearDupeSweepForTest } from "./nearDupeSweep.js";

/**
 * The near-duplicate grouping pass (#162).
 *
 * These use SYNTHETIC vectors, deliberately: the question here is whether the
 * windowing, the transitivity, the thresholding and the wholesale replacement
 * behave, and a hand-built vector pair lets a test state "these two are 0.99
 * apart" as a fact rather than a hope. Whether the MODEL's real vectors
 * actually separate a burst from an unrelated photo is a different question,
 * answered against real photographs in embeddingSimilarity.test.js.
 */

const MODEL = "Xenova/siglip-base-patch16-224";
const DIM = 8;
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-neardupe-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  _resetNearDupeSweepForTest();
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
 * Photos at explicit capture times, each with a vector built from `angle`.
 * Two photos sharing an angle are identical (cosine 1.0); the further apart
 * their angles, the lower the cosine — so a test can place a pair either side
 * of a threshold by choosing angles, with no magic numbers.
 */
function seedWithVectors(specs) {
  const db = getDb();
  const files = specs.map((s, i) => ({
    name: `IMG_${i}.jpg`,
    size: 1000 + i,
    mtimeMs: s.time,
    kind: "image",
  }));
  const ids = upsertScan(db, "/vol/Trip", 1, files).map((r) => r.id);
  ids.forEach((id, i) => {
    // taken_at is what the sweep orders by (COALESCE(taken_at, btime, mtime)),
    // so set it explicitly rather than relying on mtime surviving upsertScan.
    db.prepare(`UPDATE photos SET taken_at = ? WHERE id = ?`).run(
      specs[i].time,
      id
    );
    const { scale, bytes } = quantize(unit(specs[i].angle));
    putEmbedding(db, { photoId: id, model: MODEL, dim: DIM, scale, bytes });
  });
  return ids;
}

/** A unit vector in the plane spanned by two axes; cosine between two of them
 *  is exactly cos(angleA - angleB). */
function unit(angle) {
  const v = new Float32Array(DIM);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

/** photoId → groupId, for the assertions below. */
function grouping(ids) {
  const db = getDb();
  const out = new Map();
  for (const id of ids) {
    const row = db
      .prepare(`SELECT group_id FROM near_dupe_groups WHERE photo_id = ?`)
      .get(id);
    if (row) out.set(id, row.group_id);
  }
  return out;
}

const run = (opts) =>
  groupNearDupes(getDb(), {
    model: MODEL,
    windowMs: 60_000,
    idle: async () => {},
    ...opts,
  });

describe("groupNearDupes", () => {
  it("groups two near-identical photos taken close together", async () => {
    const ids = seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 2000, angle: 0.01 },
    ]);
    const res = await run({ threshold: 0.9 });

    expect(res.groups).toBe(1);
    expect(res.photos).toBe(2);
    const g = grouping(ids);
    expect(g.get(ids[0])).toBe(g.get(ids[1]));
  });

  it("does not group a similar pair taken outside the window", async () => {
    // Identical vectors — only the time separation keeps them apart. This is
    // the whole "accepted cost" of the time-windowed ruling, asserted.
    const ids = seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 5_000_000, angle: 0 },
    ]);
    const res = await run({ threshold: 0.9 });

    expect(res.groups).toBe(0);
    expect(grouping(ids).size).toBe(0);
  });

  it("does not group a dissimilar pair taken close together", async () => {
    // The mirror case: adjacent in time, but a right angle apart in meaning
    // (cosine 0). Time proximity alone must never be enough.
    const ids = seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 2000, angle: Math.PI / 2 },
    ]);
    const res = await run({ threshold: 0.9 });

    expect(res.groups).toBe(0);
    expect(grouping(ids).size).toBe(0);
  });

  it("is transitive: A~B and B~C put all three in one group", async () => {
    // A and C are 0.6 rad apart (cosine ~0.825) — BELOW the threshold, so they
    // never match directly. They still belong together because B bridges them,
    // which is what keeps a burst that drifts across its own span from
    // splitting into two stacks.
    const ids = seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 2000, angle: 0.3 },
      { time: 3000, angle: 0.6 },
    ]);
    expect(Math.cos(0.6)).toBeLessThan(0.9); // the direct pair really is below
    const res = await run({ threshold: 0.9 });

    expect(res.groups).toBe(1);
    expect(res.photos).toBe(3);
    const g = grouping(ids);
    expect(new Set(g.values()).size).toBe(1);
  });

  it("bridges a burst across an intruding photo of a different subject", async () => {
    // Frame, intruder, frame. The intruder is not similar to either, but it
    // sits between them in time — comparing only against the immediately
    // preceding photo would break the chain and split one group into two.
    const ids = seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 2000, angle: Math.PI / 2 },
      { time: 3000, angle: 0.01 },
    ]);
    const res = await run({ threshold: 0.9 });

    expect(res.groups).toBe(1);
    const g = grouping(ids);
    expect(g.get(ids[0])).toBe(g.get(ids[2]));
    expect(g.has(ids[1])).toBe(false); // the intruder joins nothing
  });

  it("stores nothing for a photo that matched no one", async () => {
    seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 2000, angle: Math.PI / 2 },
      { time: 3000, angle: Math.PI },
    ]);
    const res = await run({ threshold: 0.9 });

    expect(res.photos).toBe(0);
    expect(nearDupeCounts(getDb(), MODEL)).toEqual({ photos: 0, groups: 0 });
  });

  it("replaces the previous grouping wholesale rather than accumulating", async () => {
    const ids = seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 2000, angle: 0.01 },
    ]);
    await run({ threshold: 0.9 });
    expect(nearDupeCounts(getDb(), MODEL).photos).toBe(2);

    // Re-run with a threshold nothing can meet: the old rows must go, not
    // linger. A grouping left behind after the rule that produced it changed
    // would keep stacking photos by a rule no longer in force.
    const res = await run({ threshold: 0.999999 });
    expect(res.photos).toBe(0);
    expect(nearDupeCounts(getDb(), MODEL).photos).toBe(0);
    expect(grouping(ids).size).toBe(0);
  });

  it("leaves the stored grouping untouched when cancelled", async () => {
    const ids = seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 2000, angle: 0.01 },
    ]);
    await run({ threshold: 0.9 });

    const res = await run({ threshold: 0.9, job: { cancelled: true } });
    expect(res.cancelled).toBe(true);
    // Partial work must not be written: half a grouping is not a smaller
    // answer, it is a wrong one, and indistinguishable from a real result.
    expect(grouping(ids).size).toBe(2);
  });

  it("refuses to start a second pass while one is running", async () => {
    seedWithVectors([{ time: 1000, angle: 0 }]);
    let release;
    const gate = new Promise((r) => (release = r));
    const first = run({ threshold: 0.9, idle: () => gate });

    const second = await run({ threshold: 0.9 });
    expect(second.alreadyRunning).toBe(true);

    release();
    await first;
  });

  it("respects the model's own default threshold when none is given", async () => {
    // 0.93 for SigLIP (models.js). A pair at cosine ~0.955 clears it; the
    // point is that omitting `threshold` resolves to the model's value rather
    // than to some hidden global.
    const ids = seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 2000, angle: 0.3 },
    ]);
    expect(Math.cos(0.3)).toBeGreaterThan(0.93);
    expect(Math.cos(0.3)).toBeLessThan(0.96);
    const res = await run({});

    expect(res.groups).toBe(1);
    expect(grouping(ids).size).toBe(2);
  });
});

describe("near_dupe_groups schema", () => {
  it("lets a grouped photo be deleted, instead of throwing on the foreign key", async () => {
    // #161's Critical 1, one table over: better-sqlite3 enables
    // PRAGMA foreign_keys by default, so a child row without ON DELETE CASCADE
    // makes every `DELETE FROM photos` path in the app throw the moment a
    // photo lands in a group.
    const ids = seedWithVectors([
      { time: 1000, angle: 0 },
      { time: 2000, angle: 0.01 },
    ]);
    await run({ threshold: 0.9 });
    expect(nearDupeCounts(getDb(), MODEL).photos).toBe(2);

    expect(() => deletePhotosByIds(getDb(), ids)).not.toThrow();
    expect(nearDupeCounts(getDb(), MODEL).photos).toBe(0);
  });
});
