import { describe, it, expect } from "vitest";
import { placeFor } from "./place.js";

describe("placeFor", () => {
  it("resolves a well-known coordinate to its country and city", () => {
    const p = placeFor(4.711, -74.0721); // Bogota, Colombia
    expect(p.country).toBe("Colombia");
    expect(p.city).toBeTruthy();
  });

  it("returns the '' Unknown sentinel — never null — for missing coordinates", () => {
    expect(placeFor(null, null)).toEqual({ country: "", city: "" });
    expect(placeFor(undefined, undefined)).toEqual({ country: "", city: "" });
    expect(placeFor(4.711, null)).toEqual({ country: "", city: "" });
  });

  it("returns the sentinel rather than throwing when the geocoder finds nothing", () => {
    const p = placeFor(0, 0); // Null Island, mid-Atlantic
    expect(typeof p.country).toBe("string");
    expect(typeof p.city).toBe("string");
  });

  it("never throws on absurd input", () => {
    expect(() => placeFor(NaN, NaN)).not.toThrow();
    expect(placeFor(NaN, NaN)).toEqual({ country: "", city: "" });
  });
});
