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
      fixedGapMs: 60000,
    });
  });

  it("rejects a bad gapMode and clamps a tiny gap", () => {
    expect(mergeAlbumPrefs({ gapMode: "bogus" }).gapMode).toBe("fixed");
    expect(mergeAlbumPrefs({ fixedGapMs: 5 }).fixedGapMs).toBe(1000);
  });

  it("defaults the 1-minute fixed gap", () => {
    expect(DEFAULT_ALBUM_PREFS.fixedGapMs).toBe(60000);
    expect(DEFAULT_ALBUM_PREFS.gapMode).toBe("fixed");
  });
});
