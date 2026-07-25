import { describe, it, expect } from "vitest";
import { ALL_DIMENSIONS, DIMENSION_LABELS } from "./dimensions.js";

describe("DIMENSION_LABELS", () => {
  it('labels "city" as "City" — the #175 geocoder replacement retired the "Nearest town" hedge (#154/#175)', () => {
    expect(DIMENSION_LABELS.city).toBe("City");
  });

  it("has an entry for every ALL_DIMENSIONS key, so a new dimension can't ship with no label", () => {
    for (const dim of ALL_DIMENSIONS) {
      expect(DIMENSION_LABELS[dim], `missing label for "${dim}"`).toBeTypeOf(
        "string"
      );
    }
  });
});
