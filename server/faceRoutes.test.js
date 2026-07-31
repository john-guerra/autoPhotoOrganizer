/**
 * The face routes' failure plumbing (#166).
 *
 * A SEPARATE file from api.test.js because it mocks two modules for every test
 * in it — `onnxruntime-node` (made to reject) and the weights check (made to
 * pass) — and neither belongs anywhere near the several hundred unrelated
 * tests over there.
 *
 * These are the failures nothing else can reach. `checkFaceModel` verifies a
 * SHA-256 recorded from 191 MB of real weights, so no fixture can make it
 * answer "ready" for real; and the ort import only fails in a packaged app,
 * which is exactly the case that shipped broken.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The whole point: a native-addon import that fails, as in an ASAR build
 *  where onnxruntime-node's .node file did not get unpacked.
 *
 *  Thrown from the `default` GETTER rather than from the factory: a factory
 *  that throws is caught by vitest and re-thrown as its own "error when
 *  mocking a module" message, which would make the assertion below prove only
 *  that vitest is unhappy. loadOrt reads `.default`, so this surfaces as the
 *  real rejection the route has to handle. */
vi.mock("onnxruntime-node", () => ({
  get default() {
    throw new Error("no native binding found for platform");
  },
}));

/** Weights "present and verified", which no fixture can achieve honestly. */
vi.mock("./ml/faceDownload.js", async (importOriginal) => ({
  ...(await importOriginal()),
  checkFaceModel: async () => ({ ready: true, missing: [], corrupt: [] }),
}));

const { createApp } = await import("./index.js");
const { getDb, _resetDbForTest } = await import("./db/connection.js");
const { markFaceFailed, faceCounts } = await import("./db/faces.js");
const { registry } = await import("./jobs/registry.js");
const { putFaces } = await import("./db/faces.js");
const { quantize } = await import("./ml/quantize.js");
const { withClusterLatch, _resetClusterForTest } =
  await import("./ml/faceClusters.js");
const { upsertScan } = await import("./db/photos.js");
const { ungroupedFaceCount } = await import("./db/faces.js");

let home;
let srv;

const inertMl = () => ({
  configure: async () => {
    throw new Error("ml disabled in this suite");
  },
  embedImages: async () => [],
  embedTexts: async () => [],
  close: async () => {},
});

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "ag-faceroutes-"));
  process.env.AUTOGALLERY_HOME = home;
  _resetDbForTest();
  const app = createApp({ ml: inertMl() });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  srv = {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
});

afterAll(async () => {
  await srv?.close();
  _resetDbForTest();
  await rm(home, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

const post = (path, body) =>
  fetch(`${srv.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

describe("POST /api/ml/faces when the runtime will not load", () => {
  it("says so, and does not leave a job running forever", async () => {
    // `runtime: { ort: await loadOrt(), sharp }` used to be evaluated AFTER
    // res.json() and OUTSIDE the try. A rejected import therefore threw past
    // a job that was already created, so it was never finished and never
    // failed: the panel spun forever, nothing was reported, and pressing the
    // button again made another zombie. CLAUDE.md: never fail silently.
    const before = registry.list().length;

    const res = await post("/api/ml/faces");
    expect(res.status).toBe(500);
    const body = await res.json();

    // Specific over generic: which subsystem, and what the user can do.
    expect(body.error).toMatch(/runtime/i);
    expect(body.error).toMatch(/no native binding/);
    expect(body.error).toMatch(/nothing was changed/i);

    // No job at all, rather than one that never ends.
    expect(registry.list().length).toBe(before);
    expect(registry.list().some((j) => j.state === "running")).toBe(false);
  });
});

describe("POST /api/ml/faces with an `ids` scope (#221)", () => {
  // These assertions are reachable in THIS file precisely because the scope is
  // validated before the weights check and before loadOrt — so a malformed
  // request is a plain 4xx, not the mocked runtime failure above. That
  // ordering is the point: a bad request must never produce a job that
  // appears and immediately fails.

  it("refuses an EMPTY selection specifically, and never widens it", async () => {
    // THE bug. Falling through to a library-wide sweep here is ~14 minutes of
    // inference nobody asked for, and it looks exactly like the button
    // misfiring. UI-CONTRACTS § Scope: "never silently widened."
    const before = registry.list().length;
    const res = await post("/api/ml/faces", { ids: [] });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no photos were selected/i);
    // Not a generic "bad request" — it names what the user actually did.
    expect(body.error).not.toMatch(/bad request/i);

    // And crucially, nothing started.
    expect(registry.list().length).toBe(before);
  });

  it("refuses a non-array `ids` rather than treating it as no scope", async () => {
    const res = await post("/api/ml/faces", { ids: 42 });
    expect(res.status).toBe(400);
  });

  it("refuses a selection too large to send, and says what to do instead", async () => {
    const res = await post("/api/ml/faces", {
      ids: Array.from({ length: 50_001 }, (_, i) => i + 1),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/50,001 photos/);
    expect(body.error).toMatch(/whole library instead/i);
  });

  it("accepts a well-formed scope — it gets past validation to the runtime", async () => {
    // The runtime is mocked to fail in this file, so 500 with the runtime
    // message is proof the scope itself was ACCEPTED. A 400 here would mean
    // validation wrongly rejected a legitimate selection.
    const res = await post("/api/ml/faces", { ids: [1, 2, 3] });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/runtime/i);
  });

  it("still sweeps the whole library when no scope is sent at all", async () => {
    // `undefined` must stay distinct from `[]` all the way down.
    const res = await post("/api/ml/faces", {});
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/runtime/i);
  });
});

describe("POST /api/ml/faces/cluster is a JOB, not an awaited result (#222)", () => {
  /**
   * Faces to group. Deliberately on its OWN volume/folder ids (2, not 1) with
   * a per-call filename prefix: every test in this file shares one database,
   * and the retry-failed test below inserts volume 1 with a plain INSERT.
   * Claiming volume 1 here makes THAT test fail with a UNIQUE violation, in a
   * way that reads as a bug in retry-failed rather than in this fixture.
   */
  let seedRun = 0;
  function seedFaces(count) {
    const db = getDb();
    const run = ++seedRun;
    db.prepare(
      `INSERT OR IGNORE INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
       VALUES (2, 'cluster-vol', 'cluster-uuid', '/cluster', ?)`
    ).run(Date.now());
    db.prepare(
      `INSERT OR IGNORE INTO folders (id, abs_path, volume_id) VALUES (2, '/vol/C', 2)`
    ).run();
    const ins = db.prepare(
      `INSERT INTO photos (folder_id, filename, kind, size, mtime, stale)
       VALUES (2, ?, 'image', 10, 10, 0)`
    );
    for (let i = 0; i < count; i++) {
      const id = ins.run(`c${run}_${i}.jpg`).lastInsertRowid;
      const v = new Float32Array(64);
      v[i % 8] = 1;
      const { scale, bytes } = quantize(v);
      putFaces(db, {
        photoId: id,
        model: "buffalo_s",
        faces: [{ box: [0, 0, 9, 9], score: 0.9, dim: 64, scale, bytes }],
      });
    }
  }

  it("answers with a jobId immediately instead of the grouping result", async () => {
    // THE shape change. It used to compute 57 million comparisons and THEN
    // respond, so the panel had a frozen button, no progress and no cancel —
    // and closing the panel made the whole operation invisible.
    seedFaces(6);
    const res = await post("/api/ml/faces/cluster", { model: "buffalo_s" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobId).toBeTruthy();
    expect(body.started).toBe(true);
    // The RESULT is not in the response — that is what "not a wrapper" means.
    expect(body.people).toBeUndefined();
    expect(body.assigned).toBeUndefined();

    // And the job is real, visible, and carries a knowable total so the bar
    // can be proportional rather than indeterminate (#208).
    const job = registry.list().find((j) => j.id === body.jobId);
    expect(job).toBeTruthy();
    expect(job.type).toBe("face-cluster");
    expect(job.total).toBeGreaterThan(0);
  });

  it("refuses a second grouping while one is in flight, and creates no job for it", async () => {
    seedFaces(4);
    _resetClusterForTest();
    const before = registry.list().length;

    // Hold the latch the way a real in-flight pass does.
    let release;
    const held = withClusterLatch(() => new Promise((r) => (release = r)));

    const res = await post("/api/ml/faces/cluster", { model: "buffalo_s" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already being grouped/i);
    // A refusal must never leave a row that appears and immediately fails.
    expect(registry.list().length).toBe(before);

    release();
    await held;
  });

  it("refuses a face SCAN while a grouping is running, rather than dooming it", async () => {
    // The two features did not know about each other. A grouping reads every
    // vector and writes the partition in one transaction at the end; a scan
    // started underneath it makes that final write refuse — after the
    // grouping's bar reached 100%. The user loses the whole pass for an action
    // the app offered them.
    _resetClusterForTest();
    let release;
    const held = withClusterLatch(() => new Promise((r) => (release = r)));

    const res = await post("/api/ml/faces", {});
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/being grouped into people/i);
    // Specific over generic: it says what to do and what the cost would be.
    expect(body.error).toMatch(/throw the grouping away/i);

    release();
    await held;
  });

  it("refuses with no faces yet, specifically, and creates no job", async () => {
    const before = registry.list().length;
    const res = await post("/api/ml/faces/cluster", { model: "buffalo_l" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no faces have been found/i);
    expect(registry.list().length).toBe(before);
  });
});

describe("POST /api/ml/faces/retry-failed", () => {
  it("clears the permanent sentinels so the next scan tries again", async () => {
    // A "cannot be read" verdict only clears when the file's BYTES change,
    // i.e. never. Without a route this was unreachable from the app at all,
    // so a bad model file or a since-fixed bug could mark the library
    // unscannable with no way back short of deleting index.db -- which also
    // destroys ratings, keep-scope and album names.
    const db = getDb();
    db.prepare(
      `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
       VALUES (1, 'v', 'u', '/test', ?)`
    ).run(Date.now());
    db.prepare(
      `INSERT INTO folders (id, abs_path, volume_id) VALUES (1, '/vol/T', 1)`
    ).run();
    const ins = db.prepare(
      `INSERT INTO photos (folder_id, filename, kind, size, mtime, stale)
       VALUES (1, ?, 'image', 10, 10, 0)`
    );
    const ids = ["a.jpg", "b.jpg"].map((f) => ins.run(f).lastInsertRowid);
    for (const id of ids) markFaceFailed(db, id, "buffalo_s", "unreadable");
    expect(faceCounts(db, "buffalo_s").failed).toBe(2);

    const res = await post("/api/ml/faces/retry-failed", {
      model: "buffalo_s",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cleared: 2 });
    expect(faceCounts(db, "buffalo_s").failed).toBe(0);
  });
});

/**
 * The grouping SCOPE (#235).
 *
 * Grouping was the one long operation that never got All / Visible / Selected:
 * it read every face for the model, unconditionally. On a 118,371-face library
 * that made it unusable — no way to work in chunks, and a cancelled run wrote
 * nothing.
 */
describe("POST /api/ml/faces/cluster takes a scope (#235)", () => {
  /** `n` faces along `axis`, on their own photos in `folder`. */
  function seed(folder, axis, n) {
    const db = getDb();
    const files = Array.from({ length: n }, (_, i) => ({
      name: `S_${i}.jpg`,
      size: 10 + i,
      mtimeMs: 1700000000000 + i,
      kind: "image",
    }));
    const photos = upsertScan(db, folder, 1, files).map((r) => r.id);
    const v = new Float32Array(64);
    v[axis] = 1;
    const { scale, bytes } = quantize(v);
    for (const pid of photos) {
      putFaces(db, {
        photoId: pid,
        model: MODEL,
        faces: [{ box: [0, 0, 9, 9], score: 0.9, dim: 64, scale, bytes }],
      });
    }
    return photos;
  }

  const settle = async (id, ms = 20_000) => {
    const t0 = Date.now();
    for (;;) {
      const j = registry.get(id);
      if (j && j.status !== "running") return j;
      if (Date.now() - t0 > ms) throw new Error("job hung");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const MODEL = "buffalo_l";

  it("refuses an EMPTY selection specifically, and starts no job", async () => {
    // The failure this prevents costs an hour of CPU: falling back to the
    // whole library because the selection was empty looks like the button
    // misfired, and #206 keeps null-vs-empty distinct for exactly this.
    seed("/vol/scope-a", 1, 4);
    const before = registry.list().length;
    const res = await post("/api/ml/faces/cluster", { model: MODEL, ids: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/selected/i);
    expect(registry.list().length).toBe(before);
  });

  it("413s an oversized selection rather than trying", async () => {
    const res = await post("/api/ml/faces/cluster", {
      ids: Array.from({ length: 50_001 }, (_, i) => i + 1),
    });
    expect(res.status).toBe(413);
  });

  it("groups ONLY the scope, leaving everything else ungrouped", async () => {
    // The seam that was silently droppable in #221: a scope that never reaches
    // the worklist looks identical from the outside until you check what was
    // left alone.
    _resetClusterForTest();
    const inScope = seed("/vol/scope-in", 2, 5);
    seed("/vol/scope-out", 9, 5);

    const res = await post("/api/ml/faces/cluster", {
      model: MODEL,
      ids: inScope,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("remaining");
    const job = await settle(body.jobId);
    expect(job.status).toBe("done");

    // Nothing outside the scope was touched.
    expect(ungroupedFaceCount(getDb(), MODEL, inScope)).toBe(0);
    const outstanding = ungroupedFaceCount(getDb(), MODEL, null);
    expect(outstanding).toBeGreaterThan(0);
  });

  it("sets the job total to what REMAINS, not to the scope's size", async () => {
    // A scope includes faces already grouped, so `ids.length` makes the bar
    // finish at some fraction and stop (#208's other half).
    _resetClusterForTest();
    const photos = seed("/vol/scope-total", 3, 6);
    const remaining = ungroupedFaceCount(getDb(), MODEL, photos);
    const res = await post("/api/ml/faces/cluster", {
      model: MODEL,
      ids: photos,
    });
    const body = await res.json();
    expect(registry.get(body.jobId).total).toBe(remaining);
    await settle(body.jobId);
  });

  it("says so when everything here already has a person, rather than running", async () => {
    _resetClusterForTest();
    const photos = seed("/vol/scope-done", 4, 4);
    const first = await post("/api/ml/faces/cluster", {
      model: MODEL,
      ids: photos,
    });
    await settle((await first.json()).jobId);

    const before = registry.list().length;
    const again = await post("/api/ml/faces/cluster", {
      model: MODEL,
      ids: photos,
    });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already belongs/i);
    expect(registry.list().length).toBe(before);
  });

  it("labels the job briefly enough to read in the panel (#236)", async () => {
    _resetClusterForTest();
    const photos = seed("/vol/scope-label", 5, 3);
    const res = await post("/api/ml/faces/cluster", {
      model: MODEL,
      ids: photos,
    });
    const body = await res.json();
    const { label } = registry.get(body.jobId);
    // The old label was "Grouping 118,371 faces into people" and was clipped,
    // so you could not tell what was running.
    expect(label).toMatch(/^Grouping [\d,]+ faces$/);
    expect(label.length).toBeLessThan(32);
    await settle(body.jobId);
  });
});
