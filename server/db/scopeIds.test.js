import { describe, it, expect } from "vitest";
import { normalizeScope, scopeClauseFor } from "./scopeIds.js";

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
