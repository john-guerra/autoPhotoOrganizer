import { describe, it, expect } from "vitest";
import {
  selectAll,
  selectNone,
  toggle,
  selectedDirs,
  subtreeState,
} from "./subfolderSelection.js";

const DIRS = [
  { path: "/c/trip", relPath: "trip", depth: 1, mediaCount: 4 },
  { path: "/c/trip/raw", relPath: "trip/raw", depth: 2, mediaCount: 2 },
  { path: "/c/trip/exports", relPath: "trip/exports", depth: 2, mediaCount: 1 },
  {
    path: "/c/trip/exports/web",
    relPath: "trip/exports/web",
    depth: 3,
    mediaCount: 5,
  },
  // A sibling that merely shares a name prefix: /c/tripX is NOT under /c/trip.
  { path: "/c/tripX", relPath: "tripX", depth: 1, mediaCount: 9 },
];

describe("subfolder selection", () => {
  it("starts with everything checked — opting out is the deliberate act", () => {
    expect(selectAll(DIRS).size).toBe(5);
  });

  it("selects none", () => {
    expect(selectNone()).toEqual(new Set());
  });

  it("returns a new Set each time (Svelte 4 reacts to reassignment)", () => {
    const all = selectAll(DIRS);
    expect(toggle(all, "/c/trip/raw", DIRS)).not.toBe(all);
  });

  it("returns the checked paths in list order, ready for /api/scan", () => {
    const sel = toggle(selectAll(DIRS), "/c/trip/exports/web", DIRS);
    expect(selectedDirs(sel, DIRS)).toEqual([
      "/c/trip",
      "/c/trip/raw",
      "/c/trip/exports",
      "/c/tripX",
    ]);
  });

  it("returns nothing when nothing is checked", () => {
    expect(selectedDirs(selectNone(), DIRS)).toEqual([]);
  });

  describe("cascading to descendants", () => {
    it("unchecking a parent unchecks everything under it", () => {
      const sel = toggle(selectAll(DIRS), "/c/trip", DIRS);
      expect(selectedDirs(sel, DIRS)).toEqual(["/c/tripX"]);
    });

    it("checking a parent checks everything under it", () => {
      const sel = toggle(selectNone(), "/c/trip", DIRS);
      expect(selectedDirs(sel, DIRS)).toEqual([
        "/c/trip",
        "/c/trip/raw",
        "/c/trip/exports",
        "/c/trip/exports/web",
      ]);
    });

    it("cascades all the way down, not just one level", () => {
      const sel = toggle(selectNone(), "/c/trip/exports", DIRS);
      expect(sel.has("/c/trip/exports/web")).toBe(true);
    });

    it("never touches a sibling that just shares a name prefix", () => {
      // /c/tripX starts with the string "/c/trip", but it is not inside it.
      const sel = toggle(selectAll(DIRS), "/c/trip", DIRS);
      expect(sel.has("/c/tripX")).toBe(true);
    });

    it("leaves a child's siblings alone when the child is toggled", () => {
      const sel = toggle(selectAll(DIRS), "/c/trip/raw", DIRS);
      expect(sel.has("/c/trip")).toBe(true);
      expect(sel.has("/c/trip/exports")).toBe(true);
      expect(sel.has("/c/trip/raw")).toBe(false);
    });
  });

  describe("subtreeState — what the parent's checkbox shows", () => {
    it("is 'all' when the folder and everything under it is checked", () => {
      expect(subtreeState(selectAll(DIRS), "/c/trip", DIRS)).toBe("all");
    });

    it("is 'none' when the folder and everything under it is unchecked", () => {
      expect(subtreeState(selectNone(), "/c/trip", DIRS)).toBe("none");
    });

    it("is 'some' when a descendant is excluded — the parent must not look fully checked", () => {
      const sel = toggle(selectAll(DIRS), "/c/trip/raw", DIRS);
      expect(subtreeState(sel, "/c/trip", DIRS)).toBe("some");
    });

    it("is 'some' when the parent is off but a descendant is on", () => {
      const sel = toggle(selectNone(), "/c/trip/raw", DIRS);
      expect(subtreeState(sel, "/c/trip", DIRS)).toBe("some");
    });

    it("is all-or-none for a leaf, which has no subtree to disagree with", () => {
      expect(subtreeState(selectAll(DIRS), "/c/trip/raw", DIRS)).toBe("all");
      expect(subtreeState(selectNone(), "/c/trip/raw", DIRS)).toBe("none");
    });
  });
});
