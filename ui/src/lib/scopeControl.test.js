import { describe, it, expect } from "vitest";
import {
  buildScopes,
  activeScope,
  scopeIdsFor,
  scopeRequestFor,
  formatEstimate,
  DEFAULT_SCOPE,
} from "./scopeControl.js";

const sets = { selectedIds: [1, 2, 3], filteredCount: 5 };

describe("buildScopes", () => {
  it("offers three scopes when no working set is in force", () => {
    const scopes = buildScopes({ ...sets, allCount: 900 });
    expect(scopes.map((s) => s.key)).toEqual(["selected", "filtered", "all"]);
    expect(scopes.map((s) => s.n)).toEqual([3, 5, 900]);
  });

  it("adds 'Keep only' ONLY while a working set is in force (#245)", () => {
    // Without one it is the same set as All, and a duplicate option is worse
    // than three: it invites the user to distinguish two identical things.
    const off = buildScopes({ ...sets, allCount: 900, keepCount: 40 });
    expect(off.map((s) => s.key)).not.toContain("keep");

    const on = buildScopes({
      ...sets,
      allCount: 900,
      keepCount: 40,
      keepActive: true,
    });
    expect(on.map((s) => s.key)).toEqual([
      "selected",
      "filtered",
      "keep",
      "all",
    ]);
    expect(on.find((s) => s.key === "keep").n).toBe(40);
  });

  it("discloses the overlap when the selection and the filter disagree", () => {
    // A selection SURVIVES a filter change by design, so "Selected" can hold
    // photos "Filtered" excludes. Both numbers are true; the control has to
    // say which is which rather than imply one is a subset of the other.
    const [sel] = buildScopes({ ...sets, selectedInFilter: 2, allCount: 9 });
    expect(sel.n).toBe(3);
    expect(sel.note).toBe("2 in the current filter");
  });

  it("stays quiet when they agree, so a real disagreement is not skimmed past", () => {
    const [sel] = buildScopes({ ...sets, selectedInFilter: 3, allCount: 9 });
    expect(sel.note).toBeUndefined();
  });

  it("claims nothing about the overlap when it is unknown", () => {
    const [sel] = buildScopes({ ...sets, allCount: 9 });
    expect(sel.note).toBeUndefined();
  });

  it("counts every scope, including the empty ones", () => {
    // "Selected (0)" is what makes the choice real — the contract offers an
    // empty scope disabled rather than hiding it, so the set of choices does
    // not shift under the cursor as the selection changes.
    const scopes = buildScopes({
      selectedIds: [],
      filteredCount: 0,
      allCount: 0,
    });
    expect(scopes.map((s) => s.n)).toEqual([0, 0, 0]);
  });

  it("lets the caller rename 'All' for what it actually means", () => {
    // Embedding's "All" is PENDING photos, not the library — the label has to
    // be able to say so.
    const [, , all] = buildScopes({ allCount: 7, allLabel: "All remaining" });
    expect(all.label).toBe("All remaining");
  });

  it("never reports a negative count", () => {
    // `total - done - failed` can go negative on a library mid-repair; a
    // "-3 photos" scope is nonsense the user cannot act on.
    expect(buildScopes({ allCount: -3 })[2].n).toBe(0);
  });
});

describe("activeScope", () => {
  it("finds the chosen scope", () => {
    const scopes = buildScopes({ ...sets, allCount: 9 });
    expect(activeScope(scopes, "filtered").n).toBe(5);
  });

  it("falls back to All for an unknown or missing choice", () => {
    const scopes = buildScopes({ ...sets, allCount: 9 });
    expect(activeScope(scopes, "nope").key).toBe("all");
    expect(activeScope(scopes, undefined).key).toBe("all");
  });
});

describe("scopeRequestFor — what goes on the wire (#245)", () => {
  const spec = { minRating: 3 };

  it("enumerates ONLY the selection", () => {
    expect(scopeRequestFor("selected", { selectedIds: [1, 2, 3] })).toEqual({
      ids: [1, 2, 3],
    });
  });

  it("sends the filter SPEC for Filtered, never an id list", () => {
    // "Filtered" with no facets active is the whole library — 125,000 ids in a
    // request body. It has to travel as a description the server resolves.
    const req = scopeRequestFor("filtered", { filterSpec: spec });
    expect(req).toEqual({ filter: spec });
    expect(req.ids).toBeUndefined();
  });

  it("sends the keepScope flag for the working set, whose ids live server-side", () => {
    expect(scopeRequestFor("keep", {})).toEqual({
      filter: { keepScope: true },
    });
  });

  it("sends NOTHING for the whole-library sweep", () => {
    // An omitted key and null both mean "no scope"; only an actual empty array
    // means "these zero photos".
    expect(scopeRequestFor("all", { selectedIds: [1] })).toEqual({});
  });

  it("sends [] — not {} — for an empty selection", () => {
    // The expensive direction. Sending {} would turn "I selected nothing" into
    // a full-library sweep, which is the whole of #221.
    expect(scopeRequestFor("selected", { selectedIds: [] })).toEqual({
      ids: [],
    });
  });
});

describe("scopeIdsFor — the deprecated shape", () => {
  it("still answers for the one scope that IS a list", () => {
    expect(scopeIdsFor("selected", sets)).toEqual([1, 2, 3]);
    expect(scopeIdsFor("all", sets)).toBeNull();
  });

  it("THROWS for the scopes that cannot be enumerated", () => {
    // Not politeness — this is the #245 bug's shape. A caller that still
    // thinks in ids must fail loudly, because the alternative is silently
    // acting on a fraction of what the user asked for and reporting success.
    expect(() => scopeIdsFor("filtered", sets)).toThrow(/cannot be enumerated/);
    expect(() => scopeIdsFor("keep", sets)).toThrow(/cannot be enumerated/);
  });
});

describe("formatEstimate", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatEstimate(10, 500)).toBe("about 5s");
    expect(formatEstimate(600, 500)).toBe("about 5 min");
    expect(formatEstimate(60_000, 500)).toBe("about 8.3 h");
  });

  it("never says 0s for real work", () => {
    // Sub-second work still takes a moment; "about 0s" reads as "instant" and
    // then the UI blocks.
    expect(formatEstimate(1, 10)).toBe("about 1s");
  });

  it("returns null when there is nothing to estimate", () => {
    // The caller says "nothing to do in this scope" — an estimate of "about
    // 0s" for an empty scope would be an answer to a question nobody asked.
    expect(formatEstimate(0, 500)).toBeNull();
    expect(formatEstimate(100, undefined)).toBeNull();
    expect(formatEstimate(100, 0)).toBeNull();
  });
});

describe("the default scope", () => {
  it("is a scope that buildScopes actually offers, and is never the empty one", () => {
    // Not decoration: this fails if DEFAULT_SCOPE is ever pointed at a key
    // buildScopes doesn't emit (the panel would open on nothing), and it
    // encodes WHY the default isn't "selected" — the panel is usually opened
    // with an empty selection, and a default that is empty starts the primary
    // button out disabled.
    const scopes = buildScopes({
      selectedIds: [],
      filteredCount: 0,
      allCount: 9,
    });
    const chosen = activeScope(scopes, DEFAULT_SCOPE);
    expect(scopes.map((s) => s.key)).toContain(DEFAULT_SCOPE);
    expect(chosen.n).toBe(9);
  });
});
