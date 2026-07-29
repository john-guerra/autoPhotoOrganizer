/**
 * Which DruidJS algorithms can actually run on John's 25,758 person centroids?
 * Run one algorithm per process so an OOM kills only that one.
 * usage: node druid-bench.mjs <ALG> <N>
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

const ALG = process.argv[2];
const N = Number(process.argv[3] || 25758);

const db = new Database(os.homedir() + "/.autogallery/index.db", {
  readonly: true,
});
const rows = db
  .prepare(
    `SELECT person_id, dim, scale, vec FROM photo_faces
      WHERE model='buffalo_s' AND person_id IS NOT NULL`
  )
  .all();
const dim = rows[0].dim;
const sums = new Map();
for (const r of rows) {
  let a = sums.get(r.person_id);
  if (!a) sums.set(r.person_id, (a = { v: new Float64Array(dim), n: 0 }));
  const b = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
  for (let i = 0; i < dim; i++) a.v[i] += b[i] * r.scale;
  a.n++;
}
const data = [];
for (const [, a] of sums) {
  let nrm = 0;
  for (let i = 0; i < dim; i++) nrm += a.v[i] * a.v[i];
  nrm = Math.sqrt(nrm) || 1;
  const o = new Array(dim);
  for (let i = 0; i < dim; i++) o[i] = a.v[i] / nrm;
  data.push(o);
  if (data.length >= N) break;
}

const druid = await loadDruid();
const params = { d: 2, metric: druid.cosine };
if (ALG === "TSNE") delete params.metric; // needs squared metric
const t = Date.now();
let out;
try {
  const DR = new druid[ALG](druid.Matrix.from(data), params);
  out = DR.transform();
} catch (e) {
  console.log(`${ALG}\t${data.length}\tERROR\t${e.message.slice(0, 90)}`);
  process.exit(0);
}
const secs = (Date.now() - t) / 1000;
const arr = out.to2dArray ? out.to2dArray() : out;
const xs = arr.map((p) => p[0]).filter(Number.isFinite);
console.log(
  `${ALG}\t${data.length}\t${secs.toFixed(1)}s\trss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB\tfinite ${xs.length}/${arr.length}`
);
