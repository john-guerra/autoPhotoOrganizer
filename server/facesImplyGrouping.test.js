/**
 * Finding faces files them into people, in the same job (#250).
 *
 * > "If I ask it to find faces, the grouping should be computed automatically
 * > — the user doesn't need to know the difference."
 *
 * Detection and grouping were two buttons: the app exposing its own pipeline
 * stages. Nobody wants a pile of ungrouped face boxes, and omitting the second
 * pass left the first one's output inert.
 *
 * A chain DID already exist — `assignNewFaces` runs on every successful scan —
 * but it matches only against NAMED people and returns early on an empty named
 * list. For a user who has named nobody it was a no-op every single time,
 * which is why the second button was effectively mandatory. That is the
 * specific hole these tests cover: **a scan by someone who has named nobody
 * must still produce people.**
 *
 * ## Its own file, and why
 *
 * `faceRoutes.test.js` mocks `onnxruntime-node` to REJECT — it exists to test
 * the runtime-failure path — so no test in it can reach a successful sweep.
 * This file mocks the engine to SUCCEED instead, which is the only way to
 * reach phase 2 through the real route. The two mocks are mutually exclusive,
 * so they cannot share a file.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

/** Weights "present and verified", which no fixture can achieve honestly. */
vi.mock("./ml/faceDownload.js", async (importOriginal) => ({
  ...(await importOriginal()),
  checkFaceModel: async () => ({ ready: true, missing: [], corrupt: [] }),
}));

/** A runtime that loads. The engine below never touches it. */
vi.mock("onnxruntime-node", () => ({ default: {} }));

const DIM = 512;

/**
 * A detector that finds exactly one face per photo, on one of three
 * identities, chosen by the photo's position.
 *
 * Deterministic on purpose: the assertion is "three people came out", and a
 * random detector would make that flaky for reasons having nothing to do with
 * the chain being tested.
 */
let faceSeq = 0;
/**
 * Faces the mock detector reports per photo.
 *
 * Adjustable so a test can cross the route's 500-face grouping threshold
 * (#304) with a handful of photos instead of 500 generated JPEGs. The
 * THRESHOLD itself is never injected — that is the trap #310 was about — only
 * how fast the fixture reaches it.
 */
let facesPerPhoto = 1;
vi.mock("./ml/faceEngine.js", () => ({
  createFaceEngine: () => ({
    // The real engine returns `{faces: [{box, score, vector}]}` and the SWEEP
    // quantizes the vector (server/ml/faceSweep.js). An earlier version of
    // this mock returned a bare array of already-quantized faces, so
    // `found.faces` was undefined, every photo recorded zero faces, and phase
    // 2 correctly had nothing to file — the tests failed for a reason that had
    // nothing to do with the chain.
    detect: async () => {
      const faces = [];
      for (let i = 0; i < facesPerPhoto; i++) {
        const identity = faceSeq++ % 3;
        const vector = new Float32Array(DIM);
        vector[identity] = 1;
        faces.push({ box: [0, 0, 10, 10], score: 0.95, vector });
      }
      return { faces };
    },
    close: async () => {},
  }),
}));

const { createApp } = await import("./index.js");
const { getDb, _resetDbForTest } = await import("./db/connection.js");
const { registry } = await import("./jobs/registry.js");
const { upsertScan } = await import("./db/photos.js");
const { _resetClusterForTest } = await import("./ml/faceClusters.js");

let home, srv, photosRoot;

/**
 * A real folder of real JPEGs.
 *
 * The sweep checks that a photo's file is actually there and, when it is not,
 * stands down with "drive not available" rather than marking the photo
 * unreadable (#169 — a host failure says nothing about your photos). So a
 * fixture of paths that do not exist reaches phase 1 and stops, and phase 2 is
 * unreachable. Cost me a run.
 *
 * @returns {Promise<Array<{name:string,size:number,mtimeMs:number,kind:string}>>}
 */
async function makePhotos(dir, n, prefix) {
  await mkdir(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < n; i++) {
    const name = `${prefix}_${i}.jpg`;
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: i * 10, g: 90, b: 120 },
      },
    })
      .jpeg()
      .toFile(join(dir, name));
    const { size, mtimeMs } = await (
      await import("node:fs/promises")
    ).stat(join(dir, name));
    files.push({ name, size, mtimeMs, kind: "image" });
  }
  return files;
}

const inertMl = () => ({
  configure: async () => {
    throw new Error("ml disabled in this suite");
  },
  embedImages: async () => [],
  embedTexts: async () => [],
  close: async () => {},
});

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "ag-faces-imply-"));
  photosRoot = await mkdtemp(join(tmpdir(), "ag-faces-photos-"));
  process.env.AUTOGALLERY_HOME = home;
  _resetDbForTest();
  _resetClusterForTest();
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
  await rm(photosRoot, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

const post = (path, body) =>
  fetch(`${srv.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/** Wait for a job to leave "running"/"paused", as a client's waitForJob does. */
async function settle(jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = registry.get(jobId);
    if (j && j.status !== "running" && j.status !== "paused") return j;
    if (Date.now() > deadline) throw new Error(`job ${jobId} never settled`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a face scan files what it finds into people (#250)", () => {
  it("produces PEOPLE, not just face boxes, for a user who has named nobody", async () => {
    // The hole `assignNewFaces` left. It needs a named person to match
    // against, so on a library where nothing has been named it returned
    // {assigned: 0} every time and every detected face stayed homeless.
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO volumes (id,label,uuid,last_mount_path,last_seen_at)
       VALUES (1,'v','u','/t',0)`
    ).run();
    const tripDir = join(photosRoot, "trip");
    upsertScan(db, tripDir, 1, await makePhotos(tripDir, 9, "IMG"));
    expect(db.prepare(`SELECT COUNT(*) c FROM persons`).get().c).toBe(0);

    const res = await post("/api/ml/faces");
    const body = await res.json();
    expect(body.started).toBe(true);

    const job = await settle(body.jobId);
    expect(job.status).toBe("done");

    // The whole point: nobody pressed a second button.
    expect(
      db.prepare(`SELECT COUNT(*) c FROM persons`).get().c
    ).toBeGreaterThan(0);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) c FROM photo_faces WHERE person_id IS NOT NULL`
        )
        .get().c
    ).toBeGreaterThan(0);
  });

  it("reports the filing in its result, so the summary can say so", async () => {
    // A job that quietly does twice as much and reports half of it is the
    // same silent-action problem in a new place: `summarize()` can only say
    // what the result carries.
    const db = getDb();
    const done = registry
      .list()
      .filter((j) => j.type === "faces" && j.status === "done");
    const last = done.at(-1);
    expect(last?.result?.grouped).toBeDefined();
    expect(last.result.grouped.assigned).toBeGreaterThan(0);
    expect(last.result.grouped.created).toBeGreaterThan(0);
    // Detection's own numbers survive alongside it — the two phases both
    // report, rather than the second overwriting the first.
    expect(last.result.faces).toBeGreaterThan(0);
    expect(last.result.scanned).toBeGreaterThan(0);
    // And it really did leave nothing behind in scope.
    expect(
      db
        .prepare(`SELECT COUNT(*) c FROM photo_faces WHERE person_id IS NULL`)
        .get().c
    ).toBe(0);
  });

  it("groups ONLY the scanned scope, leaving other faces alone", async () => {
    // John's call. A 200-photo scan must not trigger a library-wide grouping —
    // measured at ~20 minutes on a library with ~25,000 people. The cost is
    // that out-of-scope faces stay ungrouped, which is why the panel has to
    // show that count rather than let it be silent.
    //
    // THE FIXTURE IS THE WHOLE TEST, and the obvious version does not work.
    // Asserting that un-scanned photos have no people proves only that
    // DETECTION was scoped: they have no face rows at all, so a library-wide
    // grouping would change nothing about them and the test stays green with
    // the scope removed. (Verified — it did.)
    //
    // So the out-of-scope photos must have faces that are UNGROUPED: scan
    // them, then detach their people, exactly as a cancelled grouping or a
    // re-scan would leave them.
    const db = getDb();
    const otherDir = join(photosRoot, "other");
    upsertScan(db, otherDir, 1, await makePhotos(otherDir, 4, "OTHER"));
    const otherIds = db
      .prepare(
        `SELECT p.id FROM photos p JOIN folders f ON f.id = p.folder_id
          WHERE f.abs_path = ?`
      )
      .all(otherDir)
      .map((r) => r.id);

    const first = await (await post("/api/ml/faces", { ids: otherIds })).json();
    expect(first.started).toBe(true);
    await settle(first.jobId);
    // Now strand them, the way a cancelled grouping does.
    db.prepare(
      `UPDATE photo_faces SET person_id = NULL, person_source = NULL
        WHERE photo_id IN (${otherIds.join(",")})`
    ).run();
    const stranded = db
      .prepare(
        `SELECT COUNT(*) c FROM photo_faces
          WHERE photo_id IN (${otherIds.join(",")}) AND person_id IS NULL`
      )
      .get().c;
    expect(stranded).toBeGreaterThan(0);

    // A DIFFERENT folder, scanned with its own scope.
    const secondDir = join(photosRoot, "second");
    upsertScan(db, secondDir, 1, await makePhotos(secondDir, 2, "S"));
    const scopeIds = db
      .prepare(
        `SELECT p.id FROM photos p JOIN folders f ON f.id = p.folder_id
          WHERE f.abs_path = ?`
      )
      .all(secondDir)
      .map((r) => r.id);

    const body = await (await post("/api/ml/faces", { ids: scopeIds })).json();
    expect(body.started).toBe(true);
    await settle(body.jobId);

    // The scope's faces got people...
    expect(
      db
        .prepare(
          `SELECT COUNT(*) c FROM photo_faces
            WHERE photo_id IN (${scopeIds.join(",")}) AND person_id IS NOT NULL`
        )
        .get().c
    ).toBeGreaterThan(0);

    // ...and the stranded ones are STILL stranded. This is the assertion that
    // goes red when `scopeIds` becomes `null`.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) c FROM photo_faces
            WHERE photo_id IN (${otherIds.join(",")}) AND person_id IS NULL`
        )
        .get().c
    ).toBe(stranded);
  });
});

describe("people appear WHILE the scan runs (#304)", () => {
  it("files faces into people mid-sweep, not only at the end", async () => {
    // John, validating #250:
    //
    //   "#304 worked but only once the whole scan finished, not progressively,
    //    I guess you were grouping only after finding all the faces."
    //
    // Exactly right: #250's phase 2 runs after `scheduler.submit` RESOLVES,
    // i.e. after the whole sweep, so nobody existed until the very end and the
    // live People view had nothing to show.
    //
    // Observed through the JOB'S PHASE rather than by polling `persons`, which
    // would race the sweep. The route sets "Filing faces into people" each time
    // it groups; interim passes plus the final one means MORE THAN ONE
    // transition into that phase. Without progressive grouping there is
    // exactly one — phase 2's.
    const db = getDb();
    const dir = join(photosRoot, "many");
    // 200 faces a photo, so the route's shipped 500-face threshold is crossed
    // after three photos rather than after 500. The threshold is NOT injected.
    facesPerPhoto = 200;
    try {
      upsertScan(db, dir, 1, await makePhotos(dir, 12, "M"));

      // Keyed BY JOB ID, and that is not incidental: earlier tests in this
      // file leave their own finished `faces` jobs in the registry, so
      // `list.find(x => x.type === "faces")` returns the OLDEST one — whose
      // phase never changes again. This spec reported one filing instead of
      // three until that was fixed, i.e. it was reading a stale job.
      /** @type {Array<{id: string, phase: string}>} */
      const events = [];
      const onChange = (list) => {
        for (const j of list) {
          if (j.type !== "faces") continue;
          const last = events.filter((e) => e.id === j.id).at(-1);
          if (last?.phase !== j.phase)
            events.push({ id: j.id, phase: j.phase });
        }
      };
      registry.on("change", onChange);
      let body;
      try {
        body = await (await post("/api/ml/faces")).json();
        expect(body.started).toBe(true);
        await settle(body.jobId);
      } finally {
        registry.off("change", onChange);
      }

      const filings = events.filter(
        (e) => e.id === body.jobId && e.phase === "Filing faces into people"
      );
      expect(
        filings.length,
        `entered the filing phase ${filings.length} time(s) — progressive grouping should file several times before the end`
      ).toBeGreaterThan(1);

      // And it really did the work: nothing left ungrouped in scope.
      expect(
        db
          .prepare(`SELECT COUNT(*) c FROM photo_faces WHERE person_id IS NULL`)
          .get().c
      ).toBe(0);
    } finally {
      facesPerPhoto = 1;
    }
  }, 60_000);
});
