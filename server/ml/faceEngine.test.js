import { describe, it, expect } from "vitest";
import { createFaceEngine } from "./faceEngine.js";
import { DET_SIZE, STRIDES, ANCHORS_PER_CELL } from "./faceGeometry.js";

/** A fake onnxruntime whose detector finds nothing — enough to observe how the
 *  engine PREPARES its inputs, which is all this file is responsible for. */
function fakeOrt() {
  const created = [];
  return {
    created,
    ort: {
      Tensor: class {
        constructor(type, data, shape) {
          Object.assign(this, { type, data, shape });
        }
      },
      InferenceSession: {
        create: async (path) => {
          created.push(path);
          const isDet = path.includes("detection");
          const names = isDet
            ? STRIDES.map((_, i) => `s${i}`).concat(
                STRIDES.map((_, i) => `b${i}`),
                STRIDES.map((_, i) => `k${i}`)
              )
            : ["out"];
          return {
            inputNames: ["input.1"],
            outputNames: names,
            release: async () => {},
            run: async () => {
              if (!isDet) return { out: { data: new Float32Array(512) } };
              const o = {};
              STRIDES.forEach((stride, i) => {
                const rows = (DET_SIZE / stride) ** 2 * ANCHORS_PER_CELL;
                o[`s${i}`] = { data: new Float32Array(rows) };
                o[`b${i}`] = { data: new Float32Array(rows * 4) };
                o[`k${i}`] = { data: new Float32Array(rows * 10) };
              });
              return o;
            },
          };
        },
      },
    },
  };
}

/**
 * A fake sharp that MODELS EXIF ORIENTATION, which is the only way the
 * rotation bug is observable: metadata() on the original bytes reports the
 * STORED dimensions (transposed for a phone portrait), and only the rotated
 * buffer reports the true ones. A fake that returns the same size either way
 * cannot tell a correct pipeline from the bug — my first version did exactly
 * that and the mutation stayed green.
 */
function fakeSharp(
  calls,
  { stored = [3000, 4000], display = [4000, 3000] } = {}
) {
  let n = 0;
  return (input) => {
    const tag = `s${n++}`;
    const isRotated = input?.[0] === 82; // marker byte, see toBuffer below
    const ops = [];
    const api = {
      rotate() {
        ops.push("rotate");
        calls.push({ tag, op: "rotate" });
        return api;
      },
      resize(w, h) {
        ops.push("resize");
        calls.push({ tag, op: "resize", w, h });
        return api;
      },
      extend(pad) {
        calls.push({ tag, op: "extend", pad });
        return api;
      },
      removeAlpha: () => api,
      raw: () => api,
      metadata: async () => {
        const [width, height] = isRotated ? display : stored;
        calls.push({ tag, op: "metadata", width, height, isRotated });
        return { width, height };
      },
      toBuffer: async (opts) => {
        if (ops.includes("rotate") && !opts?.resolveWithObject) {
          // Mark the rotated buffer so a later sharp() call can tell.
          const b = new Uint8Array(16);
          b[0] = 82; // 'R'
          return b;
        }
        const wasResized = ops.includes("resize");
        const [w0, h0] = isRotated ? display : stored;
        const w = wasResized ? DET_SIZE : w0;
        const h = wasResized ? DET_SIZE : h0;
        const data = new Uint8Array(w * h * 3).fill(100);
        return opts?.resolveWithObject
          ? { data, info: { width: w, height: h } }
          : data;
      },
    };
    return api;
  };
}

describe("the engine's input preparation", () => {
  it("rotates ONCE and measures the rotated buffer", async () => {
    // sharp(bytes).metadata() reports PRE-rotation dimensions, so a phone
    // portrait reports them transposed -- and the letterbox is then the wrong
    // aspect, every detection lands somewhere else, and nothing errors. This
    // is the bug that made the crop-source measurement wrong by a whole
    // decile before it was found.
    const calls = [];
    const { ort } = fakeOrt();
    const engine = createFaceEngine({
      modelId: "buffalo_s",
      pathFor: (f) => `/m/${f}`,
      runtime: { ort, sharp: fakeSharp(calls) },
      readFile: async () => new Uint8Array(8),
    });

    await engine.detect({ path: "/photos/a.jpg" });

    const rotates = calls.filter((c) => c.op === "rotate");
    expect(rotates).toHaveLength(1);
    // The measurement must come from the ROTATED buffer. The fixture reports
    // 3000x4000 for the stored bytes and 4000x3000 after rotation, so this
    // distinguishes the two -- which the earlier version of this test did not,
    // and the mutation stayed green.
    const meta = calls.find((c) => c.op === "metadata");
    expect(meta.isRotated).toBe(true);
    expect([meta.width, meta.height]).toEqual([4000, 3000]);

    // ...and the letterbox therefore has the LANDSCAPE aspect. Measured from
    // the stored (transposed) dimensions it would be 480x640 instead.
    const rs = calls.find((c) => c.op === "resize");
    expect([rs.w, rs.h]).toEqual([DET_SIZE, 480]);
  });

  it("pads the letterbox bottom-right only", async () => {
    // faceGeometry's decoder maps detections back assuming a top-left anchor.
    // A centred pad shifts every keypoint by half the padding, silently.
    const calls = [];
    const { ort } = fakeOrt();
    const engine = createFaceEngine({
      modelId: "buffalo_s",
      pathFor: (f) => `/m/${f}`,
      runtime: { ort, sharp: fakeSharp(calls) },
      readFile: async () => new Uint8Array(8),
    });

    await engine.detect({ path: "/photos/a.jpg" });

    const ext = calls.find((c) => c.op === "extend");
    expect(ext.pad.top).toBe(0);
    expect(ext.pad.left).toBe(0);
    expect(ext.pad.bottom).toBe(DET_SIZE - 480);
    expect(ext.pad.right).toBe(0);

    const rs = calls.find((c) => c.op === "resize");
    expect([rs.w, rs.h]).toEqual([DET_SIZE, 480]);
  });

  it("builds both graphs once and reuses them across photos", async () => {
    // Rebuilding a session per photo costs more than the inference it wraps.
    const f = fakeOrt();
    const engine = createFaceEngine({
      modelId: "buffalo_s",
      pathFor: (file) => `/m/${file}`,
      runtime: { ort: f.ort, sharp: fakeSharp([]) },
      readFile: async () => new Uint8Array(8),
    });

    await engine.detect({ path: "/a.jpg" });
    await engine.detect({ path: "/b.jpg" });
    await engine.detect({ path: "/c.jpg" });

    expect(f.created).toEqual(["/m/detection.onnx", "/m/recognition.onnx"]);
  });

  it("releases the sessions on close, and rebuilds if used again", async () => {
    // ~200 MB of resident session must not outlive the sweep that needed it.
    const f = fakeOrt();
    const engine = createFaceEngine({
      modelId: "buffalo_s",
      pathFor: (file) => `/m/${file}`,
      runtime: { ort: f.ort, sharp: fakeSharp([]) },
      readFile: async () => new Uint8Array(8),
    });

    await engine.detect({ path: "/a.jpg" });
    expect(f.created).toHaveLength(2);
    await engine.close();
    await engine.detect({ path: "/b.jpg" });
    expect(f.created).toHaveLength(4);
  });

  it("closes cleanly even if it never ran", async () => {
    const f = fakeOrt();
    const engine = createFaceEngine({
      modelId: "buffalo_s",
      pathFor: (file) => `/m/${file}`,
      runtime: { ort: f.ort, sharp: fakeSharp([]) },
      readFile: async () => new Uint8Array(8),
    });
    await expect(engine.close()).resolves.toBeUndefined();
    expect(f.created).toEqual([]);
  });

  it("reads the file it was given, not the row's other fields", async () => {
    const f = fakeOrt();
    const read = [];
    const engine = createFaceEngine({
      modelId: "buffalo_s",
      pathFor: (file) => `/m/${file}`,
      runtime: { ort: f.ort, sharp: fakeSharp([]) },
      readFile: async (p) => {
        read.push(p);
        return new Uint8Array(8);
      },
    });
    await engine.detect({
      path: "/photos/Trip/IMG_1.jpg",
      filename: "IMG_1.jpg",
    });
    expect(read).toEqual(["/photos/Trip/IMG_1.jpg"]);
  });
});
