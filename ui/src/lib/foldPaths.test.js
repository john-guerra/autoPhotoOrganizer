import { describe, it, expect } from "vitest";
import { isPathUnder, isKeyUnder } from "./foldPaths.js";

const seg = (dimension, value) => ({ dimension, value });
// pathKey's shape: a JSON string of [[dimension, value], …].
const key = (...pairs) =>
  JSON.stringify(pairs.map((p) => [p.dimension, p.value]));

const YEAR_2025 = [seg("year", "2025")];
const DEC = [seg("year", "2025"), seg("month", "12")];
const DEC_13 = [seg("year", "2025"), seg("month", "12"), seg("day", "13")];

describe("isPathUnder", () => {
  it("a path is under itself", () => {
    expect(isPathUnder(YEAR_2025, YEAR_2025)).toBe(true);
  });

  it("a deeper path sharing the prefix is under the parent", () => {
    expect(isPathUnder(DEC, YEAR_2025)).toBe(true);
    expect(isPathUnder(DEC_13, YEAR_2025)).toBe(true);
  });

  it("a shorter path is NOT under a deeper parent", () => {
    expect(isPathUnder(YEAR_2025, DEC)).toBe(false);
  });

  it("a divergent sibling is not under the parent", () => {
    expect(
      isPathUnder([seg("year", "2024"), seg("month", "12")], YEAR_2025)
    ).toBe(false);
  });

  it("matches on BOTH dimension and value, not value alone", () => {
    // same value "12" but a different dimension must not count as under.
    expect(isPathUnder([seg("day", "12")], [seg("month", "12")])).toBe(false);
  });

  it("a non-array path is not under anything", () => {
    expect(isPathUnder(null, YEAR_2025)).toBe(false);
    expect(isPathUnder(undefined, YEAR_2025)).toBe(false);
  });
});

describe("isKeyUnder", () => {
  it("a key is under its own path", () => {
    expect(isKeyUnder(key(...YEAR_2025), YEAR_2025)).toBe(true);
  });

  it("a deeper key sharing the prefix is under the parent", () => {
    expect(isKeyUnder(key(...DEC_13), YEAR_2025)).toBe(true);
  });

  it("a shorter key is not under a deeper parent", () => {
    expect(isKeyUnder(key(...YEAR_2025), DEC)).toBe(false);
  });

  it("a divergent key is not under the parent", () => {
    expect(isKeyUnder(key(seg("year", "2024")), YEAR_2025)).toBe(false);
  });

  it("matches on both dimension and value", () => {
    expect(isKeyUnder(key(seg("day", "12")), [seg("month", "12")])).toBe(false);
  });

  it("a malformed key is treated as not-under, never throws", () => {
    expect(isKeyUnder("{not json", YEAR_2025)).toBe(false);
    expect(isKeyUnder(JSON.stringify({ a: 1 }), YEAR_2025)).toBe(false);
  });
});
