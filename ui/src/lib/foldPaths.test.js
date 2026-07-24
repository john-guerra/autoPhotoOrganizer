import { describe, it, expect } from "vitest";
import {
  isPathUnder,
  isKeyUnder,
  foldTargetFor,
  aggregateAncestorKeyFor,
  isPathUnderAggregate,
} from "./foldPaths.js";

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

describe("foldTargetFor (#142 parent-fold gesture)", () => {
  it("a parent, plain click, aggregates the whole subtree", () => {
    expect(foldTargetFor({ isParent: true, shiftKey: false })).toBe(
      "aggregate"
    );
  });

  it("a parent, shift-click, fans out to per-leaf snapshots", () => {
    expect(foldTargetFor({ isParent: true, shiftKey: true })).toBe("perLeaf");
  });

  it("a leaf, plain click, is just a leaf (its ordinary single-group cycle)", () => {
    expect(foldTargetFor({ isParent: false, shiftKey: false })).toBe("leaf");
  });

  it("a leaf, shift-click, is STILL a leaf — shift has nothing to fan out", () => {
    expect(foldTargetFor({ isParent: false, shiftKey: true })).toBe("leaf");
  });
});

describe("aggregateAncestorKeyFor / isPathUnderAggregate (#142 review — ancestor-blind jumpToPath)", () => {
  const CARDS = [seg("folder", "/L/Cards")];
  const CAM1 = [seg("folder", "/L/Cards/Cam1")];
  const CAM1_DEEP = [seg("folder", "/L/Cards/Cam1/RAW")];
  const SELECTS = [seg("folder", "/L/Selects")]; // sibling, shares no prefix
  const CARDS_2024 = [seg("year", "2024"), seg("folder", "/L/Cards")];
  const CAM1_2024 = [seg("year", "2024"), seg("folder", "/L/Cards/Cam1")];
  const CAM1_2023 = [seg("year", "2023"), seg("folder", "/L/Cards/Cam1")];

  it("the aggregated folder's own path is under itself", () => {
    const aggregateKeys = new Set([key(...CARDS)]);
    expect(aggregateAncestorKeyFor(CARDS, aggregateKeys)).toBe(key(...CARDS));
    expect(isPathUnderAggregate(CARDS, aggregateKeys)).toBe(true);
  });

  it("a direct child folder is under the aggregated ancestor — abs_path prefix, not array shape", () => {
    // Cam1's group path is the SAME LENGTH as Cards' (one folder segment
    // either way) — only the string value differs. An array-prefix test
    // (isPathUnder) would say Cam1 is NOT under Cards; the real containment
    // is a "/"-prefix test on the path string, same as folderTree.js's chainTo.
    const aggregateKeys = new Set([key(...CARDS)]);
    expect(aggregateAncestorKeyFor(CAM1, aggregateKeys)).toBe(key(...CARDS));
    expect(isPathUnderAggregate(CAM1, aggregateKeys)).toBe(true);
  });

  it("a grandchild folder is also under the aggregated ancestor", () => {
    const aggregateKeys = new Set([key(...CARDS)]);
    expect(isPathUnderAggregate(CAM1_DEEP, aggregateKeys)).toBe(true);
  });

  it("a sibling folder that merely shares no prefix is NOT under it", () => {
    const aggregateKeys = new Set([key(...CARDS)]);
    expect(aggregateAncestorKeyFor(SELECTS, aggregateKeys)).toBeNull();
    expect(isPathUnderAggregate(SELECTS, aggregateKeys)).toBe(false);
  });

  it("a folder that merely shares a NAME PREFIX (not a path separator) is not swallowed", () => {
    // "/L/Cards2" must not count as under "/L/Cards".
    const aggregateKeys = new Set([key(...CARDS)]);
    expect(
      isPathUnderAggregate([seg("folder", "/L/Cards2")], aggregateKeys)
    ).toBe(false);
  });

  it("every OTHER groupBy segment must match exactly — same folder value under a different year is not swallowed", () => {
    const aggregateKeys = new Set([key(...CARDS_2024)]);
    expect(isPathUnderAggregate(CAM1_2024, aggregateKeys)).toBe(true);
    expect(isPathUnderAggregate(CAM1_2023, aggregateKeys)).toBe(false);
  });

  it("nothing is under an empty aggregate set", () => {
    expect(isPathUnderAggregate(CAM1, new Set())).toBe(false);
    expect(aggregateAncestorKeyFor(CAM1, new Set())).toBeNull();
  });

  it("a non-array or empty path is never under anything, and never throws", () => {
    const aggregateKeys = new Set([key(...CARDS)]);
    expect(isPathUnderAggregate(null, aggregateKeys)).toBe(false);
    expect(isPathUnderAggregate([], aggregateKeys)).toBe(false);
  });
});
