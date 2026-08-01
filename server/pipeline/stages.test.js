import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import {
  STAGES,
  stageById,
  pendingWhere,
  pendingAnyWhere,
  PENDING_META,
  PENDING_HASH,
} from "./stages.js";
import { PENDING_CONDITION } from "../db/enrich.js";

/**
 * Phase 0's claim is that it is a NO-OP: the shared predicates select exactly
 * the rows the hand-written ones did. These tests are that claim, run against a
 * real database rather than argued about — because the failure mode when they
 * drift is silent (`schema.js:444`: "nothing failed loudly, the query just fell
 * back to a full table scan").
 */

let cacheDir;
let db;

/** `n` photos in one folder, all pending in every stage. */
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

/** Run a stage's pending WHERE and return the matching ids. */
function idsPending(stage, params = {}) {
  return db
    .prepare(
      `SELECT photos.id FROM photos
         JOIN folders ON folders.id = photos.folder_id
        WHERE ${pendingWhere(stage)}
        ORDER BY photos.id`
    )
    .all({ model: "m", faceModel: "fm", ...params })
    .map((r) => r.id);
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-stages-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  db = getDb();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("the shared predicates match the hand-written ones (Phase 0)", () => {
  it("meta selects what db/enrich.js's PENDING_CONDITION selects", () => {
    // The one that already has a partial index built against it, and the one
    // whose drift cost a silent full scan. Same rows, or Phase 0 is not a
    // no-op.
    const ids = seed(6);
    db.prepare(
      `UPDATE photos SET width = 10, gps_checked = 1 WHERE id <= ?`
    ).run(ids[2]);
    const shared = idsPending(stageById("meta"));
    const original = db
      .prepare(
        `SELECT photos.id FROM photos
           JOIN folders ON folders.id = photos.folder_id
          WHERE ${PENDING_CONDITION}
          ORDER BY photos.id`
      )
      .all()
      .map((r) => r.id);
    expect(shared).toEqual(original);
    expect(shared).toEqual(ids.slice(3));
  });

  it("hash selects what db/hashing.js's worklist selects", () => {
    const ids = seed(5);
    db.prepare(`UPDATE photos SET content_hash = 'x' WHERE id = ?`).run(ids[0]);
    // hash_attempted marks a file we tried and could not read — still not
    // pending, which is what stops a poison file being retried forever.
    db.prepare(`UPDATE photos SET hash_attempted = 1 WHERE id = ?`).run(ids[1]);
    expect(idsPending(stageById("hash"))).toEqual(ids.slice(2));
  });

  it("embed skips RAW rather than failing it, and skips recorded failures", () => {
    const ids = seed(4);
    db.prepare(`UPDATE photos SET kind = 'raw' WHERE id = ?`).run(ids[0]);
    db.prepare(
      `INSERT INTO photo_embeddings (photo_id, model, dim, scale, vec, created_at)
       VALUES (?, 'm', 1, 1.0, X'00', 0)`
    ).run(ids[1]);
    db.prepare(
      `INSERT INTO ml_status (photo_id, stage, model, state, updated_at)
       VALUES (?, 'embed', 'm', 'failed', 0)`
    ).run(ids[2]);
    expect(idsPending(stageById("embed"))).toEqual([ids[3]]);
  });

  it("faces counts ANY ml_status row as looked-at, success or not", () => {
    // Deliberately asymmetric with embed, which excludes only failures. This
    // is shipped behaviour preserved verbatim, not an oversight — pinned so a
    // later tidy-up has to be a decision rather than an accident.
    const ids = seed(3);
    db.prepare(
      `INSERT INTO ml_status (photo_id, stage, model, state, updated_at)
       VALUES (?, 'faces', 'fm', 'failed', 0)`
    ).run(ids[0]);
    db.prepare(
      `INSERT INTO ml_status (photo_id, stage, model, state, updated_at)
       VALUES (?, 'faces', 'fm', 'done', 0)`
    ).run(ids[1]);
    expect(idsPending(stageById("faces"))).toEqual([ids[2]]);
  });

  it("faces is per MODEL — a different pack has not looked at anything", () => {
    const ids = seed(2);
    db.prepare(
      `INSERT INTO ml_status (photo_id, stage, model, state, updated_at)
       VALUES (?, 'faces', 'buffalo_s', 'done', 0)`
    ).run(ids[0]);
    expect(idsPending(stageById("faces"), { faceModel: "buffalo_s" })).toEqual([
      ids[1],
    ]);
    expect(idsPending(stageById("faces"), { faceModel: "buffalo_l" })).toEqual(
      ids
    );
  });

  it("every stage excludes stale photos", () => {
    // Staleness is a property of the PHOTO, not of a stage — which is why
    // pendingWhere applies it once instead of each predicate carrying it.
    const ids = seed(3);
    db.prepare(`UPDATE photos SET stale = 1 WHERE id = ?`).run(ids[0]);
    for (const stage of STAGES) {
      expect(idsPending(stage)).not.toContain(ids[0]);
    }
  });
});

describe("pendingAnyWhere — the cohort query's shape (§1.4)", () => {
  it("matches a photo pending in ANY stage, and drops one pending in none", () => {
    const ids = seed(3);
    // id[0]: fully done in meta and hash; the other two stages are excluded
    // from this query so it should drop out.
    db.prepare(
      `UPDATE photos SET width = 10, gps_checked = 1, content_hash = 'x'
        WHERE id = ?`
    ).run(ids[0]);
    // id[1]: metadata read, hash still missing -> still pending.
    db.prepare(
      `UPDATE photos SET width = 10, gps_checked = 1 WHERE id = ?`
    ).run(ids[1]);
    const twoStages = STAGES.filter((s) => s.id === "meta" || s.id === "hash");
    const got = db
      .prepare(
        `SELECT photos.id FROM photos
           JOIN folders ON folders.id = photos.folder_id
          WHERE ${pendingAnyWhere(twoStages)}
          ORDER BY photos.id`
      )
      .all()
      .map((r) => r.id);
    expect(got).toEqual([ids[1], ids[2]]);
  });

  it("matches nothing when asked about no stages, rather than everything", () => {
    // The expensive direction, and the same rule the scope layer keeps: an
    // empty set of stages is "no work", never "all of it".
    seed(2);
    const got = db
      .prepare(`SELECT photos.id FROM photos WHERE ${pendingAnyWhere([])}`)
      .all();
    expect(got).toEqual([]);
  });
});

describe("byte-compatibility with the partial index", () => {
  it("emits meta's WHERE exactly as idx_photos_pending_meta was built from", () => {
    // A CHARACTER-LEVEL assertion, which is unusual and deliberate.
    //
    // schema.js builds idx_photos_pending_meta's partial WHERE from this very
    // string, and SQLite only uses a partial index when it can PROVE the
    // query's WHERE is covered by the index's predicate. During this refactor
    // an extra `AND (1)` from a trivially-true eligibility clause defeated that
    // proof and queryPlan.test.js dropped to `SCAN photos` — a full scan of
    // 100k+ rows on each of the ~2,000 batches a sweep takes, with nothing
    // failing anywhere.
    //
    // queryPlan.test.js is the real guard; this one just fails FASTER and says
    // why, instead of leaving the next person to interpret a query plan.
    expect(pendingWhere(stageById("meta"))).toBe(
      `photos.stale = 0
    AND (photos.width IS NULL
         OR (photos.kind = 'video' AND photos.video_codec IS NULL)
         OR photos.gps_checked = 0)`
    );
  });

  it("omits a trivially-true eligibility rather than emitting AND (1)", () => {
    expect(pendingWhere(stageById("hash"))).not.toContain("(1)");
    // ...but a REAL eligibility is still emitted.
    expect(pendingWhere(stageById("faces"))).toContain("photos.kind = 'image'");
  });
});

describe("the module's own shape", () => {
  it("is frozen, so a consumer cannot mutate the shared definition", () => {
    expect(Object.isFrozen(STAGES)).toBe(true);
  });

  it("orders meta and hash first — they need no model downloaded", () => {
    expect(STAGES.map((s) => s.id)).toEqual(["meta", "hash", "embed", "faces"]);
  });

  it("keeps the predicates free of a stale=0 of their own", () => {
    // If one starts carrying its own, pendingWhere applies it twice and the
    // next person to compose these fragments gets a subtly different query.
    for (const s of STAGES) expect(s.pending).not.toContain("stale");
    expect(PENDING_META).not.toContain("stale");
    expect(PENDING_HASH).not.toContain("stale");
  });
});

describe("the two counting bugs Phase 0 fixes (#261)", () => {
  it("faceCounts does not count a photo that has since gone STALE", async () => {
    // `total` counts live photos; `scanned`/`failed` used to count ml_status
    // rows with no join, so a caller deriving pending as
    // `total - scanned - failed` got a number too low — and with enough stale
    // rows, negative. embedCounts already joined, so the two disagreed about
    // the same library.
    const { faceCounts } = await import("../db/faces.js");
    const ids = seed(3);
    for (const id of ids) {
      db.prepare(
        `INSERT INTO ml_status (photo_id, stage, model, state, updated_at)
         VALUES (?, 'faces', 'm', 'done', 0)`
      ).run(id);
    }
    expect(faceCounts(db, "m")).toMatchObject({ total: 3, scanned: 3 });

    db.prepare(`UPDATE photos SET stale = 1 WHERE id = ?`).run(ids[0]);
    const after = faceCounts(db, "m");
    expect(after.total).toBe(2);
    // The point: scanned drops WITH total, so the derived pending stays 0
    // instead of going to -1.
    expect(after.scanned).toBe(2);
    expect(after.total - after.scanned - after.failed).toBe(0);
  });

  it("clearEmbedFailures clears failures and LEAVES done rows alone", async () => {
    // Inert today because `failed` is the only state written for embed — which
    // is why it had to be fixed before the pipeline introduces a second one and
    // this silently discards completed work. Its docstring already claimed this
    // behaviour; the code did not have it.
    const { clearEmbedFailures } = await import("../db/embeddings.js");
    const ids = seed(2);
    db.prepare(
      `INSERT INTO ml_status (photo_id, stage, model, state, updated_at)
       VALUES (?, 'embed', 'm', 'failed', 0)`
    ).run(ids[0]);
    db.prepare(
      `INSERT INTO ml_status (photo_id, stage, model, state, updated_at)
       VALUES (?, 'embed', 'm', 'done', 0)`
    ).run(ids[1]);

    expect(clearEmbedFailures(db, "m")).toEqual({ cleared: 1 });
    const left = db
      .prepare(`SELECT state FROM ml_status WHERE stage = 'embed'`)
      .all()
      .map((r) => r.state);
    expect(left).toEqual(["done"]);
  });
});
