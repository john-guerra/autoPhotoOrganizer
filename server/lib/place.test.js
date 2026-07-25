import { describe, it, expect } from "vitest";
import { placeFor } from "./place.js";

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
});
