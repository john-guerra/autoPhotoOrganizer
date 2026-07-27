import { describe, it, expect } from "vitest";
import {
  CROP_SIZE,
  packDetectorInput,
  packAlignedCrop,
  detectorResizePlan,
} from "./faceTensors.js";
import { DET_SIZE, ARCFACE_TEMPLATE } from "./faceGeometry.js";

/** An HWC RGB buffer whose channels are distinguishable, so a CHW/HWC mix-up
 *  shows up as wrong VALUES rather than as a wrong length. */
function rgbBuffer(width, height, fn) {
  const b = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, bl] = fn(x, y);
      const i = (y * width + x) * 3;
      b[i] = r;
      b[i + 1] = g;
      b[i + 2] = bl;
    }
  }
  return b;
}

describe("detector input packing", () => {
  it("normalizes to [-1, 1] around zero, not to [0, 1]", () => {
    // Both models were trained on (x - 127.5) / 128. A [0,1] input is a
    // different distribution and the network has no way to say so -- it
    // returns 512 plausible floats and the clusters stop being people.
    const buf = rgbBuffer(DET_SIZE, DET_SIZE, () => [0, 127.5, 255]);
    const t = packDetectorInput(buf);
    const plane = DET_SIZE * DET_SIZE;

    expect(t[0]).toBeCloseTo(-127.5 / 128, 6); // black -> just under -1
    expect(t[2 * plane]).toBeCloseTo(127.5 / 128, 6); // white -> just under +1
    // A mid-grey must land at ~0, which is what "centred" means. Under a /255
    // normalization this would be ~0.5.
    expect(Math.abs(t[plane])).toBeLessThan(0.01);
  });

  it("packs CHW, not HWC", () => {
    // Same length either way, so nothing throws -- the tensor is just wrong.
    // Give each channel a constant so the planes are trivially checkable.
    const buf = rgbBuffer(DET_SIZE, DET_SIZE, () => [10, 20, 30]);
    const t = packDetectorInput(buf);
    const plane = DET_SIZE * DET_SIZE;

    const chan = (c) => new Set(t.slice(c * plane, (c + 1) * plane));
    expect(chan(0).size).toBe(1);
    expect(chan(1).size).toBe(1);
    expect(chan(2).size).toBe(1);
    expect([...chan(0)][0]).toBeCloseTo((10 - 127.5) / 128, 6);
    expect([...chan(1)][0]).toBeCloseTo((20 - 127.5) / 128, 6);
    expect([...chan(2)][0]).toBeCloseTo((30 - 127.5) / 128, 6);
  });

  it("refuses a buffer of the wrong size instead of reading past the end", () => {
    // Reading past the end yields undefined -> NaN, and a tensor of NaNs
    // returns zero faces on every photo, which is indistinguishable from
    // "the model found nobody".
    expect(() => packDetectorInput(new Uint8Array(100))).toThrow(/expected/);
  });
});

describe("the aligned crop", () => {
  it("puts the eyes where ArcFace expects them", () => {
    // The contract is: a face whose keypoints are at `kps` in the source ends
    // up with those points at the TEMPLATE coordinates in the crop. Mark each
    // source keypoint with a unique bright pixel and check it lands.
    const W = 400;
    const H = 300;
    // A source face, rotated and scaled relative to the template.
    const kps = ARCFACE_TEMPLATE.map(([x, y]) => [2 * x + 100, 2 * y + 40]);
    // A DISC, not a single pixel. The crop downsamples 2x here, so an integer
    // crop pixel inverse-maps to a non-integer source point and a one-pixel
    // mark is a knife edge -- the test would be measuring rounding, not
    // alignment.
    const R = 4;
    const buf = rgbBuffer(W, H, (x, y) =>
      kps.some(([kx, ky]) => Math.hypot(x - kx, y - ky) <= R)
        ? [255, 255, 255]
        : [0, 0, 0]
    );

    const crop = packAlignedCrop(buf, W, H, kps);
    const background = crop[0]; // a corner, far from every keypoint
    for (const [tx, ty] of ARCFACE_TEMPLATE) {
      const o = Math.round(ty) * CROP_SIZE + Math.round(tx);
      expect(crop[o]).toBeGreaterThan(background + 1);
    }
    // And the alignment must be TIGHT, not merely "something bright nearby":
    // a point well away from every template position stays background.
    expect(crop[10 * CROP_SIZE + 10]).toBeCloseTo(background, 5);
  });

  it("clamps at the frame edge rather than padding with black", () => {
    // A detected box routinely runs off the side of the shot. Zero-filling
    // there puts a hard false edge inside the crop; clamping repeats the edge
    // pixel, which is what every reference implementation does.
    const W = 60;
    const H = 60;
    const buf = rgbBuffer(W, H, () => [200, 200, 200]); // uniformly bright
    // Keypoints near the corner, so the crop demands pixels off-frame.
    const kps = ARCFACE_TEMPLATE.map(([x, y]) => [x * 0.4 - 8, y * 0.4 - 8]);

    const crop = packAlignedCrop(buf, W, H, kps);
    const expected = (200 - 127.5) / 128;
    // If off-frame samples were zero-filled the minimum would be ~-1; if they
    // were left unclamped the read would be out of bounds and NaN.
    let min = Infinity;
    for (const v of crop) min = Math.min(min, v);
    expect(Number.isNaN(min)).toBe(false);
    expect(min).toBeCloseTo(expected, 5);
  });

  it("clamps at the FAR edge too, not just at the origin", () => {
    // Both bounds need covering separately: a `n < lo ? 0 : n` that forgets
    // the upper clamp still passes the near-edge case, because clamping a
    // negative index to 0 is what the correct code does anyway. The bug only
    // shows when the crop runs off the BOTTOM-RIGHT.
    const W = 50;
    const H = 50;
    // A GRADIENT, not a flat fill: with a uniform image, "clamp to the edge"
    // and "wrap to index 0" produce identical pixels, so a flat fixture cannot
    // tell a correct upper clamp from one that returns 0. Here the origin is
    // black and the far corner is bright, so the two answers differ.
    const buf = rgbBuffer(W, H, (x, y) => {
      const v = Math.round((255 * (x + y)) / (W + H - 2));
      return [v, v, v];
    });
    // Keypoints near the far corner, so the crop demands pixels past W and H.
    const kps = ARCFACE_TEMPLATE.map(([x, y]) => [x * 0.4 + 30, y * 0.4 + 30]);

    const crop = packAlignedCrop(buf, W, H, kps);
    let min = Infinity;
    for (const v of crop) min = Math.min(min, v);
    expect(Number.isNaN(min)).toBe(false);
    // Everything this crop touches lives in the bright half of the gradient.
    // Wrapping an off-frame sample to index 0 would drag in the black corner.
    const halfway = (128 - 127.5) / 128;
    expect(min).toBeGreaterThan(halfway);
  });

  it("interpolates rather than snapping to the nearest pixel", () => {
    // A face is nearly always resampled at a non-integer scale, and
    // nearest-neighbour aliasing on eyes and mouth corners is the exact
    // detail the recognizer keys on.
    const W = 64;
    const H = 64;
    // A horizontal ramp: any true interpolation produces values BETWEEN the
    // integer sample levels.
    const buf = rgbBuffer(W, H, (x) => [x * 4, x * 4, x * 4]);
    const kps = ARCFACE_TEMPLATE.map(([x, y]) => [
      x * 0.37 + 5.5,
      y * 0.37 + 5.5,
    ]);
    const crop = packAlignedCrop(buf, W, H, kps);

    const levels = new Set(
      [...crop].map((v) => Math.round((v * 128 + 127.5) * 1000))
    );
    // With nearest-neighbour every sample is an exact multiple of 4.
    const offGrid = [...levels].filter((l) => Math.abs((l / 1000) % 4) > 0.01);
    expect(offGrid.length).toBeGreaterThan(0);
  });

  it("rejects a keypoint count the template cannot match", () => {
    const buf = rgbBuffer(20, 20, () => [0, 0, 0]);
    expect(() =>
      packAlignedCrop(buf, 20, 20, [
        [1, 1],
        [2, 2],
      ])
    ).toThrow(/5 keypoints/);
  });

  it("rejects a buffer smaller than the dimensions claim", () => {
    const buf = rgbBuffer(10, 10, () => [0, 0, 0]);
    expect(() => packAlignedCrop(buf, 100, 100, ARCFACE_TEMPLATE)).toThrow(
      /needs/
    );
  });
});

describe("the resize plan", () => {
  it("pads bottom-right only, because the decoder assumes top-left anchoring", () => {
    // A CENTRED pad would shift every decoded keypoint by half the padding --
    // silently, since the boxes stay plausible.
    const p = detectorResizePlan(4000, 3000);
    expect(p.resize).toEqual({ width: DET_SIZE, height: 480 });
    expect(p.pad).toEqual({
      top: 0,
      left: 0,
      bottom: DET_SIZE - 480,
      right: 0,
    });
  });

  it("fills the square exactly, whichever edge is long", () => {
    for (const [w, h] of [
      [4000, 3000],
      [3000, 4000],
      [1000, 1000],
      [8000, 100],
    ]) {
      const p = detectorResizePlan(w, h);
      expect(p.resize.width + p.pad.right).toBe(DET_SIZE);
      expect(p.resize.height + p.pad.bottom).toBe(DET_SIZE);
    }
  });
});
