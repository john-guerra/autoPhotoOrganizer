import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getFeedPage } from "./feed.js";
import { getTreeNode } from "./tree.js";
import { feedIndexes } from "./sort.js";

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

  it("finds the sweep's un-read photos by index, not by scanning the library", () => {
    // enrich.js asks "which photos have width IS NULL" once per batch — ~2,000
    // times during a full sweep. Unindexed, that is a full scan every time.
    const db = getDb();
    seed(db);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT photos.id FROM photos JOIN folders ON folders.id = photos.folder_id
          WHERE photos.stale = 0 AND photos.width IS NULL
          ORDER BY photos.id ASC LIMIT 50`
      )
      .all()
      .map((r) => r.detail);
    expect(plan.some((l) => isFullScan(l))).toBe(false);
  });
});
