import { describe, it, expect } from "vitest";
import {
  buildScopes,
  activeScope,
  scopeIdsFor,
  formatEstimate,
  DEFAULT_SCOPE,
} from "./scopeControl.js";

const sets = { selectedIds: [1, 2, 3], visibleIds: [1, 2, 3, 4, 5] };

describe("buildScopes", () => {
  it("offers the three scopes in the order the contract fixes", () => {
    const scopes = buildScopes({ ...sets, allCount: 900 });
    expect(scopes.map((s) => s.key)).toEqual(["selected", "visible", "all"]);
    expect(scopes.map((s) => s.n)).toEqual([3, 5, 900]);
  });

  it("counts every scope, including the empty ones", () => {
    // "Selected (0)" is what makes the choice real — the contract offers an
    // empty scope disabled rather than hiding it, so the set of choices does
    // not shift under the cursor as the selection changes.
    const scopes = buildScopes({
      selectedIds: [],
      visibleIds: [],
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
    expect(activeScope(scopes, "visible").n).toBe(5);
  });

  it("falls back to All for an unknown or missing choice", () => {
    const scopes = buildScopes({ ...sets, allCount: 9 });
    expect(activeScope(scopes, "nope").key).toBe("all");
    expect(activeScope(scopes, undefined).key).toBe("all");
  });
});

describe("scopeIdsFor", () => {
  it("sends the selection or the visible set", () => {
    expect(scopeIdsFor("selected", sets)).toEqual([1, 2, 3]);
    expect(scopeIdsFor("visible", sets)).toEqual([1, 2, 3, 4, 5]);
  });

  it("sends null — not [] — for the whole-library sweep", () => {
    // The server treats [] as "these zero photos" and null as "everything".
    // Returning [] here would make "All" a no-op that looks like a hang.
    expect(scopeIdsFor("all", sets)).toBeNull();
  });

  it("sends [] — not null — for an empty selection", () => {
    // The expensive direction. Returning null would turn "I selected nothing"
    // into a full-library sweep, which is the whole of #221.
    expect(
      scopeIdsFor("selected", { selectedIds: [], visibleIds: [9] })
    ).toEqual([]);
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
      visibleIds: [],
      allCount: 9,
    });
    const chosen = activeScope(scopes, DEFAULT_SCOPE);
    expect(scopes.map((s) => s.key)).toContain(DEFAULT_SCOPE);
    expect(chosen.n).toBe(9);
  });
});
