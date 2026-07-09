import { describe, it, expect } from "vitest";
import {
  DEFAULT_FILTER,
  isActive,
  toQueryParam,
  ORIENTATIONS,
  applyRatingClick,
  toggleOrientation,
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
    expect(JSON.parse(toQueryParam({ minRating: 0, orientations: ["portrait"] }))).toEqual({
      orientations: ["portrait"],
    });
  });
});

describe("applyRatingClick", () => {
  it("sets the threshold to the clicked star", () => {
    expect(applyRatingClick({ minRating: 0, orientations: ORIENTATIONS }, 4).minRating).toBe(4);
  });
  it("clicking the current threshold star clears to Any (0)", () => {
    expect(applyRatingClick({ minRating: 4, orientations: ORIENTATIONS }, 4).minRating).toBe(0);
  });
  it("preserves orientations untouched", () => {
    expect(applyRatingClick({ minRating: 0, orientations: ["portrait"] }, 2).orientations).toEqual([
      "portrait",
    ]);
  });
});

describe("toggleOrientation", () => {
  it("removes an included orientation", () => {
    expect(toggleOrientation({ minRating: 0, orientations: ORIENTATIONS }, "landscape").orientations).toEqual([
      "portrait",
      "square",
    ]);
  });
  it("adds an excluded orientation back in canonical order", () => {
    expect(toggleOrientation({ minRating: 0, orientations: ["square"] }, "landscape").orientations).toEqual([
      "landscape",
      "square",
    ]);
  });
  it("preserves minRating untouched", () => {
    expect(toggleOrientation({ minRating: 3, orientations: ORIENTATIONS }, "portrait").minRating).toBe(3);
  });
});
