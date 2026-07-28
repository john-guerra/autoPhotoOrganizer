import { describe, it, expect } from "vitest";
import { detectFaces, MIN_FACE_PX, SCORE_THRESHOLD } from "./faceDetect.js";
import { DET_SIZE, STRIDES, ANCHORS_PER_CELL } from "./faceGeometry.js";

/**
 * Fake ONNX sessions. The whole point of injecting them: this exercises the
 * real letterbox, the real head decoding, the real NMS and the real alignment
 * with no weights on disk, so every wiring bug is caught by `npm test` rather
 * than by eyeballing crops after a 191 MB download.
 */
function fakeDetector(placed) {
  const names = STRIDES.flatMap((_, i) => [`s${i}`]).concat(
    STRIDES.map((_, i) => `b${i}`),
    STRIDES.map((_, i) => `k${i}`)
  );
  return {
    inputName: "input.1",
    outputNames: names,
    calls: [],
    async run(feeds) {
      this.calls.push(feeds);
      const out = {};
      STRIDES.forEach((stride, i) => {
        const rows = (DET_SIZE / stride) ** 2 * ANCHORS_PER_CELL;
        const score = new Float32Array(rows);
        const bbox = new Float32Array(rows * 4);
        const kps = new Float32Array(rows * 10);
        for (const p of placed.filter((p) => p.stride === stride)) {
          score[p.index] = p.score;
          // Half-width in stride units, so the box is 2*d*stride wide.
          for (let j = 0; j < 4; j++) bbox[p.index * 4 + j] = p.d;
          // Keypoints spread around the centre so the alignment is solvable
          // (coincident points would throw).
          const spread = [
            [-0.4, -0.3],
            [0.4, -0.3],
            [0, 0],
            [-0.3, 0.4],
            [0.3, 0.4],
          ];
          spread.forEach(([dx, dy], k) => {
            kps[p.index * 10 + k * 2] = dx * p.d;
            kps[p.index * 10 + k * 2 + 1] = dy * p.d;
          });
        }
        out[`s${i}`] = { data: score };
        out[`b${i}`] = { data: bbox };
        out[`k${i}`] = { data: kps };
      });
      return out;
    },
  };
}

function fakeRecognizer(dim = 512) {
  return {
    inputName: "input.1",
    outputName: "out",
    calls: 0,
    async run() {
      this.calls++;
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i++) v[i] = Math.sin(i + this.calls);
      return { out: { data: v } };
    },
  };
}

/** A harness that records what got decoded, and at what size. */
function harness({ width = 4000, height = 3000 } = {}) {
  const decodes = [];
  return {
    decodes,
    probe: async () => ({ width, height }),
    decode: async (_bytes, plan) => {
      decodes.push(plan ? "letterbox" : "full");
      if (plan) {
        // The real caller pads to DET_SIZE; the packer requires exactly that.
        return {
          data: new Uint8Array(DET_SIZE * DET_SIZE * 3).fill(120),
          width: DET_SIZE,
          height: DET_SIZE,
        };
      }
      return {
        data: new Uint8Array(width * height * 3).fill(200),
        width,
        height,
      };
    },
    tensor: (shape, data) => ({ shape, data }),
  };
}

/** Place a face at a grid cell of a given stride. */
function at(stride, cellX, cellY, { d = 4, score = 0.9 } = {}) {
  const grid = DET_SIZE / stride;
  return { stride, index: (cellY * grid + cellX) * ANCHORS_PER_CELL, d, score };
}

describe("the detection pipeline", () => {
  it("feeds the detector a 640x640 NCHW tensor", async () => {
    const h = harness();
    const det = fakeDetector([]);
    await detectFaces({
      detector: det,
      recognizer: fakeRecognizer(),
      ...h,
      bytes: new Uint8Array(4),
    });
    expect(det.calls).toHaveLength(1);
    const t = det.calls[0]["input.1"];
    expect(t.shape).toEqual([1, 3, DET_SIZE, DET_SIZE]);
    expect(t.data).toHaveLength(3 * DET_SIZE * DET_SIZE);
  });

  it("never decodes the full-resolution image when there are no faces", async () => {
    // Most of a real archive is landscapes. Paying 20 ms of decode per
    // landscape across 32,000 photos is ~11 minutes spent on nobody.
    const h = harness();
    const rec = fakeRecognizer();
    const r = await detectFaces({
      detector: fakeDetector([]),
      recognizer: rec,
      ...h,
      bytes: new Uint8Array(4),
    });

    expect(r.faces).toEqual([]);
    expect(h.decodes).toEqual(["letterbox"]); // never "full"
    expect(rec.calls).toBe(0);
  });

  it("crops from the FULL-RES decode, not from the 640 the detector saw", async () => {
    // Measured: the two crops agree at only p10=0.474 cosine, and p50=0.678
    // for faces under 80px in the original. For the worst decile they are
    // barely the same face.
    const h = harness();
    const r = await detectFaces({
      detector: fakeDetector([at(32, 10, 10)]),
      recognizer: fakeRecognizer(),
      ...h,
      bytes: new Uint8Array(4),
    });
    expect(r.faces).toHaveLength(1);
    expect(h.decodes).toEqual(["letterbox", "full"]);
  });

  it("reports boxes in SOURCE pixels, not detector pixels", async () => {
    // Storing detector-space coordinates would make every consumer re-derive
    // the scale, and the one that got it wrong would crop a stranger.
    const h = harness({ width: 4000, height: 3000 });
    const scale = DET_SIZE / 4000; // 0.16
    const r = await detectFaces({
      detector: fakeDetector([at(32, 10, 10, { d: 4 })]),
      recognizer: fakeRecognizer(),
      ...h,
      bytes: new Uint8Array(4),
    });

    const [f] = r.faces;
    // centre (320, 320) in detector space, box half-width 4*32 = 128
    expect(f.box[0]).toBeCloseTo((320 - 128) / scale, 3);
    expect(f.box[2]).toBeCloseTo((320 + 128) / scale, 3);
    // ...which is well outside the 640 box, i.e. genuinely rescaled.
    expect(f.box[2]).toBeGreaterThan(DET_SIZE);
  });

  it("collapses one face found by all three strides into one", async () => {
    // The strides overlap deliberately. Without suppression every group photo
    // reports triple the people it holds, and #167 would see a "person" who
    // only ever appears alongside themself.
    const h = harness();
    const rec = fakeRecognizer();
    const r = await detectFaces({
      // Same centre (320, 320) at each stride, so the boxes coincide.
      detector: fakeDetector([
        at(8, 40, 40, { d: 16, score: 0.7 }),
        at(16, 20, 20, { d: 8, score: 0.95 }),
        at(32, 10, 10, { d: 4, score: 0.8 }),
      ]),
      recognizer: rec,
      ...h,
      bytes: new Uint8Array(4),
    });

    expect(r.faces).toHaveLength(1);
    expect(r.faces[0].score).toBeCloseTo(0.95, 5); // Float32Array, not double
    expect(rec.calls).toBe(1); // and only paid for one recognition
  });

  it("keeps two genuinely separate people", async () => {
    const h = harness();
    const r = await detectFaces({
      detector: fakeDetector([at(32, 5, 5), at(32, 15, 15)]),
      recognizer: fakeRecognizer(),
      ...h,
      bytes: new Uint8Array(4),
    });
    expect(r.faces).toHaveLength(2);
  });

  it("ignores detections below the score threshold", async () => {
    const h = harness();
    const r = await detectFaces({
      detector: fakeDetector([
        at(32, 10, 10, { score: SCORE_THRESHOLD - 0.01 }),
      ]),
      recognizer: fakeRecognizer(),
      ...h,
      bytes: new Uint8Array(4),
    });
    expect(r.faces).toEqual([]);
  });

  it("counts a face too small to recognize instead of embedding noise", async () => {
    // A 20px face upscaled 5.6x into ArcFace's 112x112 describes the
    // upscaling more than the person -- and those crops cluster with EACH
    // OTHER, producing a large confident "person" made of strangers.
    const h = harness({ width: 8000, height: 6000 });
    const rec = fakeRecognizer();
    const r = await detectFaces({
      // d=1 at stride 8 -> 16px in detector space -> 16/(640/8000) = 200px?
      // No: scale = 640/8000 = 0.08, so 16 detector px = 200 source px.
      // Use a tiny box at a LARGE source size to land under MIN_FACE_PX.
      detector: fakeDetector([
        at(8, 40, 40, { d: 0.1, score: 0.9 }),
        at(32, 10, 15, { d: 4, score: 0.9 }), // cellY < grid (640/32 = 20)
      ]),
      recognizer: rec,
      ...h,
      bytes: new Uint8Array(4),
    });

    const scale = DET_SIZE / 8000;
    const tinyPx = (2 * 0.1 * 8) / scale;
    expect(tinyPx).toBeLessThan(MIN_FACE_PX);
    expect(r.skipped).toBe(1);
    expect(r.faces).toHaveLength(1); // only the big one was recognized
    expect(rec.calls).toBe(1);
  });

  it("refuses a recognizer whose vector is the wrong width", async () => {
    // faceVectors lays rows out flat by `dim` and would refuse the whole
    // model at READ time -- long after the sweep spent an hour writing it.
    const h = harness();
    await expect(
      detectFaces({
        detector: fakeDetector([at(32, 10, 10)]),
        recognizer: fakeRecognizer(128),
        ...h,
        bytes: new Uint8Array(4),
        dim: 512,
      })
    ).rejects.toThrow(/returned 128 values, expected 512/);
  });

  it("refuses a detector that is not this architecture", async () => {
    // Nine heads, always. Indexing a different graph positionally would read
    // a bbox head as scores -- plausible boxes, wrong everywhere.
    const h = harness();
    const det = fakeDetector([]);
    det.outputNames = ["a", "b", "c"];
    await expect(
      detectFaces({
        detector: det,
        recognizer: fakeRecognizer(),
        ...h,
        bytes: new Uint8Array(4),
      })
    ).rejects.toThrow(/declares 3 outputs, expected 9/);
  });
});
