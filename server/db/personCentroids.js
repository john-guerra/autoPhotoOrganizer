/**
 * One vector per PERSON, for the face map (#232).
 *
 * A person's centroid is the mean of their dequantized face vectors,
 * re-normalized to unit length — so a person with forty faces is not "further
 * away" than a person with two purely because averaging shortened their
 * vector.
 *
 * Why persons rather than faces: the problem this serves is "one human split
 * across many person-groups", which is a statement about groups, and the fix
 * is `mergePersonsBulk`. It is also 4.6x fewer points on a real library
 * (25,758 persons for 118,371 faces), and the projection is superlinear.
 */

import { dequantize } from "../ml/quantize.js";
// The one number, so this fallback cannot disagree with the schema the gear
// renders (#255). `algorithms.js` is pure constants — no cycle.
import { DEFAULT_MIN_FACES } from "../projection/algorithms.js";

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} model
 * @param {{minFaces?: number}} [opts]
 *   `minFaces` is a RUN parameter, not a display filter, and the difference is
 *   load-bearing: a projection of a subset is not a subset of the projection.
 *   Hiding dots after the layout would leave the survivors' positions still
 *   shaped by every point that was hidden — which is exactly the artifact the
 *   filter exists to avoid. Defaults to `DEFAULT_MIN_FACES` (5 since #255,
 *   previously 2), because 20,259 of 25,758 persons in a real library are
 *   singletons: a stranger in the background of one photo, who cannot by
 *   definition be "one person split across groups". Even at 2 the map is
 *   mostly two-face noise, which is what raising it to 5 fixes. Measured, the
 *   old default already turned umap-js's 14.1s unyieldable initializeFit into
 *   2.1s and peak RSS from 1,825MB into 824MB; 5 is cheaper still.
 * @returns {{ids: Int32Array, dim: number, data: Float32Array, faceCounts: Int32Array}}
 *   `data` is `ids.length * dim` floats, ROW-MAJOR — flat rather than an array
 *   of arrays for the reason `faceVectors` gives: at production size the
 *   nested form is 25,758 objects for the GC to walk, and the worker needs to
 *   transfer one buffer.
 *
 *   Row order is `persons.id` ASCENDING, and that is part of correctness, not
 *   tidiness: the run cache is keyed by params, UMAP is order-sensitive, and
 *   an unstable member order would make two runs the cache calls identical
 *   produce different maps with nothing reporting the difference.
 */
export function personCentroids(
  db,
  model,
  { minFaces = DEFAULT_MIN_FACES } = {}
) {
  const floor = Math.max(1, Math.trunc(Number(minFaces) || 1));

  const rows = db
    .prepare(
      `SELECT f.person_id AS pid, f.dim AS dim, f.scale AS scale, f.vec AS vec
         FROM photo_faces f
        WHERE f.model = ?
          AND f.person_id IS NOT NULL
          AND f.person_id IN (
                SELECT person_id
                  FROM photo_faces
                 WHERE model = ? AND person_id IS NOT NULL
                 GROUP BY person_id
                HAVING COUNT(*) >= ?)
        ORDER BY f.person_id, f.id`
    )
    .all(model, model, floor);

  if (!rows.length) {
    return {
      ids: new Int32Array(0),
      dim: 0,
      data: new Float32Array(0),
      faceCounts: new Int32Array(0),
    };
  }

  const dim = rows[0].dim;
  // Mirrors faceVectors' guard, and for the same reason: a mixed-width result
  // cannot be laid out flat, and silently truncating to the first row's width
  // would average garbage. It means two models wrote under one name, which is
  // a bug worth stopping for rather than a map worth drawing.
  const odd = rows.find((r) => r.dim !== dim);
  if (odd) {
    throw new Error(
      `face vectors for ${model} have mixed dimensions (${dim} and ${odd.dim})`
    );
  }

  /** @type {Map<number, {v: Float64Array, n: number}>} */
  const acc = new Map();
  for (const r of rows) {
    let a = acc.get(r.pid);
    if (!a) acc.set(r.pid, (a = { v: new Float64Array(dim), n: 0 }));
    const bytes = new Int8Array(
      r.vec.buffer,
      r.vec.byteOffset,
      r.vec.byteLength
    );
    const f = dequantize(bytes, r.scale);
    for (let i = 0; i < dim; i++) a.v[i] += f[i];
    a.n++;
  }

  const ids = new Int32Array(acc.size);
  const faceCounts = new Int32Array(acc.size);
  const data = new Float32Array(acc.size * dim);

  let row = 0;
  // A Map iterates in insertion order and the query is ORDER BY person_id, so
  // this is ascending person id — the deterministic member order above.
  for (const [pid, a] of acc) {
    ids[row] = pid;
    faceCounts[row] = a.n;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += a.v[i] * a.v[i];
    // `|| 1` rather than a throw: faces that happen to cancel out are a
    // degenerate point, not a corrupt library, and one zero row must not take
    // the whole map down. It lands at the origin, which is visibly odd rather
    // than invisibly NaN.
    norm = Math.sqrt(norm) || 1;
    const base = row * dim;
    for (let i = 0; i < dim; i++) data[base + i] = a.v[i] / norm;
    row++;
  }

  return { ids, dim, data, faceCounts };
}
