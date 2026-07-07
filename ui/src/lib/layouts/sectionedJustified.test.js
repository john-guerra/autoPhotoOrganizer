import { describe, it, expect } from "vitest";
import { justifiedLayout, layoutHeight } from "./justified.js";
import { sectionedJustifiedLayout } from "./sectionedJustified.js";

const opts = { targetRowHeight: 200, containerWidth: 1000, gap: 10 };
const headerHeight = 32;

function items(n) {
  return Array.from({ length: n }, (_, id) => ({ id, aspectRatio: 1.5 }));
}

describe("sectionedJustifiedLayout", () => {
  it("behaves like plain justifiedLayout when there are no headers", () => {
    const its = items(9);
    const plain = justifiedLayout(its, opts);
    const { boxes, headers, totalHeight } = sectionedJustifiedLayout(
      its,
      [],
      { ...opts, headerHeight }
    );
    expect(boxes).toEqual(plain);
    expect(headers).toEqual([]);
    // The single (only) chunk still gets its trailing inter-chunk gap added,
    // same as justifiedLayout's own row loop advances `y` by `+ gap` after
    // its last row without that trailing gap showing up in layoutHeight.
    expect(totalHeight).toBeCloseTo(layoutHeight(plain) + opts.gap, 6);
  });

  it("reserves a band for a single header at index 0 and shifts all boxes down", () => {
    const its = items(9);
    const plain = justifiedLayout(its, opts);
    const headersIn = [
      { index: 0, depth: 0, dimension: "folder", value: "/a", label: "/a" },
    ];
    const { boxes, headers, totalHeight } = sectionedJustifiedLayout(
      its,
      headersIn,
      { ...opts, headerHeight }
    );
    expect(headers).toHaveLength(1);
    expect(headers[0].y).toBe(0);
    expect(headers[0].endY).toBe(totalHeight);
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].x).toBeCloseTo(plain[i].x, 6);
      expect(boxes[i].width).toBeCloseTo(plain[i].width, 6);
      expect(boxes[i].height).toBeCloseTo(plain[i].height, 6);
      expect(boxes[i].y).toBeCloseTo(plain[i].y + headerHeight, 6);
    }
  });

  it("splits two sibling headers at the same depth so no row spans the boundary", () => {
    const its = items(10);
    const headersIn = [
      { index: 0, depth: 0, dimension: "folder", value: "/a", label: "/a" },
      { index: 5, depth: 0, dimension: "folder", value: "/b", label: "/b" },
    ];
    const { boxes, headers, totalHeight } = sectionedJustifiedLayout(
      its,
      headersIn,
      { ...opts, headerHeight }
    );
    expect(headers).toHaveLength(2);
    const [h0, h1] = headers;
    expect(h0.index).toBe(0);
    expect(h1.index).toBe(5);
    expect(h0.endY).toBe(h1.y);
    expect(h1.endY).toBe(totalHeight);

    const before = boxes.slice(0, 5);
    const after = boxes.slice(5);
    const maxBeforeY = Math.max(...before.map((b) => b.y));
    const minAfterY = Math.min(...after.map((b) => b.y));
    expect(minAfterY).toBeGreaterThan(maxBeforeY);
  });

  it("handles nested headers (depth 0 spanning both years, depth 1 per-year)", () => {
    const its = items(10);
    const headersIn = [
      { index: 0, depth: 0, dimension: "folder", value: "/a", label: "/a" },
      { index: 0, depth: 1, dimension: "year", value: "2020", label: "2020" },
      { index: 5, depth: 1, dimension: "year", value: "2019", label: "2019" },
    ];
    const { headers, totalHeight } = sectionedJustifiedLayout(
      its,
      headersIn,
      { ...opts, headerHeight }
    );
    expect(headers).toHaveLength(3);

    const depth0 = headers.find((h) => h.depth === 0);
    const [year2020, year2019] = headers
      .filter((h) => h.depth === 1)
      .sort((a, b) => a.index - b.index);

    expect(depth0.index).toBe(0);
    expect(depth0.y).toBe(0);
    expect(depth0.endY).toBe(totalHeight);

    expect(year2020.index).toBe(0);
    expect(year2019.index).toBe(5);
    expect(year2020.endY).toBe(year2019.y);
    expect(year2019.endY).toBe(totalHeight);
  });

  it("reserves a band for a placeholder, excludes it from photo packing, and keeps boxes index-aligned with items", () => {
    const its = [
      ...items(4),
      { id: "ph-1", placeholder: true },
      ...items(4).map((it) => ({ ...it, id: it.id + 100 })),
    ];
    const { boxes, totalHeight } = sectionedJustifiedLayout(its, [], {
      ...opts,
      headerHeight,
      placeholderHeight: 40,
    });
    expect(boxes).toHaveLength(its.length); // one box per item, including the placeholder
    const placeholderBox = boxes[4];
    expect(placeholderBox).toEqual({
      id: "ph-1",
      x: 0,
      y: expect.any(Number),
      width: opts.containerWidth,
      height: 40,
      placeholder: true,
    });
    const before = boxes.slice(0, 4);
    const after = boxes.slice(5);
    expect(before.every((b) => !b.placeholder)).toBe(true);
    expect(after.every((b) => !b.placeholder)).toBe(true);
    const maxBeforeY = Math.max(...before.map((b) => b.y));
    const minAfterY = Math.min(...after.map((b) => b.y));
    expect(placeholderBox.y).toBeGreaterThanOrEqual(maxBeforeY);
    expect(placeholderBox.y + placeholderBox.height).toBeLessThanOrEqual(
      minAfterY
    );
    expect(totalHeight).toBeGreaterThan(
      placeholderBox.y + placeholderBox.height
    );
  });

  it("combines a placeholder with a header at the same index without conflict", () => {
    const its = [
      ...items(3),
      { id: "ph-1", placeholder: true },
      ...items(3).map((it) => ({ ...it, id: it.id + 100 })),
    ];
    const headersIn = [
      { index: 3, depth: 0, dimension: "year", value: "2019", label: "2019" },
    ];
    const { boxes, headers } = sectionedJustifiedLayout(its, headersIn, {
      ...opts,
      headerHeight,
      placeholderHeight: 40,
    });
    expect(boxes).toHaveLength(its.length);
    expect(boxes[3].placeholder).toBe(true);
    expect(headers).toHaveLength(1);
    expect(boxes[3].y).toBeGreaterThanOrEqual(headers[0].y + headerHeight);
  });
});
