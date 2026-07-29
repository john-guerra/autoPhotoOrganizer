/**
 * QUALITY, not speed: can this projection support the lasso?
 *
 * Split every person with >=6 faces into two halves and treat each half as its
 * own "person". Two halves of one person ARE the same person, so a projection
 * that works must land them near each other. We measure the 2-D rank of each
 * twin among all points: rank 1 means "nearest neighbour is my other half".
 *
 * usage: node twin-rank.mjs <ALG> [maxSingletons]
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

const ALG = process.argv[2] || "PCA";
const MAX_SINGLE = Number(process.argv[3] ?? 3000);

const db = new Database(os.homedir() + "/.autogallery/index.db", {
  readonly: true,
});
const rows = db
  .prepare(
    `SELECT id, person_id, dim, scale, vec FROM photo_faces
      WHERE model='buffalo_s' AND person_id IS NOT NULL ORDER BY person_id, id`
  )
  .all();
const dim = rows[0].dim;

const byPerson = new Map();
for (const r of rows) {
  if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, []);
  byPerson.get(r.person_id).push(r);
}

const centroid = (list) => {
  const v = new Float64Array(dim);
  for (const r of list) {
    const b = new Int8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
    for (let i = 0; i < dim; i++) v[i] += b[i] * r.scale;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
};

const data = [];
const twin = []; // index of my other half, or -1
let singles = 0;
for (const [, faces] of byPerson) {
  if (faces.length >= 6) {
    // interleave so both halves span the same photos/time, not first-vs-last
    const a = faces.filter((_, i) => i % 2 === 0);
    const b = faces.filter((_, i) => i % 2 === 1);
    const ia = data.push(centroid(a)) - 1;
    const ib = data.push(centroid(b)) - 1;
    twin[ia] = ib;
    twin[ib] = ia;
  } else if (singles < MAX_SINGLE) {
    // distractors: real other people the twin must beat
    data.push(centroid(faces));
    twin[data.length - 1] = -1;
    singles++;
  }
}
const pairs = twin.filter((t) => t >= 0).length / 2;
console.log(
  `${ALG}: ${data.length} points (${pairs} split pairs + ${singles} distractors)`
);

const t = Date.now();
let xy;
if (ALG === "UMAPJS") {
  const UMAP = loadUmapJs();
  const u = new UMAP({ nComponents: 2, nNeighbors: 15, minDist: 0.1 });
  xy = u.fit(data);
} else {
  const druid = await loadDruid();
  const p = { d: 2 };
  if (ALG !== "TSNE") p.metric = druid.cosine;
  const out = new druid[ALG](druid.Matrix.from(data), p).transform();
  xy = out.to2dArray ? out.to2dArray() : out;
}
const secs = ((Date.now() - t) / 1000).toFixed(1);

// rank of the twin among all other points, by 2-D distance
const ranks = [];
for (let i = 0; i < data.length; i++) {
  const j = twin[i];
  if (j < 0) continue;
  const dx = xy[i][0] - xy[j][0];
  const dy = xy[i][1] - xy[j][1];
  const dTwin = dx * dx + dy * dy;
  let better = 0;
  for (let k = 0; k < data.length; k++) {
    if (k === i || k === j) continue;
    const ex = xy[i][0] - xy[k][0];
    const ey = xy[i][1] - xy[k][1];
    if (ex * ex + ey * ey < dTwin) better++;
  }
  ranks.push(better + 1);
}
ranks.sort((a, b) => a - b);
const pct = (p) =>
  ranks[Math.min(ranks.length - 1, Math.floor(ranks.length * p))];
const share = (n) =>
  ((ranks.filter((r) => r <= n).length / ranks.length) * 100).toFixed(1);
console.log(
  `  ${secs}s | twin is #1 for ${share(1)}% | top-5 ${share(5)}% | top-20 ${share(20)}% | median rank ${pct(0.5)} | p90 ${pct(0.9)}`
);
