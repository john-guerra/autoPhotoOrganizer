import { describe, it, expect } from "vitest";
import {
  selectAll,
  selectNone,
  toggle,
  selectedDirs,
} from "./subfolderSelection.js";

const DIRS = [
  { path: "/c/trip", relPath: "trip", depth: 1, mediaCount: 4 },
  { path: "/c/trip/raw", relPath: "trip/raw", depth: 2, mediaCount: 2 },
  { path: "/c/trip/exports", relPath: "trip/exports", depth: 2, mediaCount: 1 },
];

describe("subfolder selection", () => {
  it("starts with everything checked — opting out is the deliberate act", () => {
    expect(selectAll(DIRS)).toEqual(
      new Set(["/c/trip", "/c/trip/raw", "/c/trip/exports"])
    );
  });

  it("selects none", () => {
    expect(selectNone()).toEqual(new Set());
  });

  it("toggles one path off and back on, returning a new Set each time", () => {
    const all = selectAll(DIRS);
    const off = toggle(all, "/c/trip/exports");
    expect(off.has("/c/trip/exports")).toBe(false);
    expect(off).not.toBe(all); // new reference: Svelte 4 reacts to reassignment
    expect(toggle(off, "/c/trip/exports").has("/c/trip/exports")).toBe(true);
  });

  it("returns the checked paths in list order, ready for /api/scan", () => {
    const sel = toggle(selectAll(DIRS), "/c/trip/exports");
    expect(selectedDirs(sel, DIRS)).toEqual(["/c/trip", "/c/trip/raw"]);
  });

  it("returns nothing when nothing is checked", () => {
    expect(selectedDirs(selectNone(), DIRS)).toEqual([]);
  });
});
