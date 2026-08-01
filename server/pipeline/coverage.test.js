import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "../db/connection.js";
import { upsertScan } from "../db/photos.js";
import { coverage, coverageFor, namedFilter } from "./coverage.js";
import { pendingMetaCount } from "../db/enrich.js";

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

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-cov-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
  db = getDb();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("namedFilter", () => {
  it("rewrites positional placeholders so the stage predicates can bind", () => {
    // Not stylistic: better-sqlite3 refuses a statement mixing `?` and `@name`,
    // and the stage predicates use `@model`/`@faceModel`.
    const { sql, params } = namedFilter({ minRating: 3 });
    expect(sql).not.toContain("?");
    expect(sql).toContain("@f0");
    expect(params).toEqual({ f0: 3 });
  });

  it("leaves a no-op filter alone", () => {
    expect(namedFilter({})).toEqual({ sql: "1=1", params: {} });
  });

  it("keeps every value, in order, across several facets", () => {
    const { sql, params } = namedFilter({ minRating: 2, kinds: ["image"] });
    const n = Object.keys(params).length;
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) expect(sql).toContain(`@f${i}`);
  });
});

describe("coverageFor — counting by anti-join, never by subtraction (#261)", () => {
  it("counts pending per stage over the whole library", () => {
    seed(4);
    const got = coverageFor(db, {}, MODELS);
    expect(got.photos).toBe(4);
    expect(got.stages.meta.pending).toBe(4);
    expect(got.stages.hash.pending).toBe(4);
    expect(got.stages.embed.pending).toBe(4);
    expect(got.stages.faces.pending).toBe(4);
  });

  it("agrees with the worklist's own count, which is the whole point", () => {
    // A count that says "N pending" while the sweep processes a different N is
    // worse than no count: the user plans around the first and watches the
    // second. Both come from `pendingWhere`, so they cannot drift.
    const ids = seed(5);
    db.prepare(
      `UPDATE photos SET width = 9, gps_checked = 1 WHERE id <= ?`
    ).run(ids[1]);
    expect(coverageFor(db, {}, MODELS).stages.meta.pending).toBe(
      pendingMetaCount(db)
    );
  });

  it("never reports a negative pending, whatever has gone stale", () => {
    // The #261 shape: `total - done - failed` across differently-filtered
    // populations could go below zero. An anti-join cannot.
    const ids = seed(3);
    for (const id of ids) {
      db.prepare(
        `INSERT INTO ml_status (photo_id, stage, model, state, updated_at)
         VALUES (?, 'faces', 'fm', 'done', 0)`
      ).run(id);
    }
    db.prepare(`UPDATE photos SET stale = 1 WHERE id = ?`).run(ids[0]);
    const got = coverageFor(db, {}, MODELS);
    expect(got.photos).toBe(2);
    expect(got.stages.faces.pending).toBe(0);
    for (const s of Object.values(got.stages)) {
      expect(s.pending).toBeGreaterThanOrEqual(0);
    }
  });

  it("narrows to a filter without enumerating a single id", () => {
    const ids = seed(4);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id <= ?`).run(ids[1]);
    const got = coverageFor(db, { filter: { minRating: 5 } }, MODELS);
    expect(got.photos).toBe(2);
    expect(got.stages.hash.pending).toBe(2);
  });

  it("narrows to an explicit selection", () => {
    const ids = seed(4);
    const got = coverageFor(db, { ids: [ids[0], ids[3]] }, MODELS);
    expect(got.photos).toBe(2);
    expect(got.stages.embed.pending).toBe(2);
  });

  it("treats an EMPTY selection as zero photos, never as the library", () => {
    // The expensive direction, and the one that has bitten this repo before:
    // an empty selection widening to everything is how a click becomes an hour
    // of inference.
    seed(5);
    const got = coverageFor(db, { ids: [] }, MODELS);
    expect(got.photos).toBe(0);
    for (const s of Object.values(got.stages)) expect(s.pending).toBe(0);
  });

  it("counts faces per MODEL, so switching packs shows real work", () => {
    const ids = seed(2);
    db.prepare(
      `INSERT INTO ml_status (photo_id, stage, model, state, updated_at)
       VALUES (?, 'faces', 'fm', 'done', 0)`
    ).run(ids[0]);
    expect(coverageFor(db, {}, MODELS).stages.faces.pending).toBe(1);
    expect(
      coverageFor(db, {}, { model: "m", faceModel: "other" }).stages.faces
        .pending
    ).toBe(2);
  });

  it("excludes RAW from embed but not from hashing", () => {
    const ids = seed(3);
    db.prepare(`UPDATE photos SET kind = 'raw' WHERE id = ?`).run(ids[0]);
    const got = coverageFor(db, {}, MODELS);
    expect(got.stages.embed.pending).toBe(2);
    expect(got.stages.hash.pending).toBe(3);
  });
});

describe("coverage — every scope in one read", () => {
  it("always answers for the library, and only for what was asked otherwise", () => {
    seed(3);
    const bare = coverage(db, {}, MODELS);
    expect(bare.library.photos).toBe(3);
    expect(bare.filtered).toBeUndefined();
    expect(bare.selected).toBeUndefined();
  });

  it("answers library, filtered and selected together, consistently", () => {
    // One read, so the three cannot disagree the way four round trips landing
    // out of order can — which is the class of failure #245 was made of.
    const ids = seed(6);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id <= ?`).run(ids[2]);
    const got = coverage(
      db,
      { filter: { minRating: 5 }, ids: [ids[0], ids[5]] },
      MODELS
    );
    expect(got.library.photos).toBe(6);
    expect(got.filtered.photos).toBe(3);
    expect(got.selected.photos).toBe(2);
  });

  it("distinguishes an empty selection from no selection at all", () => {
    seed(4);
    expect(coverage(db, { ids: [] }, MODELS).selected.photos).toBe(0);
    expect(coverage(db, { ids: null }, MODELS).selected).toBeUndefined();
    expect(coverage(db, {}, MODELS).selected).toBeUndefined();
  });
});
