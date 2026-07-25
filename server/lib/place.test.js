import { describe, it, expect } from "vitest";
import { placeFor, _bestForTest, _bestLinearForTest } from "./place.js";

/** Deterministic PRNG (mulberry32) — fixed seed, so a failure is reproducible
 *  and CI doesn't flake on whichever point Math.random() happened to pick. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("placeFor", () => {
  it("returns the '' Unknown sentinel — never null — for missing coordinates", () => {
    expect(placeFor(null, null)).toEqual({ country: "", city: "" });
    expect(placeFor(undefined, undefined)).toEqual({ country: "", city: "" });
    expect(placeFor(4.711, null)).toEqual({ country: "", city: "" });
  });

  it("never throws on absurd input", () => {
    expect(() => placeFor(NaN, NaN)).not.toThrow();
    expect(placeFor(NaN, NaN)).toEqual({ country: "", city: "" });
    expect(placeFor(999, 999)).toEqual({ country: "", city: "" });
    expect(placeFor(Infinity, -Infinity)).toEqual({ country: "", city: "" });
  });

  it("still answers for a mid-ocean coordinate rather than throwing", () => {
    const p = placeFor(0, -160);
    expect(typeof p.country).toBe("string");
    expect(typeof p.city).toBe("string");
  });

  /**
   * #175. A photo shot in the Mission/Castro area of San Francisco was reported
   * as "Half Moon Bay" — a different town 33 km away over a mountain range —
   * because the previous dataset (UN/LOCODE, a shipping list) contained no
   * entry for San Francisco, Oakland, Berkeley, San Jose or Palo Alto at all.
   * These are the exact coordinates from that report plus its neighbours, and
   * they are the reason the geocoder was replaced.
   */
  describe("resolves major cities to themselves (#175)", () => {
    const cases = [
      ["San Francisco (the reported photo)", 37.758, -122.426, "San Francisco"],
      ["San Francisco, Union Square", 37.788, -122.4074, "San Francisco"],
      ["Oakland", 37.8044, -122.2712, "Oakland"],
      ["Berkeley", 37.8715, -122.273, "Berkeley"],
      ["San Jose", 37.3382, -121.8863, "San Jose"],
      ["Palo Alto", 37.4419, -122.143, "Palo Alto"],
    ];
    for (const [label, lat, lon, city] of cases) {
      it(label, () => {
        const p = placeFor(lat, lon);
        expect(p.city).toBe(city);
        expect(p.country).toBe("United States");
      });
    }
  });

  /**
   * The other half of the same fix: prominence must not STEAL a photo from a
   * genuinely distinct town just because a bigger city is nearby. Each of these
   * sits within ~15 km of a much larger neighbour, and each must keep its own
   * name. (A "prefer the most populous place nearby" rule reported all of them
   * as San Francisco / Bogotá / Paris.)
   */
  describe("keeps distinct nearby towns distinct", () => {
    const cases = [
      ["Half Moon Bay", 37.4636, -122.4286, "Half Moon Bay", "United States"],
      ["Sausalito", 37.8591, -122.4853, "Sausalito", "United States"],
      ["Daly City", 37.6879, -122.4702, "Daly City", "United States"],
      ["La Calera, Colombia", 4.7211, -73.9689, "La Calera", "Colombia"],
      ["Gif-sur-Yvette, France", 48.7005, 2.1348, "Gif-sur-Yvette", "France"],
    ];
    for (const [label, lat, lon, city, country] of cases) {
      it(label, () => {
        const p = placeFor(lat, lon);
        expect(p.city).toBe(city);
        expect(p.country).toBe(country);
      });
    }
  });

  /**
   * And prominence must still WIN where the nearest point is a minor locality
   * inside a large city — the case plain nearest-neighbour gets wrong (central
   * Bogotá's closest entry is a 2,000-person barrio).
   */
  describe("prefers the city over a minor locality inside it", () => {
    const cases = [
      ["Bogotá centre", 4.711, -74.0721, "Bogotá", "Colombia"],
      ["Paris centre", 48.8566, 2.3522, "Paris", "France"],
      ["Medellín", 6.2442, -75.5812, "Medellín", "Colombia"],
    ];
    for (const [label, lat, lon, city, country] of cases) {
      it(label, () => {
        const p = placeFor(lat, lon);
        expect(p.city).toBe(city);
        expect(p.country).toBe(country);
      });
    }
  });

  /**
   * `KM_PER_POPULATION_DECADE` was tuned against the cases above — all of
   * which are Bay Area, Bogotá, or Paris. That is a real overfitting risk: the
   * only evidence for the constant was the same set it was validated against.
   * These regions were never looked at while choosing it, checked here purely
   * as held-out evidence that "2" generalises rather than just fitting the
   * cases that happened to be tried.
   */
  describe("holds up on regions not used to tune the constant", () => {
    const cases = [
      ["Tokyo centre (Shibuya)", 35.6595, 139.7005, "Tokyo", "Japan"],
      ["Yokohama, near Tokyo", 35.4437, 139.638, "Yokohama", "Japan"],
      ["Mumbai centre", 18.975, 72.8258, "Mumbai", "India"],
      ["Pune, near Mumbai", 18.5204, 73.8567, "Pune", "India"],
      ["London centre (Soho)", 51.5136, -0.1365, "London", "UK"],
      ["Croydon, near London", 51.3762, -0.0982, "Croydon", "UK"],
      ["Berlin centre", 52.52, 13.405, "Berlin", "Germany"],
      ["Potsdam, near Berlin", 52.3906, 13.0645, "Potsdam", "Germany"],
    ];
    for (const [label, lat, lon, city, country] of cases) {
      it(label, () => {
        const p = placeFor(lat, lon);
        expect(p.city).toBe(city);
        expect(p.country).toBe(country);
      });
    }
  });
});

/**
 * The two-phase ring/radius-bound grid search (best() in place.js) is a
 * genuinely non-trivial custom index — antimeridian wraparound, pole capping,
 * a non-monotonic score. Its ONLY prior validation ("0 mismatches on 3000
 * random points") lived in a throwaway script that was never committed,
 * which — per this project's own testing rule — proves nothing about the
 * shipped code. This is that check, for real, in the suite: grid vs. an
 * exhaustive linear scan over the identical built index, so a divergence can
 * only come from the grid's search strategy, never from a data difference.
 */
describe("the grid index agrees with brute force", () => {
  it("on 500 deterministic worldwide points", () => {
    const rand = mulberry32(20260725);
    const mismatches = [];
    for (let i = 0; i < 500; i++) {
      const lat = rand() * 178 - 89;
      const lon = rand() * 360 - 180;
      const grid = _bestForTest(lat, lon);
      const linear = _bestLinearForTest(lat, lon);
      if (grid?.city !== linear?.city || grid?.iso !== linear?.iso) {
        mismatches.push({ lat, lon, grid, linear });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("across the antimeridian (lon near +/-180)", () => {
    const points = [
      [51.0, 179.95],
      [51.0, -179.95],
      [-16.5, 179.99],
      [63.0, -179.5],
      [0, 180],
      [0, -180],
    ];
    for (const [lat, lon] of points) {
      expect(_bestForTest(lat, lon)).toEqual(_bestLinearForTest(lat, lon));
    }
  });

  it("near the poles", () => {
    const points = [
      [89.9, 0],
      [89.9, 90],
      [89.9, -170],
      [-89.9, 30],
      [-89.9, -60],
    ];
    for (const [lat, lon] of points) {
      expect(_bestForTest(lat, lon)).toEqual(_bestLinearForTest(lat, lon));
    }
  });
});
