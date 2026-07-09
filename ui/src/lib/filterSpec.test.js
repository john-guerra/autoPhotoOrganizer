import { describe, it, expect } from "vitest";
import { DEFAULT_FILTER, isActive, toQueryParam, ORIENTATIONS } from "./filterSpec.js";

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
    expect(JSON.parse(toQueryParam({ minRating: 0, orientations: ["portrait"] }))).toEqual({
      orientations: ["portrait"],
    });
  });
});
