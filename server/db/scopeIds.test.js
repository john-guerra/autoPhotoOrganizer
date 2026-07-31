import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeScope, scopeClauseFor, resolveScope } from "./scopeIds.js";
import { getDb, _resetDbForTest } from "./connection.js";
import { buildFilter } from "./filters.js";
import { upsertScan } from "./photos.js";

describe("normalizeScope", () => {
  it("distinguishes 'no scope' from 'an empty scope'", () => {
    // THE distinction this module exists for. Collapsing these turns a user's
    // empty selection into a full-library sweep.
    expect(normalizeScope(null)).toBeNull();
    expect(normalizeScope(undefined)).toBeNull();
    expect(normalizeScope([])).toEqual([]);
  });

  it("keeps safe integers and drops everything that isn't one", () => {
    expect(normalizeScope([1, "2", 2.5, "x", 4, NaN, Infinity])).toEqual([
      1, 2, 4,
    ]);
  });

  it("coerces null and '' to id 0 — harmless, but not a typo", () => {
    // `Number(null) === 0` and `Number("") === 0`, and 0 IS a safe integer, so
    // both survive. Documented rather than filtered because photo ids are
    // INTEGER PRIMARY KEY starting at 1, so id 0 matches nothing — the scope
    // simply covers one fewer photo, which is the same outcome as dropping it.
    // Tightening this would change behaviour under the embed sweep too, and
    // that belongs in its own change, not smuggled into an extraction.
    expect(normalizeScope([null, "", 5])).toEqual([0, 0, 5]);
  });

  it("refuses a non-array as an EMPTY scope, never as no scope", () => {
    // A malformed body must act on nothing, not on everything. `"7"` is the
    // shape a hand-written curl gets wrong, and the expensive misreading is
    // to treat it as absent.
    expect(normalizeScope("7")).toEqual([]);
    expect(normalizeScope({ ids: [1] })).toEqual([]);
  });

  it("strips anything that could break out of the SQL literal list", () => {
    // The ids are inlined into SQL because SQLite has no array parameter, so
    // this filter IS the injection guard. The contract is not "rejects strings"
    // — it is "only NUMBERS ever reach the query". `"0x41"` coerces to 65 and
    // survives, which is fine: 65 cannot carry a payload.
    const hostile = [
      "1); DROP TABLE photos;--",
      "1 OR 1=1",
      "'; DELETE FROM photos WHERE '1'='1",
      "1,2); --",
    ];
    expect(normalizeScope(hostile)).toEqual([]);

    // Whatever survives is renderable as a bare integer list and nothing else.
    const clause = scopeClauseFor(normalizeScope([1, "2", "0x41"]));
    expect(clause).toBe("AND photos.id IN (1,2,65)");
    expect(clause).toMatch(/^AND photos\.id IN \((\d+,)*\d+\)$/);
  });
});

describe("scopeClauseFor", () => {
  it("emits nothing for an unscoped sweep", () => {
    expect(scopeClauseFor(null)).toBe("");
  });

  it("throws on an empty scope rather than emitting a match-everything clause", () => {
    // The caller must short-circuit to "no rows" first. Emitting "" here would
    // be a full-library sweep that looks like a scoped one, and the symptom
    // arrives as an hour of CPU rather than as an error.
    expect(() => scopeClauseFor([])).toThrow(/short-circuit/);
  });

  it("can scope a differently-named column", () => {
    expect(scopeClauseFor([3], "f.photo_id")).toBe("AND f.photo_id IN (3)");
  });
});

describe("resolveScope — a scope that cannot be enumerated on the wire (#245)", () => {
  let cacheDir;
  let db;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "ag-resolve-"));
    process.env.AUTOGALLERY_HOME = cacheDir;
    _resetDbForTest();
    db = getDb();
    // Six photos in one folder; the first three are rated 5.
    // The volumes row is required first — folders.volume_id is a real foreign
    // key, so upsertScan fails without it.
    db.prepare(
      `INSERT INTO volumes (id, label, uuid, last_mount_path, last_seen_at)
       VALUES (1, 'v', 'uuid-1', '/test', ?)`
    ).run(Date.now());
    upsertScan(
      db,
      "/vol/pics",
      1,
      Array.from({ length: 6 }, (_, i) => ({
        name: `p${i + 1}.jpg`,
        size: 10,
        mtimeMs: 1000 + i,
        kind: "image",
      }))
    );
    const ids = db.prepare(`SELECT id FROM photos ORDER BY id`).all();
    for (const { id } of ids.slice(0, 3)) {
      db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(id);
    }
  });

  afterEach(async () => {
    _resetDbForTest();
    await rm(cacheDir, { recursive: true, force: true });
    delete process.env.AUTOGALLERY_HOME;
  });

  const allIds = () =>
    db
      .prepare(`SELECT id FROM photos ORDER BY id`)
      .all()
      .map((r) => r.id);

  it("returns null for no scope at all, so the sweep stays a sweep", () => {
    expect(resolveScope(db, {}, buildFilter)).toBeNull();
  });

  it("resolves a filter to exactly the photos it matches", () => {
    const got = resolveScope(db, { filter: { minRating: 5 } }, buildFilter);
    expect(got).toEqual(allIds().slice(0, 3));
  });

  it("keeps an EMPTY selection empty instead of widening to the library", () => {
    // The whole point of the null/[] distinction, restated at this layer: an
    // empty selection that fell through to "no scope" would be an hour of
    // inference over everything, which is the most expensive possible way to
    // misread an empty array.
    expect(resolveScope(db, { ids: [] }, buildFilter)).toEqual([]);
    expect(resolveScope(db, { ids: [] }, buildFilter)).not.toBeNull();
  });

  it("prefers an explicit id list over a filter when both are sent", () => {
    // Narrower and explicit wins. Preferring the filter would silently widen
    // the operation, which is the wrong direction to fail in.
    const last = allIds().at(-1);
    expect(
      resolveScope(db, { ids: [last], filter: { minRating: 5 } }, buildFilter)
    ).toEqual([last]);
  });

  it("never returns a stale photo, whatever the scope", () => {
    const [first] = allIds();
    db.prepare(`UPDATE photos SET stale = 1 WHERE id = ?`).run(first);
    const got = resolveScope(db, { filter: { minRating: 5 } }, buildFilter);
    expect(got).not.toContain(first);
  });

  it("treats an explicit null filter as no scope, not as an empty one", () => {
    // `null` and an omitted key both mean "no scope" on the wire — the
    // contract UI-CONTRACTS.md already fixes for ids, held to for filters.
    expect(resolveScope(db, { filter: null }, buildFilter)).toBeNull();
    expect(resolveScope(db, { ids: null }, buildFilter)).toBeNull();
  });
});
