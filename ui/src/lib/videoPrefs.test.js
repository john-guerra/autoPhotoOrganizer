import { describe, it, expect } from "vitest";
import {
  loadVideoPrefs,
  saveVideoPrefs,
  VIDEO_PREFS_KEY,
} from "./videoPrefs.js";

/** A localStorage stand-in — the real one isn't there under vitest's node env. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _dump: () => Object.fromEntries(map),
  };
}

describe("videoPrefs", () => {
  it("starts muted, so the first video of a fresh install can autoplay", () => {
    expect(loadVideoPrefs(fakeStorage())).toEqual({ muted: true, volume: 1 });
  });

  it("remembers un-muting, which is the whole point", () => {
    // THE BUG: the <video> was hardcoded `muted`, so every clip started silent
    // and you had to un-mute each one by hand. What you chose for the last video
    // is what you want for the next one.
    const storage = fakeStorage();
    saveVideoPrefs({ muted: false, volume: 0.4 }, storage);
    expect(loadVideoPrefs(storage)).toEqual({ muted: false, volume: 0.4 });
  });

  it("clamps a volume that would throw when assigned to a <video>", () => {
    // Assigning volume outside [0,1] raises — a corrupt entry must not be able to
    // take the loupe down with it.
    const storage = fakeStorage({
      [VIDEO_PREFS_KEY]: JSON.stringify({ muted: false, volume: 9 }),
    });
    expect(loadVideoPrefs(storage).volume).toBe(1);

    saveVideoPrefs({ muted: false, volume: -3 }, storage);
    expect(loadVideoPrefs(storage).volume).toBe(0);
  });

  it("falls back to the defaults on a malformed or partial entry", () => {
    expect(
      loadVideoPrefs(fakeStorage({ [VIDEO_PREFS_KEY]: "{{ not json" }))
    ).toEqual({ muted: true, volume: 1 });
    expect(
      loadVideoPrefs(
        fakeStorage({ [VIDEO_PREFS_KEY]: JSON.stringify({ volume: 0.5 }) })
      )
    ).toEqual({ muted: true, volume: 0.5 });
  });

  it("survives a storage that refuses to write (private mode, quota)", () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() =>
      saveVideoPrefs({ muted: false, volume: 1 }, hostile)
    ).not.toThrow();
  });
});
