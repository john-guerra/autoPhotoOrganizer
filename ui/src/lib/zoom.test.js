import { describe, it, expect } from "vitest";
import {
  ZOOM_LEVELS,
  LEGACY_ZOOM_LEVELS,
  DEFAULT_ROW_HEIGHT,
  resolveZoom,
  gapFor,
} from "./zoom.js";

describe("resolveZoom", () => {
  it("restores the saved row height", () => {
    expect(ZOOM_LEVELS[resolveZoom({ px: "300" })]).toBe(300);
    expect(ZOOM_LEVELS[resolveZoom({ px: "60" })]).toBe(60);
  });

  it("keeps a pre-upgrade user at the SAME size, not the same index", () => {
    // The whole point of storing px. A user parked on the old smallest level
    // (index 0 = 120px) must still get 120px, not the new index 0 (60px).
    for (const [oldIndex, px] of LEGACY_ZOOM_LEVELS.entries()) {
      expect(ZOOM_LEVELS[resolveZoom({ legacyIndex: String(oldIndex) })]).toBe(
        px
      );
    }
  });

  it("prefers the new key once it exists", () => {
    expect(ZOOM_LEVELS[resolveZoom({ px: "90", legacyIndex: "4" })]).toBe(90);
  });

  it("falls back to the default for a fresh, absent, or junk preference", () => {
    for (const stored of [
      {},
      { px: null, legacyIndex: null },
      { px: "" },
      { px: "abc" },
      { px: "137" }, // a level that no longer exists
      { legacyIndex: "99" },
      { legacyIndex: "-1" },
    ]) {
      expect(ZOOM_LEVELS[resolveZoom(stored)]).toBe(DEFAULT_ROW_HEIGHT);
    }
  });
});

describe("gapFor", () => {
  it("shrinks the gutter with the tile so small zooms aren't mostly gap", () => {
    expect(gapFor(60)).toBe(4);
    expect(gapFor(90)).toBe(4);
    expect(gapFor(120)).toBe(8);
    expect(gapFor(400)).toBe(8);
  });
});
