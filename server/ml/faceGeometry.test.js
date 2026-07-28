import { describe, it, expect } from "vitest";
import {
  DET_SIZE,
  STRIDES,
  ANCHORS_PER_CELL,
  ARCFACE_TEMPLATE,
  letterbox,
  decodeStride,
  suppressOverlaps,
  iou,
  similarityTransform,
  inverseMap,
  toSourceSpace,
} from "./faceGeometry.js";

/** Build the three heads for one stride with a single face planted at a known
 *  anchor, so the test asserts on a box whose correct answer is arithmetic
 *  rather than on "some box came back". */
function heads(
  stride,
  { index, dist = [4, 4, 4, 4], kpsDist = 2, score = 0.9 }
) {
  const rows = (DET_SIZE / stride) * (DET_SIZE / stride) * ANCHORS_PER_CELL;
  const s = new Float32Array(rows);
  const b = new Float32Array(rows * 4);
  const k = new Float32Array(rows * 10);
  s[index] = score;
  for (let i = 0; i < 4; i++) b[index * 4 + i] = dist[i];
  for (let i = 0; i < 10; i++) k[index * 10 + i] = kpsDist;
  return { score: s, bbox: b, kps: k };
}

describe("SCRFD output geometry", () => {
  it("the stride grids match the graph's declared output rows", () => {
    // 12800 / 3200 / 800 are what buffalo_l's detection.onnx actually declares.
    // If DET_SIZE or ANCHORS_PER_CELL is ever "tuned", this is the tripwire:
    // the decoder would index a grid the tensor does not have, and produce
    // plausible boxes in the wrong places rather than an error.
    const rows = STRIDES.map((s) => (DET_SIZE / s) ** 2 * ANCHORS_PER_CELL);
    expect(rows).toEqual([12800, 3200, 800]);
  });

  it("decodes distances from the anchor centre, scaled by the stride", () => {
    const stride = 32;
    const grid = DET_SIZE / stride; // 20
    // cell (3, 2) -> centre (96, 64); second anchor of that cell
    const cell = 2 * grid + 3;
    const index = cell * ANCHORS_PER_CELL + 1;
    const [f] = decodeStride(
      heads(stride, { index, dist: [1, 2, 3, 4] }),
      stride,
      0.5
    );

    expect(f.box).toEqual([96 - 32, 64 - 64, 96 + 96, 64 + 128]);
    // Every keypoint sat at distance 2 -> 64 px from the same centre.
    expect(f.kps[0]).toEqual([96 + 64, 64 + 64]);
    expect(f.kps).toHaveLength(5);
  });

  it("drops everything below the score threshold", () => {
    const h = heads(32, { index: 10, score: 0.3 });
    expect(decodeStride(h, 32, 0.5)).toEqual([]);
    expect(decodeStride(h, 32, 0.2)).toHaveLength(1);
  });

  it("walks the grid by ANCHORS_PER_CELL, not by row", () => {
    // The bug this guards: dividing the row index by 1 instead of 2 makes the
    // centre advance twice as fast, so boxes skew progressively across the
    // image -- worst at the right edge, invisible at the top-left.
    const stride = 32;
    const grid = DET_SIZE / stride;
    const lastCell = grid * grid - 1;
    const [f] = decodeStride(
      heads(stride, { index: lastCell * ANCHORS_PER_CELL, dist: [0, 0, 0, 0] }),
      stride,
      0.5
    );
    expect(f.box.slice(0, 2)).toEqual([
      (grid - 1) * stride,
      (grid - 1) * stride,
    ]);
  });
});

describe("overlap suppression", () => {
  it("keeps the strongest of three detections of one face", () => {
    // The real case: strides 8/16/32 all fire on the same person.
    const faces = [
      { score: 0.7, box: [10, 10, 50, 50] },
      { score: 0.9, box: [12, 11, 52, 51] },
      { score: 0.8, box: [11, 12, 49, 48] },
    ];
    const kept = suppressOverlaps(faces, 0.4);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(0.9);
  });

  it("keeps two genuinely separate people", () => {
    const kept = suppressOverlaps(
      [
        { score: 0.9, box: [0, 0, 40, 40] },
        { score: 0.8, box: [100, 100, 140, 140] },
      ],
      0.4
    );
    expect(kept).toHaveLength(2);
  });

  it("does not mutate the caller's array", () => {
    const faces = [
      { score: 0.1, box: [0, 0, 1, 1] },
      { score: 0.9, box: [50, 50, 60, 60] },
    ];
    suppressOverlaps(faces, 0.4);
    expect(faces[0].score).toBe(0.1);
  });

  it("scores a disjoint or degenerate box at 0, never NaN", () => {
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
    // A zero-area box is a real decoder output when a score barely clears.
    expect(iou([5, 5, 5, 5], [0, 0, 10, 10])).toBe(0);
  });
});

describe("the alignment transform", () => {
  const round = (n) => Math.round(n * 1e6) / 1e6;

  it("recovers a known rotation, scale and translation exactly", () => {
    const src = [
      [0, 0],
      [1, 0],
      [0, 1],
      [2, 3],
      [-1, 4],
    ];
    // 90 degrees, scale 2, shifted by (5, -7).
    const truth = ([x, y]) => [-2 * y + 5, 2 * x - 7];
    const t = similarityTransform(src, src.map(truth));
    expect(round(t.a)).toBe(0);
    expect(round(t.b)).toBe(2);
    expect(round(t.tx)).toBe(5);
    expect(round(t.ty)).toBe(-7);
  });

  it("stays a similarity under noise instead of shearing to fit", () => {
    // Five NOISY keypoints is the real input. An affine fit has six degrees of
    // freedom and would shear the crop to satisfy a mislocated mouth corner,
    // which a recognizer reads as a different person. A similarity cannot: its
    // two axes keep equal scale and stay perpendicular, whatever the noise.
    const src = [
      [10, 10],
      [40, 12],
      [25, 30],
      [14, 45],
      [38, 44],
    ];
    const noisy = ARCFACE_TEMPLATE.map(([x, y], i) => [
      x + (i % 2 ? 1.5 : -1.5),
      y + (i === 3 ? 2 : 0),
    ]);
    const { a, b } = similarityTransform(src, noisy);
    const map = ({ a, b }, [x, y]) => [a * x - b * y, b * x + a * y];
    const ex = map({ a, b }, [1, 0]);
    const ey = map({ a, b }, [0, 1]);
    // equal scale on both axes...
    expect(round(Math.hypot(...ex))).toBe(round(Math.hypot(...ey)));
    // ...and still perpendicular.
    expect(Math.abs(ex[0] * ey[0] + ex[1] * ey[1])).toBeLessThan(1e-9);
  });

  it("refuses coincident points rather than returning Infinity", () => {
    // A degenerate detection must not silently warp a crop out of the image.
    expect(() =>
      similarityTransform(
        [
          [5, 5],
          [5, 5],
          [5, 5],
        ],
        ARCFACE_TEMPLATE.slice(0, 3)
      )
    ).toThrow(/coincident/);
    expect(() => similarityTransform([[0, 0]], [[1, 1]])).toThrow(
      />=2 matched points/
    );
  });

  it("inverts the transform, so a warp samples the pixel it meant to", () => {
    const src = [
      [3, 7],
      [30, 9],
      [18, 22],
      [8, 36],
      [28, 35],
    ];
    const t = similarityTransform(src, ARCFACE_TEMPLATE);
    const forward = ([x, y]) => [
      t.a * x - t.b * y + t.tx,
      t.b * x + t.a * y + t.ty,
    ];
    const back = inverseMap(t);

    // NOT "each template point maps back to its keypoint" — a least-squares fit
    // of five noisy points has residuals by construction and passes through
    // none of them. The property inverseMap actually owns is that it undoes
    // `forward`, which is what the warp relies on when it iterates over
    // DESTINATION pixels and asks where each came from.
    for (const p of [...src, [0, 0], [111, 111], [-40, 200]]) {
      const [x, y] = back(...forward(p));
      expect(x).toBeCloseTo(p[0], 6);
      expect(y).toBeCloseTo(p[1], 6);
    }
  });

  it("is singular exactly when the fit collapsed", () => {
    expect(() => inverseMap({ a: 0, b: 0, tx: 5, ty: 5 })).toThrow(/singular/);
  });
});

describe("letterbox and source-space mapping", () => {
  it("fits the long edge to DET_SIZE and preserves aspect", () => {
    const l = letterbox(4000, 3000);
    expect(l.width).toBe(DET_SIZE);
    expect(l.height).toBe(480);
    const p = letterbox(3000, 4000);
    expect(p.height).toBe(DET_SIZE);
    expect(p.width).toBe(480);
  });

  it("round-trips a keypoint from letterbox space back to source pixels", () => {
    const { scale } = letterbox(4000, 3000);
    // A face centred in the source lands at the letterbox centre and back.
    const [[x, y]] = toSourceSpace([[2000 * scale, 1500 * scale]], scale);
    expect(x).toBeCloseTo(2000, 6);
    expect(y).toBeCloseTo(1500, 6);
  });

  it("rejects dimensions that would make the scale meaningless", () => {
    expect(() => letterbox(0, 100)).toThrow(/positive dimensions/);
    expect(() => toSourceSpace([[1, 1]], 0)).toThrow(/positive scale/);
  });
});
