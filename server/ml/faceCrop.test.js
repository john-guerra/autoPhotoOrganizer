import { describe, it, expect } from "vitest";
import { squareCrop, CROP_MARGIN } from "./faceCrop.js";

const IMG = { width: 4000, height: 3000 };

/** Every rectangle sharp will accept: integer, inside the image, non-empty. */
function expectExtractable(r, image = IMG) {
  for (const v of [r.left, r.top, r.width, r.height]) {
    expect(Number.isInteger(v)).toBe(true);
  }
  expect(r.width).toBeGreaterThanOrEqual(1);
  expect(r.height).toBe(r.width); // square
  expect(r.left).toBeGreaterThanOrEqual(0);
  expect(r.top).toBeGreaterThanOrEqual(0);
  expect(r.left + r.width).toBeLessThanOrEqual(image.width);
  expect(r.top + r.height).toBeLessThanOrEqual(image.height);
}

describe("squareCrop", () => {
  it("centres a square on the face and adds margin", () => {
    const r = squareCrop({ x: 1000, y: 1000, w: 200, h: 200 }, IMG);
    expectExtractable(r);
    // 200 * (1 + 2*0.35) = 340
    expect(r.width).toBe(Math.round(200 * (1 + 2 * CROP_MARGIN)));
    // Centre preserved: face centre is (1100, 1100).
    expect(r.left + r.width / 2).toBeCloseTo(1100, 0);
    expect(r.top + r.height / 2).toBeCloseTo(1100, 0);
  });

  it("squares off a tall box using its LONGER side", () => {
    // A tall detection must not be squashed into the square tile, and must not
    // lose the top of the head to a width-derived square.
    const r = squareCrop({ x: 100, y: 100, w: 80, h: 200 }, IMG);
    expect(r.width).toBe(Math.round(200 * (1 + 2 * CROP_MARGIN)));
    expectExtractable(r);
  });

  it("SHIFTS a crop back inside instead of shrinking it, at an edge", () => {
    // A face at the very left of the frame should still fill its tile — a
    // shrunk crop would render smaller and blurrier than its neighbours for no
    // reason the user can see.
    const r = squareCrop({ x: 0, y: 0, w: 200, h: 200 }, IMG);
    expect(r.left).toBe(0);
    expect(r.top).toBe(0);
    expect(r.width).toBe(Math.round(200 * (1 + 2 * CROP_MARGIN)));
    expectExtractable(r);
  });

  it("stays inside at the far corner", () => {
    const r = squareCrop({ x: 3900, y: 2900, w: 150, h: 150 }, IMG);
    expectExtractable(r);
    expect(r.left + r.width).toBe(IMG.width);
    expect(r.top + r.height).toBe(IMG.height);
  });

  it("never exceeds the shorter side of the image", () => {
    // A huge box in a small image: no placement of an over-large square fits,
    // so this is the one case where it must shrink. Getting it wrong is an
    // `extract_area: bad extract area` 500 on a face tile.
    const small = { width: 300, height: 200 };
    const r = squareCrop({ x: 0, y: 0, w: 900, h: 900 }, small);
    expect(r.width).toBe(200);
    expectExtractable(r, small);
  });

  it("survives a degenerate stored box rather than producing a zero-width extract", () => {
    // sharp rejects a zero-width region outright, so a bad row would 500 the
    // tile instead of drawing something wrong-but-visible.
    for (const box of [
      { x: 10, y: 10, w: 0, h: 0 },
      { x: 10, y: 10, w: -5, h: -5 },
    ]) {
      expectExtractable(squareCrop(box, IMG));
    }
  });

  it("handles a box that starts outside the image", () => {
    // Detection runs on the oriented original, but a stale row from a photo
    // that was re-oriented or replaced could name a box that no longer fits.
    // It must clamp, not throw.
    expectExtractable(squareCrop({ x: -50, y: -50, w: 100, h: 100 }, IMG));
    expectExtractable(squareCrop({ x: 5000, y: 4000, w: 100, h: 100 }, IMG));
  });

  it("is extractable for a spread of boxes across the frame", () => {
    // A property sweep rather than another example: every position must yield
    // a rectangle sharp accepts, because one that doesn't is a broken tile.
    for (let x = 0; x < IMG.width; x += 337) {
      for (let y = 0; y < IMG.height; y += 271) {
        expectExtractable(squareCrop({ x, y, w: 120, h: 160 }, IMG));
      }
    }
  });
});
