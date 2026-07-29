import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getFeedPage } from "./feed.js";
import { getTreeNode } from "./tree.js";
import { feedIndexes } from "./sort.js";
import { pendingMetaPhotos, pendingMetaCount } from "./enrich.js";
import { backfillPlacesBatch, stampPlacelessPhotos } from "./places.js";
import { pendingEmbedRows, markEmbedFailed } from "./embeddings.js";

/**
 * THE FEED MUST NOT FULL-SCAN.
 *
 * The date group dimensions are `strftime(COALESCE(...))` expressions, which no
 * plain column index can serve. For a while nothing did: every date-grouped page
 * was a full scan of the photos table plus a temp B-tree sort. On a real 114k
 * library that measured 33ms for the first page, 61ms per loadMore, and 224ms
 * with ~20 albums collapsed — about 270 photos/s, well under a fling, which the
 * user felt as "the album loading is slower than I can scroll".
 *
 * The fix is an expression index (sort.js). The DANGER is that it rots silently:
 * change one character of an expression in sort.js and SQLite simply stops using
 * the index — no error, no failing assertion, the app just goes slow again and
 * nobody notices for months. So this asserts the PLAN, not the timing: a timing
 * test would be flaky and would only fail on someone's slow laptop; a plan test
 * fails the moment the query and the index stop matching.
 */

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-plan-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function seed(db) {
  db.prepare(`INSERT INTO volumes (id, label) VALUES (1, 'vol1')`).run();
  const rows = upsertScan(
    db,
    "/photos/trip",
    1,
    Array.from({ length: 40 }, (_, i) => ({
      name: `img_${i}.jpg`,
      size: 1,
      mtimeMs: 1_600_000_000_000 + i * 86_400_000,
      kind: "image",
    }))
  );
  // Enriched, with real EXIF dates — the ordinary case the feed serves.
  const upd = db.prepare(
    `UPDATE photos SET taken_at = ?, width = 100, height = 100 WHERE id = ?`
  );
  rows.forEach((r, i) => upd.run(1_600_000_000_000 + i * 86_400_000, r.id));
  return rows;
}

/**
 * Run `fn`, capturing every statement it prepares TOGETHER WITH the parameters
 * it was actually run with.
 *
 * The params are the point. The feed's seek query is heavily parameterised, and
 * an EXPLAIN with no bindings simply throws — so an earlier version of this test
 * caught the error, skipped the statement, and passed with the index DISABLED.
 * It asserted nothing at all. Capturing the real bindings is what makes the
 * assertion real: with the index turned off, this now goes red.
 */
function capturingSql(db, fn) {
  const seen = [];
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    for (const method of ["all", "get", "run"]) {
      const real = stmt[method].bind(stmt);
      stmt[method] = (...params) => {
        seen.push({ sql, params });
        return real(...params);
      };
    }
    return stmt;
  };
  try {
    fn();
  } finally {
    db.prepare = realPrepare;
  }
  return seen;
}

/** The plan lines for a statement, as SQLite describes them. Throws rather than
 *  swallowing: a statement we cannot plan is a hole in the test, not a pass. */
function planFor(db, { sql, params }) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => r.detail);
}

/** A full scan of `photos` with no index. `SCAN photos USING INDEX ...` is fine;
 *  a bare `SCAN photos` is the regression. So is a temp B-tree sort — that means
 *  the index didn't supply the ordering. */
const isFullScan = (line) =>
  /\bSCAN (photos|p)\b/.test(line) && !/USING (COVERING )?INDEX/.test(line);
const isTempSort = (line) => /USE TEMP B-TREE FOR ORDER BY/.test(line);

describe("the feed's query plans", () => {
  it("creates one expression index per date sort", () => {
    const db = getDb();
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_photos_feed_%'`
      )
      .all()
      .map((r) => r.name);
    expect(names.sort()).toEqual(
      feedIndexes()
        .map((i) => i.name)
        .sort()
    );
  });

  it("serves a date-grouped page from the index — no full scan, no temp sort", () => {
    const db = getDb();
    seed(db);

    // The exact call the app makes on load, and again on every loadMore.
    const statements = capturingSql(db, () =>
      getFeedPage(db, { groupBy: ["year", "month", "day"], after: 60 })
    );

    const photoQueries = statements.filter((s) => /FROM photos/i.test(s.sql));
    // Guard against the test quietly measuring nothing (it once did).
    expect(photoQueries.length).toBeGreaterThan(0);

    const scanned = [];
    for (const q of photoQueries) {
      for (const line of planFor(db, q)) {
        if (isFullScan(line) || isTempSort(line)) scanned.push({ ...q, line });
      }
    }

    expect(
      scanned,
      `these feed queries still full-scan or temp-sort:\n${scanned
        .map(
          (s) => `  ${s.line}\n    ${s.sql.replace(/\s+/g, " ").slice(0, 120)}`
        )
        .join("\n")}`
    ).toEqual([]);
  });

  it("serves the tree's group counts from the index too", () => {
    // The tree runs its own COUNT per level while you scroll; before the index
    // each of those was another full scan (18-30ms apiece on the real library).
    const db = getDb();
    seed(db);

    const statements = capturingSql(db, () =>
      getTreeNode(db, { groupBy: ["year", "month"] })
    );

    const photoQueries = statements.filter((s) => /FROM photos/i.test(s.sql));
    expect(photoQueries.length).toBeGreaterThan(0);

    const bad = [];
    for (const q of photoQueries) {
      for (const line of planFor(db, q)) if (isFullScan(line)) bad.push(line);
    }
    expect(bad).toEqual([]);
  });

  it("serves the folder pre-order key from an index (drift guard)", () => {
    // The folder feed ORDERs by `folders.sort_path` (see DIMENSIONS.folder's
    // sortExpr) — a generated column whose index is what makes the pre-order walk
    // cheap to produce. Column and index are declared in schema.js while the
    // query names them in feed.js, so they can drift apart with no error and no
    // failing assertion, exactly the way the date expression indexes can. This is
    // the guard: rename either side and it goes red.
    //
    // NOTE what this deliberately does NOT assert: that a folder-grouped page
    // avoids a temp B-tree. It does not, and it did not before the pre-order key
    // either — on the real 114k library SQLite drives `photos` outer off a date
    // index and sorts the folder key in memory, both with and without this
    // change. Asserting "no temp sort" would pass only on a toy fixture and lie
    // about the real one. Making the folder feed index-ordered is its own change.
    const db = getDb();
    seed(db);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT abs_path FROM folders ORDER BY sort_path ASC`
      )
      .all()
      .map((r) => r.detail);
    expect(plan.some((l) => /idx_folders_sort_path/.test(l))).toBe(true);
  });

  it("a country/region/city grouped page does not full-scan photos (#154/#173)", () => {
    // country/region/city follow the camera/kind precedent: no dedicated
    // index unless measurement says otherwise. This measures it rather than
    // assuming it.
    const db = getDb();
    seed(db);

    const statements = capturingSql(db, () =>
      getFeedPage(db, { groupBy: ["country", "region", "city"], limit: 50 })
    );
    const photoQueries = statements.filter((s) => /FROM photos/i.test(s.sql));
    expect(photoQueries.length).toBeGreaterThan(0);

    const scanned = [];
    for (const q of photoQueries) {
      for (const line of planFor(db, q)) {
        if (isFullScan(line)) scanned.push({ ...q, line });
      }
    }
    expect(
      scanned,
      `these place-grouped queries full-scan:\n${scanned
        .map(
          (s) => `  ${s.line}\n    ${s.sql.replace(/\s+/g, " ").slice(0, 120)}`
        )
        .join("\n")}`
    ).toEqual([]);
  });

  it("finds the sweep's un-read photos by index, not by scanning the library", () => {
    // Exercises the REAL PENDING_CONDITION via pendingMetaPhotos/pendingMetaCount
    // (enrich.js) — not a hand-copied condition. A hand-copied copy is exactly how
    // this test went stale before: an earlier version hardcoded "width IS NULL"
    // alone, so when PENDING_CONDITION grew a video_codec disjunct and then a
    // gps_checked disjunct (#154), the query quietly started full-scanning the
    // whole table on every one of the ~2,000 batches a full sweep takes, and
    // nothing here caught it. See schema.js's idx_photos_pending_meta, which is
    // now built FROM PENDING_CONDITION for the same anti-drift reason.
    const db = getDb();
    seed(db);

    const statements = capturingSql(db, () => {
      pendingMetaPhotos(db, { limit: 50 });
      pendingMetaCount(db);
    });
    const photoQueries = statements.filter((s) => /FROM photos/i.test(s.sql));
    expect(photoQueries.length).toBeGreaterThan(0);

    const scanned = [];
    for (const q of photoQueries) {
      for (const line of planFor(db, q)) {
        if (isFullScan(line)) scanned.push({ ...q, line });
      }
    }
    expect(
      scanned,
      `these sweep queries still full-scan:\n${scanned
        .map(
          (s) => `  ${s.line}\n    ${s.sql.replace(/\s+/g, " ").slice(0, 120)}`
        )
        .join("\n")}`
    ).toEqual([]);
  });

  it("finds the place-version backfill's pending rows by index, not by scanning (#175)", () => {
    // idx_photos_place_version (schema.js). Runs at every getDb() via
    // db/places.js's backfillPlaces/stampPlacelessPhotos, so an unindexed
    // `place_version < ?` would full-scan on every single app startup, forever
    // — not just the one-time event a version bump actually causes. Exercises
    // the real functions, not a hand-copied condition, for the same
    // anti-drift reason as the sweep test above.
    const db = getDb();
    seed(db);

    const statements = capturingSql(db, () => {
      backfillPlacesBatch(db, { limit: 50 });
      stampPlacelessPhotos(db);
    });
    const photoQueries = statements.filter((s) => /FROM photos/i.test(s.sql));
    expect(photoQueries.length).toBeGreaterThan(0);

    const scanned = [];
    for (const q of photoQueries) {
      for (const line of planFor(db, q)) {
        if (isFullScan(line)) scanned.push({ ...q, line });
      }
    }
    expect(
      scanned,
      `these place-backfill queries still full-scan:\n${scanned
        .map(
          (s) => `  ${s.line}\n    ${s.sql.replace(/\s+/g, " ").slice(0, 120)}`
        )
        .join("\n")}`
    ).toEqual([]);
  });
});

/**
 * THE EMBED WORKLIST MUST NOT FULL-SCAN EITHER.
 *
 * pendingEmbedRows (embeddings.js, #161) runs once per batch of a 114k-photo
 * embedding backfill and anti-joins two tables: photo_embeddings (has this
 * photo already been vectorised under this model?) and ml_status (did it
 * already fail permanently under this model?). Same silent-rot risk as the
 * feed's date-group indexes above — if either anti-join degrades to a SCAN,
 * every one of the ~2,000+ batches a full backfill takes re-reads a whole
 * table, nothing errors, and the app just quietly gets slow again.
 *
 * What actually serves these anti-joins, verified empirically below, is each
 * table's own composite PRIMARY KEY (photo_id, model) / (photo_id, stage,
 * model) — photo_id is the correlated value AND the leading PK column, so
 * SQLite plans off the PK's automatic UNIQUE index. idx_photo_embeddings_model
 * and idx_ml_status_lookup (schema.js) are NOT what protects this query — they
 * exist for embedCounts' and modelStorage's (stage, model)-only filters, which
 * have no photo_id to correlate on. An earlier draft of this test assumed
 * those two named indexes were the guard and asserted red/green by toggling
 * idx_ml_status_lookup; that stayed green with the index removed (decoration),
 * which is what surfaced the mix-up. The red/green proof that survived is: an
 * ml_status/photo_embeddings schema with NEITHER a PK NOR a secondary index
 * scans (verified by hand against a throwaway schema); the real schema, with
 * its PK, does not.
 */
describe("the embed worklist's query plans", () => {
  it("the embed worklist's anti-joins use an index, not a scan (#161)", () => {
    // Exercises the REAL pendingEmbedRows function rather than a hand-copied
    // copy of its SQL, for the same anti-drift reason as the sweep and
    // place-backfill tests above: a hand-typed WHERE clause silently stops
    // matching the real query and the plan test keeps passing on a query
    // nobody runs.
    const db = getDb();
    seed(db);

    const statements = capturingSql(db, () => pendingEmbedRows(db, "m", 10));
    expect(statements.length).toBeGreaterThan(0);

    const plan = statements.flatMap((s) => planFor(db, s));
    const detail = plan.join("\n");

    // SQLite's plan detail names the query's own aliases (`e` for
    // photo_embeddings, `s` for ml_status — see pendingEmbedRows), not the
    // table names, so that's what these match against.
    expect(detail).toMatch(/SEARCH e USING (COVERING )?INDEX/);
    expect(detail).toMatch(/SEARCH s USING (COVERING )?INDEX/);
    expect(detail).not.toMatch(/SCAN e\b/);
    expect(detail).not.toMatch(/SCAN s\b/);
  });

  it("the embed worklist still returns the right rows, so the plan test above is not asserting a typo", () => {
    // A plan assertion alone can't tell an index that serves the WRONG rows
    // (e.g. keyed on the wrong stage) from one that serves the right ones —
    // both would plan identically. This proves the anti-join actually excludes
    // a photo once it has a failure sentinel for this model.
    const db = getDb();
    const rows = seed(db);
    const failedId = rows[0].id;
    markEmbedFailed(db, failedId, "m", new Error("boom"));

    const pending = pendingEmbedRows(db, "m", 100).map((r) => r.id);
    expect(pending).not.toContain(failedId);
    expect(pending.length).toBe(rows.length - 1);
  });
});

/**
 * The face map's points are read on every map load, and there may be three
 * cached runs for the current model at once (`pruneRuns` keeps three). Reading
 * a run therefore has to seek to that run, not scan every point of every run.
 *
 * `projection_point` is WITHOUT ROWID with `PRIMARY KEY (run_id, ref_id)`, so
 * the primary key IS the table and one run's points are a contiguous prefix.
 * Drop either half and SQLite silently falls back to scanning — no error, the
 * map just gets slower as more runs accumulate. Exactly the rot this file
 * exists to catch (#232).
 */
describe("projection point lookup", () => {
  it("seeks to one run rather than scanning every run's points", () => {
    const db = getDb();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT projection_point.ref_id, projection_point.x, projection_point.y
           FROM projection_point
           JOIN persons ON persons.id = projection_point.ref_id
          WHERE projection_point.run_id = 1
          ORDER BY projection_point.ref_id`
      )
      .all()
      .map((r) => r.detail)
      .join(" | ");

    // A prefix seek on the WITHOUT ROWID primary key. SQLite words this as
    // "SEARCH ... USING PRIMARY KEY", never "SCAN", when the index is right.
    expect(plan).toMatch(/projection_point/);
    expect(plan).toMatch(/SEARCH .*projection_point.*PRIMARY KEY/);
    expect(plan).not.toMatch(/SCAN .*projection_point/);
  });

  it("finds a cached run by its whole key without scanning the runs table", () => {
    // findRun runs on EVERY map request, including the cache-hit path whose
    // whole purpose is to be instant.
    const db = getDb();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM projection_runs
          WHERE kind = 'person' AND model = 'buffalo_s'
            AND algorithm = 'umap' AND params_key = 'abc'
          ORDER BY id DESC LIMIT 1`
      )
      .all()
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).toMatch(/idx_projection_runs_key/);
  });
});
