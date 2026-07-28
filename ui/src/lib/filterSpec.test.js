import { describe, it, expect } from "vitest";
import {
  DEFAULT_FILTER,
  isActive,
  toQueryParam,
  ORIENTATIONS,
  KINDS,
  applyRatingClick,
  toggleOrientation,
  toggleKind,
} from "./filterSpec.js";

describe("filterSpec", () => {
  it("the default is inactive", () => {
    expect(isActive(DEFAULT_FILTER)).toBe(false);
    expect(toQueryParam(DEFAULT_FILTER)).toBe(null);
  });
  it("rating threshold activates", () => {
    const s = { minRating: 3, orientations: ORIENTATIONS };
    expect(isActive(s)).toBe(true);
    expect(JSON.parse(toQueryParam(s))).toEqual({ minRating: 3 });
  });
  it("a strict orientation subset activates; full set does not", () => {
    expect(isActive({ minRating: 0, orientations: ["portrait"] })).toBe(true);
    expect(isActive({ minRating: 0, orientations: ORIENTATIONS })).toBe(false);
    expect(isActive({ minRating: 0, orientations: [] })).toBe(false);
    expect(
      JSON.parse(toQueryParam({ minRating: 0, orientations: ["portrait"] }))
    ).toEqual({
      orientations: ["portrait"],
    });
  });
  it("a strict kind subset activates; full set does not", () => {
    expect(isActive({ ...DEFAULT_FILTER, kinds: ["video"] })).toBe(true);
    expect(isActive({ ...DEFAULT_FILTER, kinds: KINDS })).toBe(false);
    expect(isActive({ ...DEFAULT_FILTER, kinds: [] })).toBe(false);
    expect(
      JSON.parse(toQueryParam({ ...DEFAULT_FILTER, kinds: ["video"] }))
    ).toEqual({ kinds: ["video"] });
  });
  it("toggleKind adds/removes a kind in canonical order", () => {
    const off = toggleKind({ ...DEFAULT_FILTER, kinds: [] }, "video");
    expect(off.kinds).toEqual(["video"]);
    const two = toggleKind({ ...DEFAULT_FILTER, kinds: ["video"] }, "image");
    expect(two.kinds).toEqual(["image", "video"]);
    const back = toggleKind(two, "video");
    expect(back.kinds).toEqual(["image"]);
  });
  it("a folderPath focus activates and round-trips through toQueryParam", () => {
    expect(isActive({ ...DEFAULT_FILTER, folderPath: "/photos/trip" })).toBe(
      true
    );
    expect(isActive({ ...DEFAULT_FILTER, folderPath: "" })).toBe(false);
    expect(
      JSON.parse(
        toQueryParam({ ...DEFAULT_FILTER, folderPath: "/photos/trip" })
      )
    ).toEqual({ folderPath: "/photos/trip" });
  });
  it("a time-range bound activates and round-trips through toQueryParam", () => {
    expect(isActive({ ...DEFAULT_FILTER, dateFrom: 1000 })).toBe(true);
    expect(isActive({ ...DEFAULT_FILTER, dateTo: 2000 })).toBe(true);
    expect(isActive(DEFAULT_FILTER)).toBe(false); // both null
    expect(
      JSON.parse(
        toQueryParam({ ...DEFAULT_FILTER, dateFrom: 1000, dateTo: 2000 })
      )
    ).toEqual({ dateFrom: 1000, dateTo: 2000 });
  });
});

describe("applyRatingClick", () => {
  it("sets the threshold to the clicked star", () => {
    expect(
      applyRatingClick({ minRating: 0, orientations: ORIENTATIONS }, 4)
        .minRating
    ).toBe(4);
  });
  it("clicking the current threshold star clears to Any (0)", () => {
    expect(
      applyRatingClick({ minRating: 4, orientations: ORIENTATIONS }, 4)
        .minRating
    ).toBe(0);
  });
  it("preserves orientations untouched", () => {
    expect(
      applyRatingClick({ minRating: 0, orientations: ["portrait"] }, 2)
        .orientations
    ).toEqual(["portrait"]);
  });
});

describe("toggleOrientation", () => {
  it("removes an included orientation", () => {
    expect(
      toggleOrientation(
        { minRating: 0, orientations: ORIENTATIONS },
        "landscape"
      ).orientations
    ).toEqual(["portrait", "square"]);
  });
  it("adds an excluded orientation back in canonical order", () => {
    expect(
      toggleOrientation({ minRating: 0, orientations: ["square"] }, "landscape")
        .orientations
    ).toEqual(["landscape", "square"]);
  });
  it("preserves minRating untouched", () => {
    expect(
      toggleOrientation(
        { minRating: 3, orientations: ORIENTATIONS },
        "portrait"
      ).minRating
    ).toBe(3);
  });
});

describe("saved semantic tag facet (#164)", () => {
  it("counts as an active filter", () => {
    // Otherwise the toolbar reports "no filters" while the feed is narrowed to
    // 40 photos — the same lie as any other missing facet.
    expect(isActive({ ...DEFAULT_FILTER, tag: "sunset" })).toBe(true);
    expect(isActive({ ...DEFAULT_FILTER })).toBe(false);
  });

  it("travels in the query param", () => {
    // The third of the three layers a facet needs. Correct SQL and correct UI
    // still reach nothing if the key never leaves the client.
    const q = JSON.parse(toQueryParam({ ...DEFAULT_FILTER, tag: "sunset" }));
    expect(q.tag).toBe("sunset");
  });

  it("is absent, not empty, when off", () => {
    // `tag: ""` would still travel and would still have to be special-cased
    // server-side; the key simply should not be there.
    const q = toQueryParam({ ...DEFAULT_FILTER, tag: "" });
    expect(q).toBeNull();
  });
});

describe("the person facet (#167)", () => {
  it("travels in the query spec", () => {
    // Layer three of three. A facet missing here is silently dropped however
    // correct the SQL and the allowlist are — and it looks like nothing at
    // all from the client side.
    expect(JSON.parse(toQueryParam({ personId: 7 })).personId).toBe(7);
  });

  it("counts as an active filter", () => {
    // Filtering to one person narrows the library hard. An unreported
    // narrowing is how "where did my photos go" happens.
    expect(isActive({ personId: 7 })).toBe(true);
    expect(isActive({})).toBe(false);
  });

  it("ignores a non-id rather than sending it", () => {
    // toQueryParam returns null for a spec with nothing active, which is the
    // stronger outcome: an invalid personId produces no query param at all
    // rather than one the server then has to reject.
    const q = (v) => {
      const raw = toQueryParam({ personId: v });
      return raw ? JSON.parse(raw).personId : undefined;
    };
    expect(q(0)).toBeUndefined();
    expect(q("7")).toBeUndefined();
    expect(q(null)).toBeUndefined();
  });
});
