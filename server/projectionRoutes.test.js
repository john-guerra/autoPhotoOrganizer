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
import { _resetPreviewForTest } from "./projection/previewSession.js";
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
  // The preview session holds a worker and a neighbour graph across requests.
  // Leaving one alive leaks a thread into the next test file.
  await _resetPreviewForTest();
  _resetDbForTest();
  _resetProjectionForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

/**
 * People `from..n` with `facesEach` faces apiece, spread over distinct
 * directions.
 *
 * `from` exists so a test can GROW the library after a map has been built —
 * the case #325 is about. Re-running from 1 would collide on `persons.id`,
 * which is inserted explicitly here.
 */
function seedPeople(n, facesEach = 2, from = 1) {
  const db = getDb();
  for (let p = from; p <= n; p++) {
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

  it("does NOT reuse a run whose library has grown since (#325)", async () => {
    // The cache key covers the PARAMETERS. A run's real input is the member
    // set, which the key cannot see — so a map built while face grouping was
    // still running was handed back forever, and the DEFAULT parameters are
    // the worst case because they are the first map anyone builds.
    seedPeople(8);
    const first = await post({ minFaces: 2, nEpochs: 30 });
    await settled(first.body.jobId);

    seedPeople(12, 2, 9); // four more people since that map was built

    const again = await post({ minFaces: 2, nEpochs: 30 });
    expect(again.body.reused).toBeUndefined();
    expect(again.status).toBe(201);
    const job = await settled(again.body.jobId);
    expect(job.result.members).toBe(12);
  });

  it("still reuses a run when the library has NOT changed (#325)", async () => {
    // The other half, and the reason the check is a comparison rather than a
    // fingerprint in the cache key: revalidating must not turn every hit into
    // a rebuild.
    seedPeople(8);
    const first = await post({ minFaces: 2, nEpochs: 30 });
    await settled(first.body.jobId);
    const again = await post({ minFaces: 2, nEpochs: 30 });
    expect(again.body.reused).toBe(true);
    expect(again.body.jobId).toBeUndefined();
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

describe("POST /api/projections/preview (#327)", () => {
  const preview = async (body) => {
    const res = await fetch(`${srv.base}/api/projections/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, ...body }),
    });
    return { status: res.status, body: await res.json() };
  };

  it("returns points and writes NO run", async () => {
    seedPeople(20);
    const before = getDb()
      .prepare(`SELECT COUNT(*) n FROM projection_runs`)
      .get().n;
    const r = await preview({ minFaces: 2, nEpochs: 20 });
    expect(r.status).toBe(200);
    expect(r.body.points).toHaveLength(20);
    expect(r.body.points[0]).toMatchObject({
      personId: expect.any(Number),
      x: expect.any(Number),
      y: expect.any(Number),
    });
    // The whole reason preview is a separate path: a drag would write dozens
    // of rows, and pruneRuns(keep: 3) would then evict the maps the user
    // actually built.
    expect(
      getDb().prepare(`SELECT COUNT(*) n FROM projection_runs`).get().n
    ).toBe(before);
  });

  it("starts no job either", async () => {
    // Contract 2 governs work you might walk away from. A JobsPanel row that
    // appears and completes in 83ms is noise, not control.
    seedPeople(20);
    const before = registry.list().length;
    await preview({ minFaces: 2, nEpochs: 20 });
    expect(registry.list().length).toBe(before);
  });

  it("reports how long it took, so the client can decide to stay live", async () => {
    seedPeople(20);
    const r = await preview({ minFaces: 2, nEpochs: 20 });
    expect(r.body.ms).toBeGreaterThanOrEqual(0);
    expect(r.body.members).toBe(20);
  });

  it("refuses a too-small library specifically", async () => {
    seedPeople(3);
    const r = await preview({ minFaces: 2, nEpochs: 20 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/minimum faces/i);
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

describe("POST /api/ml/people/merge-bulk (#232)", () => {
  async function mergeBulk(body) {
    const res = await fetch(`${srv.base}/api/ml/people/merge-bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  async function undo(token) {
    const res = await fetch(`${srv.base}/api/ml/people/undo-merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return { status: res.status, body: await res.json() };
  }
  const names = () =>
    getDb().prepare(`SELECT id, name FROM persons ORDER BY id`).all();

  it("merges and reports what happened", async () => {
    seedPeople(4);
    const res = await mergeBulk({ intoId: 1, ids: [2, 3, 4], name: "Mafe" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1, mergedCount: 3, name: "Mafe" });
    expect(res.body.token).toEqual(expect.any(String));
    expect(names()).toEqual([{ id: 1, name: "Mafe" }]);
  });

  it("REFUSES an ambiguous name instead of silently dropping one", async () => {
    // Two differently-named people in one lasso is the case that must not
    // resolve itself: merging asserts they are the same human and keeps one
    // name, and the loss is invisible until someone goes looking.
    seedPeople(3);
    const db = getDb();
    db.prepare(`UPDATE persons SET name='Mafe' WHERE id=1`).run();
    db.prepare(`UPDATE persons SET name='John' WHERE id=2`).run();

    const res = await mergeBulk({ intoId: 1, ids: [2, 3] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/different names/i);
    // The candidates come back so the UI can ask rather than guess.
    expect(res.body.names.sort()).toEqual(["John", "Mafe"]);
    // ...and nothing was merged.
    expect(names()).toHaveLength(3);
  });

  it("proceeds once the user has chosen a name", async () => {
    seedPeople(3);
    const db = getDb();
    db.prepare(`UPDATE persons SET name='Mafe' WHERE id=1`).run();
    db.prepare(`UPDATE persons SET name='John' WHERE id=2`).run();

    const res = await mergeBulk({ intoId: 1, ids: [2, 3], name: "John" });
    expect(res.status).toBe(200);
    expect(names()).toEqual([{ id: 1, name: "John" }]);
  });

  it("does not ask when only one name is present", async () => {
    // No friction in the common case: 25,752 of this library's people are
    // unnamed, so most lassos have at most one name in them.
    seedPeople(3);
    getDb().prepare(`UPDATE persons SET name='Mafe' WHERE id=1`).run();
    const res = await mergeBulk({ intoId: 1, ids: [2, 3] });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Mafe");
  });

  it("refuses an empty selection specifically", async () => {
    seedPeople(2);
    expect((await mergeBulk({ intoId: 1, ids: [] })).status).toBe(400);
    expect((await mergeBulk({ intoId: 1 })).status).toBe(400);
  });

  it("413s an absurd selection rather than trying", async () => {
    seedPeople(2);
    const res = await mergeBulk({
      intoId: 1,
      ids: Array.from({ length: 20_001 }, (_, i) => i + 2),
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/smaller region/i);
  });

  it("409s while people are being regrouped", async () => {
    seedPeople(3);
    await withClusterLatch(async () => {
      const res = await mergeBulk({ intoId: 1, ids: [2], name: "X" });
      expect(res.status).toBe(409);
    });
  });

  it("round-trips through undo", async () => {
    seedPeople(4);
    const before = names();
    const merged = await mergeBulk({ intoId: 1, ids: [2, 3, 4], name: "X" });
    expect(names()).toHaveLength(1);

    const back = await undo(merged.body.token);
    expect(back.status).toBe(200);
    expect(back.body.restored).toBe(3);
    expect(names()).toEqual(before);
  });

  it("410s an undo token that is spent or expired, and says which", async () => {
    seedPeople(2);
    const merged = await mergeBulk({ intoId: 1, ids: [2], name: "X" });
    await undo(merged.body.token);
    const again = await undo(merged.body.token);
    expect(again.status).toBe(410);
    expect(again.body.error).toMatch(/no longer undoable/i);
  });

  it("restores a merged-away dot to the map, in place", async () => {
    // The reason projection_point has no cascading FK: undo re-creates the
    // person at its ORIGINAL id, so the cached point resolves again.
    seedPeople(8);
    const made = await post({ minFaces: 2, nEpochs: 30 });
    await settled(made.body.jobId);
    const mapOf = async () =>
      (
        await get(
          `/api/projections/current?model=${MODEL}&minFaces=2&nEpochs=30`
        )
      ).body.points.length;

    expect(await mapOf()).toBe(8);
    const merged = await mergeBulk({ intoId: 1, ids: [2, 3], name: "X" });
    expect(await mapOf()).toBe(6);
    await undo(merged.body.token);
    expect(await mapOf()).toBe(8);
  });
});
