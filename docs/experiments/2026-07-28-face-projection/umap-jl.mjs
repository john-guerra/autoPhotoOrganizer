/**
 * Does a Johnson–Lindenstrauss random projection 512 -> 64 buy us anything?
 * Same centroids, same UMAP params, READ-ONLY.
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

const TARGET = Number(process.argv[2] || 64);
const MODEL = "buffalo_s";
const db = new Database(os.homedir() + "/.autogallery/index.db", {
  readonly: true,
});
const rows = db
  .prepare(
    `SELECT person_id, dim, scale, vec FROM photo_faces
      WHERE model = ? AND person_id IS NOT NULL`
  )
  .all(MODEL);

const dim = rows[0].dim;
const sums = new Map();
for (const r of rows) {
  let acc = sums.get(r.person_id);
  if (!acc) {
    acc = { v: new Float64Array(dim), n: 0 };
    sums.set(r.person_id, acc);
  }
  const b = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
  for (let i = 0; i < dim; i++) acc.v[i] += b[i] * r.scale;
  acc.n++;
}

// deterministic gaussian-ish random matrix (mulberry32 + Box-Muller)
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(42);
const R = new Float64Array(dim * TARGET);
for (let i = 0; i < R.length; i += 2) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  const m = Math.sqrt(-2 * Math.log(u));
  R[i] = m * Math.cos(2 * Math.PI * v);
  if (i + 1 < R.length) R[i + 1] = m * Math.sin(2 * Math.PI * v);
}

const tP = Date.now();
const data = [];
for (const [, acc] of sums) {
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += acc.v[i] * acc.v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(TARGET).fill(0);
  for (let k = 0; k < TARGET; k++) {
    let s = 0;
    for (let i = 0; i < dim; i++) s += (acc.v[i] / norm) * R[i * TARGET + k];
    out[k] = s / Math.sqrt(TARGET);
  }
  data.push(out);
}
console.log(
  `projected ${data.length} x ${dim} -> ${TARGET} in ${((Date.now() - tP) / 1000).toFixed(1)}s`
);
console.log(
  `rss after projection: ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`
);

const UMAP = loadUmapJs();
const umap = new UMAP({ nComponents: 2, nNeighbors: 15, minDist: 0.1 });
const t2 = Date.now();
const nEpochs = umap.initializeFit(data);
console.log(
  `initializeFit: ${((Date.now() - t2) / 1000).toFixed(1)}s  (nEpochs ${nEpochs})`
);
const t3 = Date.now();
for (let i = 0; i < nEpochs; i++) umap.step();
console.log(`epochs: ${((Date.now() - t3) / 1000).toFixed(1)}s`);
console.log(`TOTAL umap: ${((Date.now() - t2) / 1000).toFixed(1)}s`);
console.log(`peak rss: ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`);
