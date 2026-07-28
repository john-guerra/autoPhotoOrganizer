import { describe, it, expect } from "vitest";
import {
  FACE_MODELS,
  FACE_DIM,
  DEFAULT_FACE_MODEL_ID,
  faceModelById,
  faceModelFiles,
} from "./faceModels.js";

describe("the face model allowlist", () => {
  it("every pack carries a digest AND a byte count for its downloads", () => {
    // The failure mode of a missing digest is not an error -- it is
    // verification silently passing, which is worse than having none.
    for (const m of FACE_MODELS) {
      for (const f of faceModelFiles(m.id)) {
        expect(f.sha256, `${m.id}/${f.name}`).toMatch(/^[0-9a-f]{64}$/);
        expect(f.bytes, `${m.id}/${f.name}`).toBeGreaterThan(0);
        expect(f.url, `${m.id}/${f.name}`).toMatch(/^https:\/\//);
      }
    }
  });

  it("no two packs share a digest", () => {
    // A copy-paste between entries would point one pack at the other's
    // weights, and the only symptom would be a wrong accuracy measurement.
    const digests = FACE_MODELS.flatMap((m) =>
      faceModelFiles(m.id).map((f) => f.sha256)
    );
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("declares the same embedding width everywhere", () => {
    // Storage lays vectors out flat by `dim` (db/faces.js faceVectors), so a
    // pack claiming a different width would not error -- it would be refused
    // at read time, long after the sweep spent an hour writing it.
    for (const m of FACE_MODELS) expect(m.dim).toBe(FACE_DIM);
  });

  it("states a licence and links where it was read", () => {
    // This string is a CONSENT NOTICE shown at the moment the user decides
    // whether to spend the download -- see the bar in models.js's module doc.
    // It may only repeat what the source declares.
    for (const m of FACE_MODELS) {
      expect(m.licence).toMatch(/non-commercial/i);
      expect(m.modelCardUrl).toMatch(/^https:\/\//);
    }
  });

  it("does not claim these weights are MIT", () => {
    // The tempting wrong answer, and the one models.js already records for
    // CLIP: deepinsight/insightface's CODE is MIT with no commercial
    // limitation, and the weights are a different artifact under a different
    // policy. Asserting MIT here would tell the user a fact about someone
    // else's IP that its owner never said.
    for (const m of FACE_MODELS) {
      expect(m.licence).not.toMatch(/\bMIT\b/);
    }
  });

  it("says the size in decimal MB, matching what the OS will show", () => {
    // A user watching "191 MB" tick by against a panel that said "182 MB"
    // (MiB) would think the panel was wrong. Same reasoning as models.js.
    for (const m of FACE_MODELS) {
      const total = faceModelFiles(m.id).reduce((n, f) => n + f.bytes, 0);
      expect(m.approxDownloadMB).toBe(Math.round(total / 1e6));
    }
  });

  it("defaults to the pack that is cheap to try", () => {
    // 16 MB and ~25 min over the library, against 191 MB and ~90 min. The
    // accuracy difference is UNMEASURED, so defaulting to the expensive one
    // would be spending the user's bandwidth on a guess.
    expect(DEFAULT_FACE_MODEL_ID).toBe("buffalo_s");
    expect(() => faceModelById(DEFAULT_FACE_MODEL_ID)).not.toThrow();
  });

  it("refuses an id that is not on the list", () => {
    // An arbitrary id is an arbitrary download onto the user's machine.
    expect(() => faceModelById("buffalo_xl")).toThrow(/unknown face model/);
    expect(() => faceModelFiles("../../etc/passwd")).toThrow(
      /unknown face model/
    );
  });
});
