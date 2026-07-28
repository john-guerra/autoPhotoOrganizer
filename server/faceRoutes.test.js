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
