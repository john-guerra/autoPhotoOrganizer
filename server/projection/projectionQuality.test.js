/**
 * DOES THE MAP MEAN ANYTHING? (#232)
 *
 * Every other test here proves the projection runs, is deterministic, and can
 * be cancelled. None of them prove the coordinates are *useful* — a projection
 * that returned the same point for everyone would pass all of them.
 *
 * The only property the feature actually needs is that two groups of the SAME
 * human land near each other, because that is what a lasso asks you to judge
 * by eye. This measures exactly that: split one person's faces into an
 * earliest half and a latest half at least 24h apart — different day, so
 * different light, clothes and angle, which is *why* clustering split them —
 * treat each half as its own person, and report the 2-D rank of each half's
 * twin among all points. Rank 1 means "my nearest neighbour on the map is my
 * other half".
 *
 * DOUBLY GATED, and both gates are deliberate:
 *
 *   - `ML_INTEGRATION=1`, because this is slow and pointless in `npm test`;
 *   - `AUTOGALLERY_PROJECTION_FIXTURES`, pointing at a real library's
 *     `index.db`, because the only faces that mean anything are real
 *     photographs of real people and those cannot live in a public repo.
 *
 * It skips LOUDLY, exactly as `embeddingSimilarity.test.js` does and for the
 * same reason: a silent skip on the only check that the numbers mean anything
 * is indistinguishable from a pass.
 *
 * Run it:
 *   AUTOGALLERY_PROJECTION_FIXTURES=~/.autogallery/index.db ML_INTEGRATION=1 \
 *     npx vitest run server/projection/projectionQuality.test.js
 *
 * Record the path in the gitignored `docs/TEST_FOLDERS.local.md`.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { runProjection } from "./runProjection.js";
import { defaultParams } from "./algorithms.js";
import { dequantize } from "../ml/quantize.js";

const DB_PATH = process.env.AUTOGALLERY_PROJECTION_FIXTURES;
const ENABLED = process.env.ML_INTEGRATION === "1" && !!DB_PATH;

/**
 * The floors, and why they are so far below the headline numbers.
 *
 * `docs/experiments/.../README.md` records UMAP at 27.8% twin-is-nearest and
 * 58.3% top-5 on a 36-pair hard split. Re-running the SAME split through the
 * shipped defaults (a fixed seed, 200 epochs — the experiment used umap-js's
 * own unseeded draw and its 300-epoch default) gives 23.6% / 41.7%. So that
 * published pair was one sample, and the metric varies by a lot more than its
 * two significant figures suggest: 36 pairs is a small denominator, and each
 * pair is worth 2.8 points.
 *
 * These floors therefore catch "the projection has stopped meaning anything",
 * not "it scored lower than one lucky draw". They discriminate easily on the
 * numbers that matter: chance on a 4,000-point map is about 0.025%, PCA
 * measured 2.8% / 6.9%, and SQDMDS 0.0% / 0.0%. UMAP at 23.6% is roughly 940x
 * chance.
 *
 * If you want a number to tune against, enlarge the sample first.
 */
export const MIN_NEAREST_SHARE = 0.1;
export const MIN_TOP5_SHARE = 0.25;

if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n[projectionQuality] SKIPPED — the only check that the map's coordinates" +
      "\nmean anything did not run. Set ML_INTEGRATION=1 and point" +
      "\nAUTOGALLERY_PROJECTION_FIXTURES at a real library's index.db.\n"
  );
}

describe.skipIf(!ENABLED)("projection quality (#232)", () => {
  it("puts two halves of the same person near each other", async () => {
    expect(existsSync(DB_PATH), `no database at ${DB_PATH}`).toBe(true);

    const { default: Database } = await import("better-sqlite3");
    const db = new Database(DB_PATH, { readonly: true });

    let data, twin, pairs, dim;
    try {
      const model = db
        .prepare(`SELECT model FROM photo_faces LIMIT 1`)
        .get()?.model;
      expect(model, "the fixture library has no faces").toBeTruthy();

      // Ordered by time so "earliest half" and "latest half" are meaningful.
      // COALESCE, so photos with no EXIF date fall back to mtime — noted as a
      // caveat in the experiment README, since such a gap may be fictional.
      const rows = db
        .prepare(
          `SELECT f.person_id AS pid, f.dim, f.scale, f.vec,
                  COALESCE(p.taken_at, p.mtime) AS t
             FROM photo_faces f JOIN photos p ON p.id = f.photo_id
            WHERE f.model = ? AND f.person_id IS NOT NULL
            ORDER BY f.person_id, t`
        )
        .all(model);

      dim = rows[0]?.dim ?? 0;
      expect(dim).toBeGreaterThan(0);

      const byPerson = new Map();
      for (const r of rows) {
        if (!byPerson.has(r.pid)) byPerson.set(r.pid, []);
        byPerson.get(r.pid).push(r);
      }

      const centroid = (list) => {
        const v = new Float64Array(dim);
        for (const r of list) {
          const bytes = new Int8Array(
            r.vec.buffer,
            r.vec.byteOffset,
            r.vec.byteLength
          );
          const f = dequantize(bytes, r.scale);
          for (let i = 0; i < dim; i++) v[i] += f[i];
        }
        let norm = 0;
        for (let i = 0; i < dim; i++) norm += v[i] * v[i];
        norm = Math.sqrt(norm) || 1;
        return Float32Array.from(v, (x) => x / norm);
      };

      const rowsOut = [];
      twin = [];
      const GAP_MS = 24 * 3600 * 1000;
      let distractors = 0;
      for (const [, faces] of byPerson) {
        if (faces.length >= 4) {
          const mid = Math.floor(faces.length / 2);
          const a = faces.slice(0, mid);
          const b = faces.slice(mid);
          // A real time gap, or the two halves are the same afternoon and the
          // test measures a triviality (see the README's "easy split").
          if (b[0].t - a[a.length - 1].t >= GAP_MS) {
            const ia = rowsOut.push(centroid(a)) - 1;
            const ib = rowsOut.push(centroid(b)) - 1;
            twin[ia] = ib;
            twin[ib] = ia;
            continue;
          }
        }
        if (distractors < 4000) {
          // Real other people the twin has to beat.
          rowsOut.push(centroid(faces));
          twin[rowsOut.length - 1] = -1;
          distractors++;
        }
      }

      pairs = twin.filter((t) => t >= 0).length / 2;
      expect(
        pairs,
        "too few split pairs to measure — point the fixture at a bigger library"
      ).toBeGreaterThanOrEqual(10);

      data = new Float32Array(rowsOut.length * dim);
      rowsOut.forEach((r, i) => data.set(r, i * dim));
    } finally {
      db.close();
    }

    const n = twin.length;
    const xy = await runProjection({
      data,
      dim,
      n,
      algorithm: "umap",
      params: defaultParams({ seed: 1212 }),
    });

    let nearest = 0;
    let top5 = 0;
    let measured = 0;
    for (let i = 0; i < n; i++) {
      const j = twin[i];
      if (j < 0) continue;
      const dx = xy[i * 2] - xy[j * 2];
      const dy = xy[i * 2 + 1] - xy[j * 2 + 1];
      const dTwin = dx * dx + dy * dy;
      let better = 0;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const ex = xy[i * 2] - xy[k * 2];
        const ey = xy[i * 2 + 1] - xy[k * 2 + 1];
        if (ex * ex + ey * ey < dTwin) better++;
      }
      const rank = better + 1;
      if (rank === 1) nearest++;
      if (rank <= 5) top5++;
      measured++;
    }

    const nearestShare = nearest / measured;
    const top5Share = top5 / measured;
    // eslint-disable-next-line no-console
    console.log(
      `[projectionQuality] ${n} points, ${pairs} split pairs — ` +
        `twin is nearest ${(nearestShare * 100).toFixed(1)}%, ` +
        `top-5 ${(top5Share * 100).toFixed(1)}% ` +
        `(baseline 27.8% / 58.3%)`
    );

    expect(nearestShare).toBeGreaterThanOrEqual(MIN_NEAREST_SHARE);
    expect(top5Share).toBeGreaterThanOrEqual(MIN_TOP5_SHARE);
  }, 600_000);
});
