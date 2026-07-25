import { describe, it, expect } from "vitest";
import { ALL_DIMENSIONS, DIMENSION_LABELS } from "./dimensions.js";

describe("DIMENSION_LABELS", () => {
  it('labels "city" as "Nearest town", not "City" — the geocoder returns the nearest small town, not the expected city (#154)', () => {
    expect(DIMENSION_LABELS.city).toBe("Nearest town");
  });

  it("has an entry for every ALL_DIMENSIONS key, so a new dimension can't ship with no label", () => {
    for (const dim of ALL_DIMENSIONS) {
      expect(DIMENSION_LABELS[dim], `missing label for "${dim}"`).toBeTypeOf(
        "string"
      );
    }
  });
});
