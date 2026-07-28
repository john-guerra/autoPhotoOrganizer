import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { downloadFaceModel, checkFaceModel } from "./faceDownload.js";
import { faceModelFiles } from "./faceModels.js";

const PACK = "buffalo_s";
const sha = (b) => createHash("sha256").update(b).digest("hex");

/**
 * A stand-in pack whose digests are of bytes we can actually produce. The real
 * registry's digests are of 191 MB of weights, so a fixture cannot hash to
 * them — and without this override only the REJECTION paths would be
 * reachable, leaving the successful download untested.
 */
function spec() {
  const det = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const rec = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  return {
    det,
    rec,
    files: [
      {
        name: "detector",
        file: "detection.onnx",
        url: "https://example.test/det",
        bytes: det.length,
        sha256: sha(det),
      },
      {
        name: "recognizer",
        file: "recognition.onnx",
        url: "https://example.test/rec",
        bytes: rec.length,
        sha256: sha(rec),
      },
    ],
  };
}

function harness({ serve = {}, disk = {} } = {}) {
  const files = new Map(Object.entries(disk));
  const fetched = [];
  const unlinked = [];
  return {
    files,
    fetched,
    unlinked,
    io: {
      pathFor: (f) => `/models/${f}`,
      readFile: async (p) => {
        const v = files.get(p);
        if (!v) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      writeFile: async (p, b) => void files.set(p, b),
      unlink: async (p) => {
        unlinked.push(p);
        files.delete(p);
      },
      fetchImpl: async (url) => {
        fetched.push(url);
        const body = serve[url];
        return {
          ok: body !== undefined,
          status: body === undefined ? 404 : 200,
          arrayBuffer: async () =>
            body.buffer.slice(
              body.byteOffset,
              body.byteOffset + body.byteLength
            ),
        };
      },
    },
  };
}

describe("the successful path", () => {
  it("downloads both graphs, verifies them, and writes them", async () => {
    const s = spec();
    const h = harness({
      serve: {
        "https://example.test/det": s.det,
        "https://example.test/rec": s.rec,
      },
    });

    const r = await downloadFaceModel(PACK, h.io, { files: s.files });

    expect(r.downloaded).toEqual(["detector", "recognizer"]);
    expect(r.skipped).toEqual([]);
    expect(h.files.get("/models/detection.onnx")).toEqual(s.det);
    expect(h.files.get("/models/recognition.onnx")).toEqual(s.rec);
  });

  it("does not re-fetch a file already present and intact", async () => {
    // Proving 174 MB is intact must not cost 174 MB of transfer.
    const s = spec();
    const h = harness({
      disk: { "/models/detection.onnx": s.det },
      serve: { "https://example.test/rec": s.rec },
    });

    const r = await downloadFaceModel(PACK, h.io, { files: s.files });

    expect(r.skipped).toEqual(["detector"]);
    expect(r.downloaded).toEqual(["recognizer"]);
    expect(h.fetched).toEqual(["https://example.test/rec"]);
  });

  it("reports progress in bytes against the pack's real total", async () => {
    const s = spec();
    const h = harness({
      serve: {
        "https://example.test/det": s.det,
        "https://example.test/rec": s.rec,
      },
    });
    const seen = [];
    await downloadFaceModel(PACK, h.io, {
      files: s.files,
      onProgress: (p) => seen.push(p),
    });

    const total = s.det.length + s.rec.length;
    expect(seen.every((p) => p.total === total)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ phase: "verified", done: total });
    // Progress is monotonic — a bar that goes backwards reads as a bug.
    const dones = seen.map((p) => p.done);
    expect([...dones].sort((a, b) => a - b)).toEqual(dones);
  });
});

describe("verifying what a mirror served", () => {
  it("rejects bytes of the right length whose digest is wrong", async () => {
    // The failure this module exists for. A substituted recognizer does not
    // crash -- it returns 512 confident floats per face, and the only symptom
    // is that clustering stops corresponding to people, months later.
    const s = spec();
    const tampered = new Uint8Array(s.det.length).fill(42);
    const h = harness({
      serve: { "https://example.test/det": tampered },
    });

    await expect(
      downloadFaceModel(PACK, h.io, { files: s.files })
    ).rejects.toThrow(/does not match its expected checksum/);
    expect(h.files.size).toBe(0); // nothing written, so nothing loads later
  });

  it("rejects a truncated download by length, before hashing", async () => {
    // The common failure: a dropped connection leaves a file of the right
    // NAME and the wrong length, and ONNX then fails to parse it with an
    // error that reads like a corrupt model rather than a partial one.
    const s = spec();
    const h = harness({
      serve: { "https://example.test/det": s.det.slice(0, 4) },
    });

    await expect(
      downloadFaceModel(PACK, h.io, { files: s.files })
    ).rejects.toThrow(/arrived incomplete \(4 of 8 bytes\)/);
    expect(h.files.size).toBe(0);
  });

  it("names the file and says nothing changed when the server errors", async () => {
    // CLAUDE.md: a failure the user can trigger must say WHAT happened and
    // WHAT to do next. "Error" is not user feedback.
    const s = spec();
    const h = harness({ serve: {} });
    await expect(
      downloadFaceModel(PACK, h.io, { files: s.files })
    ).rejects.toThrow(
      /Couldn't download the detector .*404.*nothing was changed/is
    );
  });

  it("deletes a corrupt local file so the next attempt can repair it", async () => {
    // Without this, bytes nobody will ever fix sit on disk failing forever.
    const s = spec();
    const h = harness({
      disk: { "/models/detection.onnx": new Uint8Array(s.det.length).fill(0) },
      serve: {
        "https://example.test/det": s.det,
        "https://example.test/rec": s.rec,
      },
    });

    const r = await downloadFaceModel(PACK, h.io, { files: s.files });

    expect(h.unlinked).toContain("/models/detection.onnx");
    expect(r.downloaded).toContain("detector"); // and it was replaced
    expect(h.files.get("/models/detection.onnx")).toEqual(s.det);
  });
});

describe("checkFaceModel", () => {
  it("distinguishes absent from present-but-wrong", async () => {
    // They need different messages: one is "press download", the other is
    // "something is wrong with what you have".
    const s = spec();
    const empty = await checkFaceModel(PACK, harness().io, { files: s.files });
    expect(empty).toEqual({
      ready: false,
      missing: ["detector", "recognizer"],
      corrupt: [],
    });

    const bad = harness({
      disk: { "/models/detection.onnx": new Uint8Array(s.det.length).fill(3) },
    });
    const r = await checkFaceModel(PACK, bad.io, { files: s.files });
    expect(r.missing).toEqual(["recognizer"]);
    expect(r.corrupt).toEqual(["detector"]);
  });

  it("is ready only when every graph verifies", async () => {
    const s = spec();
    const partial = harness({ disk: { "/models/detection.onnx": s.det } });
    expect(
      (await checkFaceModel(PACK, partial.io, { files: s.files })).ready
    ).toBe(false);

    const full = harness({
      disk: {
        "/models/detection.onnx": s.det,
        "/models/recognition.onnx": s.rec,
      },
    });
    expect(
      (await checkFaceModel(PACK, full.io, { files: s.files })).ready
    ).toBe(true);
  });

  it("checks the digest, not merely that a file exists", async () => {
    // A file of the right name and length is exactly what a truncated
    // download leaves behind, so existence proves nothing.
    const s = spec();
    const h = harness({
      disk: {
        "/models/detection.onnx": new Uint8Array(s.det.length).fill(5),
        "/models/recognition.onnx": s.rec,
      },
    });
    const r = await checkFaceModel(PACK, h.io, { files: s.files });
    expect(r.corrupt).toEqual(["detector"]);
    expect(r.ready).toBe(false);
  });

  it("defaults to the real registry when no override is given", async () => {
    // The override is a test seam; production must read the shipped digests.
    const r = await checkFaceModel(PACK, harness().io);
    expect(r.missing).toEqual(["detector", "recognizer"]);
    expect(faceModelFiles(PACK)).toHaveLength(2);
  });
});
