import { describe, it, expect } from "vitest";
import { DEFAULT_ALBUM_PREFS, mergeAlbumPrefs } from "./albumPrefs.js";

describe("mergeAlbumPrefs", () => {
  it("returns defaults for null / empty", () => {
    expect(mergeAlbumPrefs(null)).toEqual(DEFAULT_ALBUM_PREFS);
    expect(mergeAlbumPrefs({})).toEqual(DEFAULT_ALBUM_PREFS);
  });

  it("overrides only provided keys", () => {
    expect(mergeAlbumPrefs({ template: "%Y/%Y_%m%b_%d" })).toMatchObject({
      template: "%Y/%Y_%m%b_%d",
      gapMode: "fixed",
      fixedGapMs: 86400000,
    });
  });

  it("rejects a bad gapMode and clamps a tiny gap", () => {
    expect(mergeAlbumPrefs({ gapMode: "bogus" }).gapMode).toBe("fixed");
    expect(mergeAlbumPrefs({ fixedGapMs: 5 }).fixedGapMs).toBe(1000);
  });

  it("defaults the 1-day fixed gap", () => {
    expect(DEFAULT_ALBUM_PREFS.fixedGapMs).toBe(86400000);
    expect(DEFAULT_ALBUM_PREFS.gapMode).toBe("fixed");
  });

  it("defaults the naming template to the date+folder format", () => {
    expect(DEFAULT_ALBUM_PREFS.template).toBe("%Y_%m%b_%d_%f");
    // Absent (first run / garbage) → the default.
    expect(mergeAlbumPrefs(null).template).toBe("%Y_%m%b_%d_%f");
    expect(mergeAlbumPrefs({}).template).toBe("%Y_%m%b_%d_%f");
    // A stored non-empty template is preserved verbatim.
    expect(mergeAlbumPrefs({ template: "%Y-%m-%d" }).template).toBe("%Y-%m-%d");
    // An EXPLICIT empty string is a real choice (the <folder>_<n> fallback).
    expect(mergeAlbumPrefs({ template: "" }).template).toBe("");
  });
});
