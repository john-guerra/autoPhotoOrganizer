import { describe, it, expect, beforeEach } from "vitest";
import {
  loadSettings,
  saveSettings,
  canGoLive,
  estimateMs,
  LIVE_MS,
} from "./mapSettings.js";

// vitest runs under `environment: "node"` and neither jsdom nor happy-dom is a
// dependency — see the same stub in scope.test.js, and the `typeof` guard in
// albumPrefs.js that exists for this reason.
if (typeof localStorage === "undefined") {
  globalThis.localStorage = (() => {
    const store = new Map();
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  })();
}

beforeEach(() => localStorage.clear());

describe("map settings persistence, on top of settings.js (#287)", () => {
  it("round-trips what was saved", () => {
    saveSettings({ nNeighbors: 42, minFaces: 3 });
    expect(loadSettings()).toEqual({ nNeighbors: 42, minFaces: 3 });
  });

  it("returns an empty object rather than throwing on corrupt storage", () => {
    localStorage.setItem("autogallery.faceMapParams", "{not json");
    expect(loadSettings()).toEqual({});
  });

  it("drops a stored value that is not a finite number", () => {
    // A string would reach defaultParams and become part of a cache key — the
    // shape of #325, one layer up.
    localStorage.setItem(
      "autogallery.faceMapParams",
      JSON.stringify({ nNeighbors: "50", minFaces: 3, seed: NaN })
    );
    expect(loadSettings()).toEqual({ minFaces: 3 });
  });

  it("survives storage holding a non-object", () => {
    localStorage.setItem("autogallery.faceMapParams", JSON.stringify(7));
    expect(loadSettings()).toEqual({});
  });
});

describe("the live boundary (#327)", () => {
  it("goes live when the last projection was fast", () => {
    expect(canGoLive(83)).toBe(true);
  });

  it("stays on Apply when the last projection was slow", () => {
    expect(canGoLive(3100)).toBe(false);
  });

  it("does NOT go live with neither a measurement nor a member count", () => {
    // Optimism here means a 25,758-person library locks up on the first drag,
    // which is exactly the case the boundary exists to prevent.
    expect(canGoLive(null)).toBe(false);
    expect(canGoLive(undefined)).toBe(false);
    expect(canGoLive(NaN)).toBe(false);
  });

  it("falls back to the fitted estimate before anything is measured", () => {
    // Without this the small library can never become live: a measurement only
    // arrives from a preview, and a preview only happens in live mode.
    expect(canGoLive(null, 203)).toBe(true);
    expect(canGoLive(null, 25_758)).toBe(false);
  });

  it("prefers a real measurement over the estimate", () => {
    // The estimate says a 203-person library is fast. If this machine measured
    // 3.1s, the machine wins.
    expect(canGoLive(3100, 203)).toBe(false);
    expect(canGoLive(90, 25_758)).toBe(true);
  });

  it("estimates from the curve fitted to real runs", () => {
    // ms = 3.29 * n^0.80. Measured: 21 -> 46ms, 203 -> 201ms, 852 -> 842ms.
    expect(estimateMs(203)).toBeGreaterThan(150);
    expect(estimateMs(203)).toBeLessThan(400);
    expect(estimateMs(25_758)).toBeGreaterThan(5_000);
    expect(estimateMs(null)).toBe(null);
    expect(estimateMs(0)).toBe(null);
  });

  it("draws the line at 400ms", () => {
    expect(LIVE_MS).toBe(400);
    expect(canGoLive(LIVE_MS - 1)).toBe(true);
    expect(canGoLive(LIVE_MS)).toBe(false);
  });
});
