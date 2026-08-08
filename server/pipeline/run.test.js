import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import {
  runPipeline,
  nextCohort,
  cohortSize,
  totalWorkMs,
  COHORT_MIN,
  COHORT_MAX,
} from "./run.js";

const MODELS = { model: "m", faceModel: "fm" };

let cacheDir;
let db;

function seed(n) {
  db.prepare(
    `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
     VALUES (1, 'v', 'uuid-1', '/t', ?)`
  ).run(Date.now());
  return upsertScan(
    db,
    "/vol/a",
    1,
    Array.from({ length: n }, (_, i) => ({
      name: `p${i}.jpg`,
      size: 10,
      mtimeMs: 1000 + i,
      kind: "image",
    }))
  ).map((r) => r.id);
}

/** Mark ids as no longer pending for meta, the way enrichBatch would. */
const finishMeta = (ids) =>
  db
    .prepare(
      `UPDATE photos SET width = 1, height = 1, gps_checked = 1
        WHERE id IN (${ids.join(",")})`
    )
    .run();
/** ...and for hash. */
const finishHash = (ids) =>
  db
    .prepare(
      `UPDATE photos SET content_hash = 'x' WHERE id IN (${ids.join(",")})`
    )
    .run();

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-run-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  db = getDb();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("cohortSize — a TIME budget, not a photo count (D1)", () => {
  it("shrinks as the enabled stages get more expensive", () => {
    // The felt rhythm is constant whatever is on: ~20s of work either way.
    const cheap = cohortSize(["meta", "hash"]);
    const dear = cohortSize(["meta", "hash", "embed", "faces"]);
    expect(cheap).toBeGreaterThan(dear);
    expect(dear).toBeGreaterThanOrEqual(COHORT_MIN);
  });

  it("clamps, so a wrong cost cannot produce an absurd cohort", () => {
    // A 1-photo cohort would run the (full-scan) cohort query per photo; a
    // 100k one would defeat the whole point of showing progress.
    expect(cohortSize(["faces"], { faces: 10_000_000 })).toBe(COHORT_MIN);
    expect(cohortSize(["meta"], { meta: 0.000001 })).toBe(COHORT_MAX);
    expect(cohortSize([])).toBe(COHORT_MAX);
  });
});

describe("totalWorkMs — the bar counts WORK, not photos (§4.2)", () => {
  it("weights each stage by its real cost", () => {
    // Stages differ ~25x, so a photo-counting bar would sprint through
    // metadata and crawl through faces.
    const cov = { stages: { meta: { pending: 100 }, faces: { pending: 10 } } };
    const ms = totalWorkMs(cov, ["meta", "faces"], { meta: 1, faces: 100 });
    expect(ms).toBe(100 * 1 + 10 * 100);
  });

  it("ignores stages that are not enabled", () => {
    const cov = { stages: { meta: { pending: 5 }, faces: { pending: 999 } } };
    expect(totalWorkMs(cov, ["meta"], { meta: 2, faces: 100 })).toBe(10);
  });
});

describe("nextCohort — no cursor, the database IS the checkpoint", () => {
  it("returns photos pending in ANY enabled stage", () => {
    const ids = seed(5);
    expect(
      nextCohort(db, { stageIds: ["meta", "hash"], limit: 10, ...MODELS })
    ).toEqual(ids);
  });

  it("stops returning a photo once every enabled stage is done with it", () => {
    // This is what makes a run resumable with nothing saved: finishing work
    // removes the row from the worklist, so the next call naturally advances.
    const ids = seed(4);
    finishMeta(ids.slice(0, 2));
    finishHash(ids.slice(0, 2));
    expect(
      nextCohort(db, { stageIds: ["meta", "hash"], limit: 10, ...MODELS })
    ).toEqual(ids.slice(2));
  });

  it("still returns a photo that is done in ONE stage but not another", () => {
    const ids = seed(3);
    finishMeta(ids);
    expect(
      nextCohort(db, { stageIds: ["meta", "hash"], limit: 10, ...MODELS })
    ).toEqual(ids);
    expect(
      nextCohort(db, { stageIds: ["meta"], limit: 10, ...MODELS })
    ).toEqual([]);
  });

  it("honours the scope, and an EMPTY scope means zero photos", () => {
    const ids = seed(5);
    expect(
      nextCohort(db, {
        stageIds: ["hash"],
        scopeIds: [ids[0], ids[2]],
        limit: 10,
        ...MODELS,
      })
    ).toEqual([ids[0], ids[2]]);
    // Never "all of them" — the expensive direction.
    expect(
      nextCohort(db, { stageIds: ["hash"], scopeIds: [], limit: 10, ...MODELS })
    ).toEqual([]);
  });
});

describe("runPipeline — one process, every enabled stage", () => {
  /** Runners that actually clear the pending predicate, so the loop can end. */
  const realish = () => ({
    meta: async ({ ids }) => {
      finishMeta(ids);
      return { done: ids.length };
    },
    hash: async ({ ids }) => {
      finishHash(ids);
      return { done: ids.length };
    },
  });

  it("carries every photo through every enabled stage", async () => {
    const ids = seed(7);
    const r = await runPipeline({
      db,
      stageIds: ["meta", "hash"],
      runners: realish(),
      ...MODELS,
    });
    expect(r.photos).toBe(7);
    expect(r.counts.meta.done).toBe(7);
    expect(r.counts.hash.done).toBe(7);
    expect(
      nextCohort(db, { stageIds: ["meta", "hash"], limit: 10, ...MODELS })
    ).toEqual([]);
    expect(ids.length).toBe(7);
  });

  it("takes several cohorts when the scope exceeds one", async () => {
    seed(6);
    const r = await runPipeline({
      db,
      stageIds: ["meta", "hash"],
      runners: realish(),
      cost: { meta: 5000, hash: 5000 }, // forces the clamp to COHORT_MIN
      ...MODELS,
    });
    expect(r.photos).toBe(6);
    expect(r.cohorts).toBeGreaterThanOrEqual(1);
  });

  it("STANDS A STAGE DOWN without stopping the run (§4.6)", async () => {
    // A missing face model must not stop hashing. The stage is recorded with
    // its reason and skipped for the rest of the run; everything else finishes.
    seed(4);
    const r = await runPipeline({
      db,
      stageIds: ["meta", "hash"],
      runners: {
        meta: async () => {
          throw new Error("model not downloaded");
        },
        hash: async ({ ids }) => {
          finishHash(ids);
          return { done: ids.length };
        },
      },
      ...MODELS,
    });
    expect(r.stalled).toEqual([{ id: "meta", reason: "model not downloaded" }]);
    expect(r.counts.hash.done).toBe(4);
  });

  it("treats a paused stage the same way — a host condition, not a photo", async () => {
    seed(3);
    const r = await runPipeline({
      db,
      stageIds: ["meta", "hash"],
      runners: {
        meta: async () => ({
          paused: true,
          pauseReason: "drive not available",
        }),
        hash: async ({ ids }) => {
          finishHash(ids);
          return { done: ids.length };
        },
      },
      ...MODELS,
    });
    expect(r.stalled[0]).toEqual({
      id: "meta",
      reason: "drive not available",
    });
    expect(r.counts.hash.done).toBe(3);
  });

  it("ends the run when EVERY stage has stood down, rather than spinning", async () => {
    // Otherwise the cohort query keeps returning the same photos forever with
    // nothing able to clear them — a hang with no error anywhere.
    seed(3);
    const r = await runPipeline({
      db,
      stageIds: ["meta", "hash"],
      runners: {
        meta: async () => ({ paused: true, pauseReason: "a" }),
        hash: async () => ({ paused: true, pauseReason: "b" }),
      },
      ...MODELS,
    });
    expect(r.stalled.map((s) => s.id).sort()).toEqual(["hash", "meta"]);
  });

  it("stops on cancel and KEEPS what it finished", async () => {
    // "It keeps what it finishes" is the property that makes stopping safe to
    // do; every stage commits per batch, so a cancel discards nothing.
    seed(10);
    const controller = new AbortController();
    let cohorts = 0;
    const r = await runPipeline({
      db,
      stageIds: ["hash"],
      runners: {
        hash: async ({ ids }) => {
          finishHash(ids);
          cohorts += 1;
          if (cohorts === 1) controller.abort();
          return { done: ids.length };
        },
      },
      cost: { hash: 5000 }, // small cohorts, so there is a second one to skip
      signal: controller.signal,
      ...MODELS,
    });
    expect(r.canceled).toBe(true);
    expect(r.counts.hash.done).toBeGreaterThan(0);
    // The work that DID happen is still on disk.
    const hashed = db
      .prepare(`SELECT COUNT(*) n FROM photos WHERE content_hash IS NOT NULL`)
      .get().n;
    expect(hashed).toBe(r.counts.hash.done);
  });

  it("stops at the checkpoint when the cancel arrived while it was parked (#344)", async () => {
    // What this actually costs is worth stating precisely, because it is NOT
    // the same as sweep.js's version of the same fix. A third abort check
    // inside the stage loop (`for (const stage of live)`) already stops the
    // runners, so no photo is processed either way. What the missing check
    // costs is a `nextCohort` query nobody wanted and, worse, `cohorts` and
    // `photos` incremented for a cohort that never ran — numbers the job
    // REPORTS. A cancelled scan claiming it got through 10 photos it never
    // touched is the "reported success" shape this repo keeps finding.
    //
    // So the assertions are on the returned counts, not on the runner: with
    // the check removed the runner is still never called, and a test watching
    // only that would pass while the counts lied.
    seed(10);
    const controller = new AbortController();
    let cohorts = 0;
    const r = await runPipeline({
      db,
      stageIds: ["hash"],
      runners: {
        hash: async ({ ids }) => {
          finishHash(ids);
          cohorts += 1;
          return { done: ids.length };
        },
      },
      cost: { hash: 5000 },
      // Stands in for "the user pressed Stop while this was parked": the
      // scheduler returns from a park rather than throwing, so this loop has to
      // notice for itself.
      checkpoint: async () => controller.abort(),
      signal: controller.signal,
      ...MODELS,
    });
    // The counts it REPORTS describe work it actually did.
    expect(r.cohorts).toBe(0);
    expect(r.photos).toBe(0);
    expect(r.counts.hash.done).toBe(0);
    expect(cohorts).toBe(0);
    // ...and it still reports the cooperative outcome with its counts, rather
    // than throwing — the property that made a returning checkpoint the right
    // choice for this loop.
    expect(r.canceled).toBe(true);
  });

  it("reports progress in MILLISECONDS of work, not photos", async () => {
    seed(4);
    const seen = [];
    await runPipeline({
      db,
      stageIds: ["meta", "hash"],
      runners: realish(),
      cost: { meta: 10, hash: 1 },
      onProgress: (p) => seen.push(p.doneMs),
      ...MODELS,
    });
    // 4 photos x 10ms + 4 x 1ms
    expect(seen.at(-1)).toBe(44);
    // ...and it only ever goes up.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("awaits the checkpoint each cohort, so a scoped request can preempt it", async () => {
    seed(3);
    let checkpoints = 0;
    await runPipeline({
      db,
      stageIds: ["hash"],
      runners: realish(),
      checkpoint: async () => {
        checkpoints += 1;
      },
      ...MODELS,
    });
    expect(checkpoints).toBeGreaterThan(0);
  });

  it("does nothing at all for an empty scope", async () => {
    seed(5);
    let ran = false;
    const r = await runPipeline({
      db,
      stageIds: ["hash"],
      runners: {
        hash: async () => {
          ran = true;
          return { done: 0 };
        },
      },
      scopeIds: [],
      ...MODELS,
    });
    expect(ran).toBe(false);
    expect(r.photos).toBe(0);
  });
});
