/**
 * The projection routes (#232).
 *
 * The half that matters is not "does it project" — `runProjection.test.js`
 * covers that — but the JOB contract around it: every refusal synchronous and
 * BEFORE any job exists, a cache hit that starts no job at all, a total set at
 * creation, and a cancellation recorded as an outcome rather than a failure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./db/connection.js";
import { upsertScan } from "./db/photos.js";
import { putFaces } from "./db/faces.js";
import { quantize } from "./ml/quantize.js";
import { withClusterLatch } from "./ml/faceClusters.js";
import {
  withProjectionLatch,
  _resetProjectionForTest,
} from "./projection/latch.js";
import { registry } from "./jobs/registry.js";
import { createApp } from "./index.js";

const MODEL = "buffalo_s";
const DIM = 16;
let cacheDir;
let srv;

/** An ML service that never loads a model — nothing here needs inference. */
function inertMl() {
  return {
    embedImages: async () => [],
    embedTexts: async () => [],
    detectFaces: async () => [],
    describeProvider: async () => ({ provider: "test" }),
    close: async () => {},
  };
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-projroutes-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  _resetProjectionForTest();
  // A real listening server on an ephemeral port + fetch, the same shape
  // api.test.js uses. The job registry is the module singleton the routes
  // themselves use.
  const app = createApp({ ml: inertMl() });
  const server = await new Promise((resolve) => {
    const sv = app.listen(0, "127.0.0.1", () => resolve(sv));
  });
  srv = {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
  getDb()
    .prepare(
      `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
       VALUES (1, 'test-volume', 'test-uuid-1', '/test', ?)`
    )
    .run(Date.now());
});

afterEach(async () => {
  await srv?.close();
  _resetDbForTest();
  _resetProjectionForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

/** `n` people with `facesEach` faces apiece, spread over distinct directions. */
function seedPeople(n, facesEach = 2) {
  const db = getDb();
  for (let p = 1; p <= n; p++) {
    const files = Array.from({ length: facesEach }, (_, i) => ({
      name: `IMG_${i}.jpg`,
      size: 1000 + i,
      mtimeMs: 1700000000000 + i,
      kind: "image",
    }));
    const photos = upsertScan(db, `/vol/p${p}`, 1, files).map((r) => r.id);
    const v = new Float32Array(DIM);
    // A distinct-but-wobbly direction per person, so the graph is not
    // degenerate and kNN has something to work with.
    for (let i = 0; i < DIM; i++) v[i] = Math.sin(i * 0.7 + p * 1.3);
    const { scale, bytes } = quantize(v);
    for (const pid of photos) {
      putFaces(db, {
        photoId: pid,
        model: MODEL,
        faces: [{ box: [0, 0, 10, 10], score: 0.9, dim: DIM, scale, bytes }],
      });
    }
    db.prepare(`INSERT INTO persons (id, name) VALUES (?, NULL)`).run(p);
    db.prepare(
      `UPDATE photo_faces SET person_id = ? WHERE person_id IS NULL`
    ).run(p);
  }
  return db;
}

/** Resolve once the job leaves "running". */
function settled(id, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const job = registry.get(id);
      if (job && job.status !== "running") return resolve(job);
      if (Date.now() - t0 > timeoutMs) return reject(new Error("job hung"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** POST, returning { status, body } so the assertions stay readable. */
async function post(body) {
  const res = await fetch(`${srv.base}/api/projections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(`${srv.base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe("POST /api/projections (#232)", () => {
  it("is a JOB, not an awaited result", async () => {
    seedPeople(8);
    const res = await post({ minFaces: 2, nEpochs: 30 });
    expect(res.status).toBe(201);
    expect(res.body.jobId).toMatch(/^job-/);
    // The whole point of contract 2: the caller stops awaiting a result.
    expect(res.body.points).toBeUndefined();
    await settled(res.body.jobId);
  });

  it("sets the job total AT CREATION, not on the first progress tick", async () => {
    // A total that arrives one tick late is an indeterminate bar at exactly
    // the moment the user is deciding whether it hung (#208). It is knowable
    // only because nEpochs is an explicit parameter.
    seedPeople(8);
    const res = await post({ minFaces: 2, nEpochs: 30 });
    expect(registry.get(res.body.jobId).total).toBe(30);
    await settled(res.body.jobId);
  });

  it("refuses an empty scope SPECIFICALLY, and creates no job", async () => {
    // A job that starts and finishes in 40ms looks like the button misfired.
    seedPeople(8);
    const before = registry.list().length;
    const res = await post({ minFaces: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lower the minimum/i);
    expect(registry.list().length).toBe(before);
  });

  it("refuses an unofferable algorithm BEFORE creating a job", async () => {
    // A rejected request must never leave a row that appears and immediately
    // fails — the zombie-job shape #222 fixed for clustering.
    seedPeople(8);
    const before = registry.list().length;
    // t-SNE is capped at 6,000 members; force the refusal with a fake count is
    // impossible here, so assert the unknown-algorithm branch, which shares
    // the same code path and the same ordering.
    const res = await post({ minFaces: 2, algorithm: "sqdmds" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown algorithm/i);
    expect(registry.list().length).toBe(before);
  });

  it("409s while people are being regrouped", async () => {
    // Clustering rewrites every person assignment, so a map built mid-pass
    // describes a population that no longer exists.
    seedPeople(8);
    await withClusterLatch(async () => {
      const res = await post({ minFaces: 2 });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/regrouped/i);
    });
  });

  it("409s on a second concurrent projection", async () => {
    seedPeople(8);
    await withProjectionLatch(async () => {
      const res = await post({ minFaces: 2 });
      expect(res.status).toBe(409);
    });
  });

  it("a cache hit starts NO job at all", async () => {
    // "If there is nothing pending, say so and start no job", applied to a
    // different quantity.
    seedPeople(8);
    const first = await post({ minFaces: 2, nEpochs: 30 });
    await settled(first.body.jobId);

    const before = registry.list().length;
    const again = await post({ minFaces: 2, nEpochs: 30 });
    expect(again.status).toBe(200);
    expect(again.body.reused).toBe(true);
    expect(again.body.runId).toBeGreaterThan(0);
    expect(again.body.jobId).toBeUndefined();
    expect(registry.list().length).toBe(before);
  });

  it("a DIFFERENT parameter is a different run, not a cache hit", async () => {
    seedPeople(8);
    const a = await post({ minFaces: 2, nEpochs: 30 });
    await settled(a.body.jobId);
    const b = await post({ minFaces: 2, nEpochs: 31 });
    expect(b.status).toBe(201);
    await settled(b.body.jobId);
  });

  it("records a cancellation as canceled, not failed", async () => {
    // A cancellation is an outcome. Rendering it as "✗ 1 failed" to someone
    // who pressed Stop is Finding 6 of the ML UX review.
    seedPeople(30, 2);
    const res = await post({ minFaces: 2, nEpochs: 400 });
    registry.cancel(res.body.jobId);
    const job = await settled(res.body.jobId);
    expect(job.status).toBe("canceled");
  });

  it("leaves NO half-map behind when cancelled", async () => {
    // The run row and its points are written together, after the worker
    // returns, so a cancelled run cannot leave a partial map to browse.
    seedPeople(30, 2);
    const res = await post({ minFaces: 2, nEpochs: 400 });
    registry.cancel(res.body.jobId);
    await settled(res.body.jobId);
    expect(
      getDb().prepare(`SELECT COUNT(*) n FROM projection_runs`).get().n
    ).toBe(0);
    expect(
      getDb().prepare(`SELECT COUNT(*) n FROM projection_point`).get().n
    ).toBe(0);
  });

  it("finishes with a summary the jobs panel can render", async () => {
    seedPeople(8);
    const res = await post({ minFaces: 2, nEpochs: 30 });
    const job = await settled(res.body.jobId);
    expect(job.status).toBe("done");
    expect(job.result).toMatchObject({
      members: 8,
      algorithm: "umap",
      runId: expect.any(Number),
    });
  });
});

describe("GET /api/projections/current", () => {
  it("says there is no map yet rather than 404ing", async () => {
    // "You have not built one" is a state the view renders, not an error.
    seedPeople(4);
    const res = await get(`/api/projections/current?model=${MODEL}`);
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(null);
    expect(res.body.points).toEqual([]);
  });

  it("returns the points once a run exists", async () => {
    seedPeople(8);
    const made = await post({ minFaces: 2, nEpochs: 30 });
    await settled(made.body.jobId);

    const res = await get(
      `/api/projections/current?model=${MODEL}&minFaces=2&nEpochs=30`
    );
    expect(res.body.runId).toBeGreaterThan(0);
    expect(res.body.points).toHaveLength(8);
    expect(res.body.points[0]).toMatchObject({
      personId: expect.any(Number),
      x: expect.any(Number),
      y: expect.any(Number),
      faces: 2,
    });
    expect(res.body.staleness).toMatchObject({ peopleOnMap: 8, missing: 0 });
  });

  it("reports FACE coverage, not photo counts", async () => {
    // faceCounts' `total` is PHOTOS. Reading it as a face denominator would
    // quote a wrong, plausible-looking number — and an undefined one where the
    // key does not exist at all.
    seedPeople(4, 2); // 4 people x 2 faces = 8 grouped faces
    const db = getDb();
    // one more face nobody has grouped
    const extra = upsertScan(db, "/vol/loose", 1, [
      { name: "L.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]).map((r) => r.id)[0];
    const v = new Float32Array(DIM).fill(0);
    v[0] = 1;
    const { scale, bytes } = quantize(v);
    putFaces(db, {
      photoId: extra,
      model: MODEL,
      faces: [{ box: [0, 0, 1, 1], score: 0.5, dim: DIM, scale, bytes }],
    });

    const res = await get(`/api/projections/current?model=${MODEL}`);
    expect(res.body.coverage).toEqual({
      detected: 9,
      grouped: 8,
      ungrouped: 1,
      people: 4,
    });
  });
});

describe("GET /api/projections/options", () => {
  it("reports a live member count that tracks minFaces", async () => {
    // This is how the projection satisfies contract 1 without a ScopeControl:
    // the one scope dimension carries a count, so the user is never offered a
    // bare button meaning "do everything".
    seedPeople(5, 2);
    seedPeople(0);
    const two = await get(`/api/projections/options?model=${MODEL}&minFaces=2`);
    expect(two.body.members).toBe(5);
    const twenty = await get(
      `/api/projections/options?model=${MODEL}&minFaces=20`
    );
    expect(twenty.body.members).toBe(0);
  });

  it("offers the algorithms, with the bad ones absent and t-SNE enabled here", async () => {
    seedPeople(5, 2);
    const res = await get(`/api/projections/options?model=${MODEL}&minFaces=2`);
    const ids = res.body.algorithms.map((a) => a.id);
    expect(ids).toEqual(["umap", "tsne", "pca"]);
    expect(res.body.algorithms.find((a) => a.id === "tsne").enabled).toBe(true);
  });

  it("echoes the clamped params, so the gear and the cache key agree", async () => {
    // If the gear showed what the user typed and the server keyed on a clamped
    // value, every request would miss the cache forever.
    seedPeople(5, 2);
    const res = await get(
      `/api/projections/options?model=${MODEL}&minFaces=-5&nEpochs=999999`
    );
    expect(res.body.params.minFaces).toBe(1);
    expect(res.body.params.nEpochs).toBeLessThanOrEqual(2000);
  });
});
