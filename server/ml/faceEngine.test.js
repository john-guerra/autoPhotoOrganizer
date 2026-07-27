import { describe, it, expect } from "vitest";
import { createFaceEngine, orientedSize } from "./faceEngine.js";
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
 * rotation bug is observable: metadata() reports the STORED dimensions
 * (transposed for a phone portrait) and `autoOrient` reports the displayed
 * ones. A fake that returned the same size either way could not tell a
 * correct pipeline from the bug — an earlier version did exactly that and the
 * mutation stayed green.
 *
 * It also records whether each `toBuffer` was a RAW read or an encode, which
 * is what catches the re-encode this file used to do.
 */
function fakeSharp(
  calls,
  { stored = [3000, 4000], display = [4000, 3000], channels = 3 } = {}
) {
  let n = 0;
  return () => {
    const tag = `s${n++}`;
    const ops = [];
    const record = (op, extra) => {
      calls.push({ tag, op, ...extra });
      return api;
    };
    const api = {
      rotate: () => (ops.push("rotate"), record("rotate")),
      resize: (w, h) => (ops.push("resize"), record("resize", { w, h })),
      extend: (pad) => record("extend", { pad }),
      removeAlpha: () => record("removeAlpha"),
      toColourspace: (cs) => record("toColourspace", { cs }),
      raw: () => (ops.push("raw"), record("raw")),
      metadata: async () => {
        calls.push({ tag, op: "metadata" });
        return {
          width: stored[0],
          height: stored[1],
          orientation: 6,
          autoOrient: { width: display[0], height: display[1] },
        };
      },
      toBuffer: async (opts) => {
        // An encode is a toBuffer that is NOT preceded by .raw(). That is the
        // whole assertion: the old pipeline had one per photo.
        calls.push({ tag, op: "toBuffer", raw: ops.includes("raw") });
        const w = ops.includes("resize") ? DET_SIZE : display[0];
        const h = ops.includes("resize") ? DET_SIZE : display[1];
        const data = new Uint8Array(w * h * channels).fill(100);
        return opts?.resolveWithObject
          ? { data, info: { width: w, height: h, channels } }
          : data;
      },
    };
    return api;
  };
}

/** The engine, wired to fakes. */
function engineWith(calls, sharpOpts) {
  const f = fakeOrt();
  return {
    ...f,
    engine: createFaceEngine({
      modelId: "buffalo_s",
      pathFor: (file) => `/m/${file}`,
      runtime: { ort: f.ort, sharp: fakeSharp(calls, sharpOpts) },
      readFile: async () => new Uint8Array(8),
    }),
  };
}

describe("the size the letterbox is planned from", () => {
  it("prefers sharp's own post-rotation size", () => {
    expect(
      orientedSize({
        width: 3000,
        height: 4000,
        orientation: 6,
        autoOrient: { width: 4000, height: 3000 },
      })
    ).toEqual({ width: 4000, height: 3000 });
  });

  it("transposes for a quarter turn when sharp doesn't say", () => {
    // Orientations 5-8 are the quarter turns and the only ones that swap the
    // frame. 1-4 (upright, and the mirrors) must NOT be transposed -- a
    // blanket swap is the plausible-looking version of this bug.
    expect(orientedSize({ width: 3000, height: 4000, orientation: 6 })).toEqual(
      { width: 4000, height: 3000 }
    );
    expect(orientedSize({ width: 3000, height: 4000, orientation: 8 })).toEqual(
      { width: 4000, height: 3000 }
    );
    expect(orientedSize({ width: 3000, height: 4000, orientation: 2 })).toEqual(
      { width: 3000, height: 4000 }
    );
    expect(orientedSize({ width: 3000, height: 4000 })).toEqual({
      width: 3000,
      height: 4000,
    });
  });
});

describe("what the engine does to the file's bytes", () => {
  it("never re-encodes the photo", async () => {
    // `sharp(bytes).rotate().toBuffer()` with no format set does a full decode
    // AND a q80 4:2:0 JPEG write. That made the "no people, no full decode"
    // saving false, and meant the full-resolution crop -- the thing this
    // pipeline exists to get right -- was cut from a recompression. Every
    // toBuffer must be a RAW pixel read.
    const calls = [];
    const { engine } = engineWith(calls);
    await engine.detect({ path: "/photos/a.jpg" });

    const encodes = calls.filter((c) => c.op === "toBuffer" && !c.raw);
    expect(encodes).toEqual([]);
  });

  it("reads pixels ONCE for a photo with nobody in it", async () => {
    // The fake detector finds nothing, so only the 640 letterbox is decoded.
    const calls = [];
    const { engine } = engineWith(calls);
    await engine.detect({ path: "/photos/a.jpg" });

    expect(calls.filter((c) => c.op === "toBuffer")).toHaveLength(1);
    // ...and the header read that planned it plainly is not a decode.
    expect(calls.filter((c) => c.op === "metadata")).toHaveLength(1);
  });

  it("forces three channels so a grayscale photo is not a permanent failure", async () => {
    // A b/w or CMYK JPEG decodes to 1 or 4 channels. Without this the length
    // check three modules down throws, runSweep classifies it as permanent,
    // and the photo is marked unreadable forever for a colourspace we simply
    // never handled.
    const calls = [];
    const { engine } = engineWith(calls);
    await engine.detect({ path: "/photos/a.jpg" });

    const cs = calls.filter((c) => c.op === "toColourspace");
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => c.cs === "srgb")).toBe(true);
  });

  it("names an unsupported colourspace instead of failing on a byte count", async () => {
    const { engine } = engineWith([], { channels: 4 });
    await expect(engine.detect({ path: "/photos/a.jpg" })).rejects.toThrow(
      /4 channels.*expected 3/
    );
  });
});

describe("the engine's input preparation", () => {
  it("rotates every pipeline, and plans from the DISPLAYED size", async () => {
    // sharp(bytes).metadata() reports PRE-rotation dimensions, so a phone
    // portrait reports them transposed -- and the letterbox is then the wrong
    // aspect, every detection lands somewhere else, and nothing errors. This
    // is the bug that made the crop-source measurement wrong by a whole
    // decile before it was found.
    const calls = [];
    const { engine } = engineWith(calls);

    await engine.detect({ path: "/photos/a.jpg" });

    // The letterbox has the LANDSCAPE aspect. Planned from the stored
    // (transposed) dimensions it would be 480x640 instead.
    const rs = calls.find((c) => c.op === "resize");
    expect([rs.w, rs.h]).toEqual([DET_SIZE, 480]);

    // ...and the pipeline that resized it rotated FIRST. Resizing before the
    // rotation gives a correctly-shaped buffer of the wrong content, which no
    // dimension check downstream can see.
    const ownOps = calls.filter((c) => c.tag === rs.tag).map((c) => c.op);
    expect(ownOps.indexOf("rotate")).toBeGreaterThanOrEqual(0);
    expect(ownOps.indexOf("rotate")).toBeLessThan(ownOps.indexOf("resize"));
  });

  it("pads the letterbox bottom-right only", async () => {
    // faceGeometry's decoder maps detections back assuming a top-left anchor.
    // A centred pad shifts every keypoint by half the padding, silently.
    const calls = [];
    const { engine } = engineWith(calls);

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
