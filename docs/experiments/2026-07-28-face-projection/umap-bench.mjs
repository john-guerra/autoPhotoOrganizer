/**
 * Measure the real cost of a person-level UMAP over John's live library.
 * READ-ONLY against ~/.autogallery/index.db.
 */
import { createRequire } from "node:module";
import os from "node:os";

const req = createRequire(import.meta.url);

/** Lazy, with a message you can act on — these are NOT app dependencies.
 *  See README.md: `npm install` inside this folder first. */
async function loadDruid() {
  try {
    return await import("@saehrimnir/druidjs");
  } catch {
    console.error(
      "\n@saehrimnir/druidjs is not installed. It is deliberately NOT an app\n" +
        "dependency (LGPL). Run `npm install` inside\n" +
        "docs/experiments/2026-07-28-face-projection/ and re-run this script.\n"
    );
    process.exit(1);
  }
}
function loadUmapJs() {
  try {
    return req("umap-js").UMAP;
  } catch {
    console.error(
      "\numap-js is not installed. Run `npm install` inside\n" +
        "docs/experiments/2026-07-28-face-projection/ and re-run this script.\n"
    );
    process.exit(1);
  }
}
const Database = req("better-sqlite3"); // run from the repo root

const MODEL = "buffalo_s";
const t0 = Date.now();
const db = new Database(os.homedir() + "/.autogallery/index.db", {
  readonly: true,
});

// ---- 1. load vectors, accumulate per-person centroids -----------------------
const rows = db
  .prepare(
    `SELECT person_id, dim, scale, vec FROM photo_faces
      WHERE model = ? AND person_id IS NOT NULL`
  )
  .all(MODEL);
console.log(`load: ${rows.length} faces in ${Date.now() - t0}ms`);

const t1 = Date.now();
const dim = rows[0].dim;
const sums = new Map(); // personId -> {v: Float64Array, n}
for (const r of rows) {
  let acc = sums.get(r.person_id);
  if (!acc) {
    acc = { v: new Float64Array(dim), n: 0 };
    sums.set(r.person_id, acc);
  }
  const bytes = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
  for (let i = 0; i < dim; i++) acc.v[i] += bytes[i] * r.scale;
  acc.n++;
}
const ids = [];
const centroids = [];
for (const [pid, acc] of sums) {
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += acc.v[i] * acc.v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) out[i] = acc.v[i] / norm;
  ids.push(pid);
  centroids.push(out);
}
console.log(
  `centroids: ${centroids.length} persons, dim ${dim}, in ${Date.now() - t1}ms`
);

// ---- 2. UMAP ---------------------------------------------------------------
const N = Number(process.argv[2] || centroids.length);
const data = centroids.slice(0, N);
console.log(`\n--- UMAP over ${data.length} points x ${dim} dims ---`);

const UMAP = loadUmapJs();
const umap = new UMAP({ nComponents: 2, nNeighbors: 15, minDist: 0.1 });
const t2 = Date.now();
const nEpochs = umap.initializeFit(data);
const tInit = Date.now() - t2;
console.log(`initializeFit (kNN + graph): ${(tInit / 1000).toFixed(1)}s`);
console.log(`nEpochs: ${nEpochs}`);

const t3 = Date.now();
let last = t3;
let worstStep = 0;
for (let i = 0; i < nEpochs; i++) {
  umap.step();
  const now = Date.now();
  worstStep = Math.max(worstStep, now - last);
  last = now;
}
const tEpochs = Date.now() - t3;
console.log(`epochs: ${(tEpochs / 1000).toFixed(1)}s`);
console.log(`worst single step(): ${worstStep}ms   <-- the yield granularity`);
console.log(
  `TOTAL: ${((tInit + tEpochs) / 1000).toFixed(1)}s for ${data.length} points`
);

const xy = umap.getEmbedding();
const xs = xy.map((p) => p[0]);
const ys = xy.map((p) => p[1]);
console.log(
  `extent: x [${Math.min(...xs).toFixed(1)}, ${Math.max(...xs).toFixed(1)}]  y [${Math.min(...ys).toFixed(1)}, ${Math.max(...ys).toFixed(1)}]`
);
console.log(`rss: ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
