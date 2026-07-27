/**
 * The only check that the face pipeline means anything (#166).
 *
 * faceDetect.test.js drives the whole orchestration against FAKE sessions,
 * which proves the wiring is self-consistent — and self-consistent is exactly
 * what a wrong anchor stride or a transposed normalization also is. A fake
 * detector emitting the layout the decoder expects cannot catch a decoder that
 * agrees with it and disagrees with the real graph. Only real weights on real
 * photographs can.
 *
 * Gated TWICE, both deliberately, matching embeddingSimilarity.test.js:
 *
 *   - `ML_INTEGRATION=1`, because `npm test` must never load 191 MB of ONNX.
 *   - `AUTOGALLERY_FACE_FIXTURES`, a folder of real photographs containing
 *     people. Photographs of identifiable people cannot live in a public repo,
 *     and every other image fixture in this tree is sharp-generated at test
 *     time — a synthetic "face" would tell us nothing, since a detector that
 *     finds a drawn oval is not a detector that finds a grandmother in profile.
 *
 *   AUTOGALLERY_FACE_FIXTURES=/path/to/photos ML_INTEGRATION=1 \
 *     npx vitest run server/ml/faceIntegration.test.js
 *
 * Record the path in the gitignored docs/TEST_FOLDERS.local.md. Without it the
 * test skips LOUDLY, because a silent skip on the only check that the vectors
 * describe faces is indistinguishable from a pass.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectFaces } from "./faceDetect.js";
import { faceModelById } from "./faceModels.js";
import { DET_SIZE } from "./faceGeometry.js";

const RUN = process.env.ML_INTEGRATION === "1";
const FIXTURES = process.env.AUTOGALLERY_FACE_FIXTURES;
const PACK = process.env.AUTOGALLERY_FACE_PACK ?? "buffalo_s";
const MODELS = join(
  process.env.HOME ?? "",
  ".autogallery/models/insightface",
  PACK
);

const ready =
  RUN &&
  FIXTURES &&
  existsSync(MODELS) &&
  existsSync(join(MODELS, "detection.onnx"));

if (RUN && !ready) {
  console.warn(
    `[faceIntegration] SKIPPING: need ML_INTEGRATION=1, ` +
      `AUTOGALLERY_FACE_FIXTURES (got ${FIXTURES ?? "unset"}), and weights at ${MODELS}`
  );
}

describe.runIf(ready)(
  "faces, against real weights and real photographs",
  () => {
    let ort, sharp, detector, recognizer, photos;

    beforeAll(async () => {
      ort = (await import("onnxruntime-node")).default;
      sharp = (await import("sharp")).default;
      const mk = async (file, single) => {
        const s = await ort.InferenceSession.create(join(MODELS, file), {
          executionProviders: ["cpu"],
        });
        return {
          inputName: s.inputNames[0],
          outputNames: s.outputNames,
          outputName: s.outputNames[0],
          run: (feeds) => s.run(feeds),
        };
      };
      detector = await mk("detection.onnx");
      recognizer = await mk("recognition.onnx");

      photos = readdirSync(FIXTURES)
        .filter((f) => /\.(jpe?g|png)$/i.test(f))
        .slice(0, 40)
        .map((f) => join(FIXTURES, f));
    }, 120_000);

    /** The real adapters the worker will use. Kept here so the test exercises
     *  the SAME sharp calls production does — the letterbox pad in particular. */
    const probe = async (bytes) => {
      const buf = await sharp(bytes).rotate().toBuffer();
      const m = await sharp(buf).metadata();
      return { width: m.width, height: m.height, buf };
    };
    const makeDecode = (rotated) => async (_bytes, plan) => {
      if (!plan) {
        const { data, info } = await sharp(rotated)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
      }
      const { data } = await sharp(rotated)
        .resize(plan.resize.width, plan.resize.height)
        .extend({ ...plan.pad, background: { r: 0, g: 0, b: 0 } })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { data, width: DET_SIZE, height: DET_SIZE };
    };
    const tensor = (shape, data) => new ort.Tensor("float32", data, shape);

    async function run(path) {
      const bytes = await readFile(path);
      const { width, height, buf } = await probe(bytes);
      return detectFaces({
        detector,
        recognizer,
        probe: async () => ({ width, height }),
        decode: makeDecode(buf),
        tensor,
        bytes,
        dim: faceModelById(PACK).dim,
      });
    }

    it("finds faces in a real archive, and not in everything", async () => {
      const results = [];
      for (const p of photos) {
        try {
          results.push(await run(p));
        } catch {
          /* unreadable / odd colourspace */
        }
      }
      expect(results.length).toBeGreaterThan(10);

      const withFaces = results.filter((r) => r.faces.length).length;
      // A detector firing on NOTHING is broken; one firing on EVERYTHING is
      // broken differently, and a wrong anchor stride produces the second.
      expect(withFaces).toBeGreaterThan(0);
      expect(withFaces).toBeLessThan(results.length);
    }, 300_000);

    it("puts every box inside the photo it came from", async () => {
      // The single loudest symptom of a decode error. A stride or letterbox
      // mistake puts boxes off-frame or clustered at the origin at 1/8 scale,
      // and nothing downstream would notice -- the crop just clamps.
      let checked = 0;
      for (const p of photos.slice(0, 15)) {
        let r, size;
        try {
          const bytes = await readFile(p);
          size = await probe(bytes);
          r = await run(p);
        } catch {
          continue;
        }
        for (const f of r.faces) {
          const [x1, y1, x2, y2] = f.box;
          expect(x2).toBeGreaterThan(x1);
          expect(y2).toBeGreaterThan(y1);
          // Allow a margin: a real face at the frame edge legitimately extends
          // past it. Ten percent of the frame, not eight times it.
          expect(x1).toBeGreaterThan(-0.1 * size.width);
          expect(y1).toBeGreaterThan(-0.1 * size.height);
          expect(x2).toBeLessThan(1.1 * size.width);
          expect(y2).toBeLessThan(1.1 * size.height);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    }, 300_000);

    it("gives the same face the same vector, and two people different ones", async () => {
      // THE test. Everything above can pass with an embedding that describes
      // the crop's brightness. Re-running one photo must reproduce its vector
      // exactly (the pipeline is deterministic), and two DIFFERENT faces must
      // not collapse onto each other.
      const withFaces = [];
      for (const p of photos) {
        try {
          const r = await run(p);
          if (r.faces.length) withFaces.push({ p, r });
          if (withFaces.length >= 6) break;
        } catch {
          /* skip */
        }
      }
      expect(withFaces.length).toBeGreaterThanOrEqual(2);

      const cos = (a, b) => {
        let d = 0,
          na = 0,
          nb = 0;
        for (let i = 0; i < a.length; i++) {
          d += a[i] * b[i];
          na += a[i] * a[i];
          nb += b[i] * b[i];
        }
        return d / Math.sqrt(na * nb);
      };

      // Deterministic: the same photo twice is the same vector.
      const again = await run(withFaces[0].p);
      expect(
        cos(withFaces[0].r.faces[0].vector, again.faces[0].vector)
      ).toBeGreaterThan(0.999);

      // And distinct faces are distinct. ArcFace's own operating point puts
      // different identities well below 0.5; asserting 0.9 is a loose bound
      // that still catches a pipeline emitting near-constant vectors, which is
      // what a broken alignment or normalization actually produces.
      const pairs = [];
      for (let i = 0; i < withFaces.length; i++) {
        for (let j = i + 1; j < withFaces.length; j++) {
          pairs.push(
            cos(withFaces[i].r.faces[0].vector, withFaces[j].r.faces[0].vector)
          );
        }
      }
      const mean = pairs.reduce((a, b) => a + b, 0) / pairs.length;
      console.log(
        `[faceIntegration] ${PACK}: ${withFaces.length} photos with faces, ` +
          `mean cross-photo cosine ${mean.toFixed(3)}, max ${Math.max(...pairs).toFixed(3)}`
      );
      expect(mean).toBeLessThan(0.9);
    }, 300_000);
  }
);
