/**
 * Pure math for the feed scrubber. No DOM, no Svelte. Turns the /api/tree/flat
 * response into coarse landmarks + cumulative counts and maps between cumulative
 * count (or sort value) and rail pixels. See
 * docs/superpowers/specs/2026-07-16-feed-scrubber-and-skeleton-design.md.
 */

/**
 * @param {{ total:number, leaves:Array<{values:Record<string,string>,count:number}> }} flat
 * @param {{ groupBy: string[] }} opts  ordered grouping dims (coarsest first)
 * @returns {{ total:number, landmarks:Array<{key:string,label:string,value:string,startCount:number,count:number,path:Array<{dimension:string,value:string}>}>, cumStart:number[] }}
 */
export function buildManifest(flat, { groupBy }) {
  const coarse = groupBy?.[0];
  const leaves = flat.leaves ?? [];
  const cumStart = [0];
  for (let i = 0; i < leaves.length; i++)
    cumStart.push(cumStart[i] + leaves[i].count);

  const landmarks = [];
  let running = 0;
  let current = null;
  for (const leaf of leaves) {
    const value = coarse ? (leaf.values[coarse] ?? "") : "";
    if (!current || current.value !== value) {
      current = {
        key: value,
        label: value,
        value,
        startCount: running,
        count: 0,
        path: coarse ? [{ dimension: coarse, value }] : [],
      };
      landmarks.push(current);
    }
    current.count += leaf.count;
    running += leaf.count;
  }
  return {
    total: flat.total ?? running,
    landmarks,
    cumStart,
    labelStops: labelStopsFor(landmarks, coarse),
  };
}

/** Path split into non-empty segments. */
export function segments(path) {
  return String(path).split("/").filter(Boolean);
}

/** Number of leading path segments shared by EVERY landmark (the common trunk). */
export function commonPrefixLen(landmarks) {
  if (!landmarks.length) return 0;
  const segs = landmarks.map((l) => segments(l.value));
  const min = Math.min(...segs.map((s) => s.length));
  let k = 0;
  for (; k < min; k++) {
    const v = segs[0][k];
    if (!segs.every((s) => s[k] === v)) break;
  }
  return k;
}

/**
 * The path depth to label folders at. Folder grouping lists leaves in depth-first
 * TREE order, so contiguous runs share ancestors; we want to label by the ancestor
 * at the level where the tree actually branches. Starting at the common trunk, we
 * descend to the shallowest depth that has at least `minDistinct` distinct ancestor
 * subtrees — that skips a lopsided trunk (e.g. `…/fotos_peq/DUTO` holding ~98% of a
 * library) and lands on the level the sidebar shows.
 */
export function folderLabelDepth(landmarks, minDistinct = 8) {
  const segs = landmarks.map((l) => segments(l.value));
  const maxLen = Math.max(1, ...segs.map((s) => s.length));
  const start = commonPrefixLen(landmarks);
  for (let d = start; d < maxLen; d++) {
    const set = new Set();
    for (const s of segs)
      if (s.length > d) set.add(s.slice(0, d + 1).join("/"));
    if (set.size >= minDistinct) return d;
  }
  return Math.max(start, maxLen - 1);
}

/**
 * Which landmarks get a TEXT label on the rail. Folder grouping produces one
 * landmark per leaf folder — hundreds of them — so we collapse each contiguous run
 * that shares the same tree ancestor (at `folderLabelDepth`) to a single stop
 * labeled with that ancestor's name. This mirrors the library tree, avoids the
 * misleading leaf-name repeats (`fotos_historia`/`fotos_pruebas` are not two "fotos"
 * marks), and stays meaningful for non-date folder names. Other groupings (year,
 * camera…) are already coarse — every landmark is a stop. The fine per-folder
 * `landmarks` still drive density, scrubbing and the hover tooltip.
 */
export function labelStopsFor(landmarks, coarse) {
  if (coarse !== "folder" && coarse !== "folderName") return landmarks;
  if (!landmarks.length) return landmarks;
  const d = folderLabelDepth(landmarks);
  const stops = [];
  let lastKey = null;
  for (const lm of landmarks) {
    const segs = segments(lm.value);
    const idx = Math.min(d, segs.length - 1); // shallower leaves label by their own name
    const key = segs.slice(0, idx + 1).join("/"); // ancestor identity (full path)
    if (key !== lastKey) {
      stops.push({ ...lm, token: segs[idx] || lm.value });
      lastKey = key;
    }
  }
  return stops;
}

/** Cumulative count → rail pixel y. */
export function countToY(n, total, railH) {
  if (!(total > 0)) return 0;
  return (n / total) * railH;
}

/** Rail pixel y → cumulative count. */
export function yToCount(y, total, railH) {
  if (!(total > 0) || !(railH > 0)) return 0;
  return (y / railH) * total;
}

/** The landmark whose [startCount, startCount+count) contains n (clamped to last). */
export function landmarkAtCount(manifest, n) {
  const ls = manifest.landmarks;
  if (!ls.length) return null;
  for (let i = ls.length - 1; i >= 0; i--)
    if (n >= ls[i].startCount) return ls[i];
  return ls[0];
}

/**
 * A position scale for the rail. `axis` is "count" (cumulative count) or "value"
 * (sort value, linear between min/max). Value axis falls back to count when
 * `valueOf` is non-finite for any landmark (categorical/folder — no metric).
 *
 * @param {"count"|"value"} axis
 * @param {ReturnType<typeof buildManifest>} manifest
 * @param {number} railH
 * @param {{ valueOf?: (l:any)=>number }} [opts]
 * @returns {{ toY:(l:any)=>number, fromY:(y:number)=>number }}
 */
export function axisScale(axis, manifest, railH, { valueOf } = {}) {
  const total = manifest.total;
  const countScale = {
    toY: (l) => countToY(l.startCount, total, railH),
    fromY: (y) => yToCount(y, total, railH),
  };
  if (axis !== "value" || !valueOf) return countScale;

  const vals = manifest.landmarks.map((l) => valueOf(l));
  if (!vals.every((v) => Number.isFinite(v))) return countScale;

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  return {
    toY: (l) => ((valueOf(l) - min) / span) * railH,
    fromY: (y) => min + (y / railH) * span,
  };
}

/**
 * Label thinning to a minimum pixel gap. Without `weight` it's the plain greedy
 * top-to-bottom keep-first. With `weight` it's PRIORITY thinning: try the
 * highest-weight landmarks first (weight by count), so a group that owns a big
 * share of the rail always gets its label instead of being dropped because a tiny
 * neighbour sorts just above it — e.g. a 70D camera holding a third of the library
 * whose label sits 16px down and would otherwise lose to the cameras stacked above
 * it. Rendering order (top→bottom) is restored at the end.
 */
export function thinLabels(landmarks, railH, minGapPx, toY, { weight } = {}) {
  if (!weight) {
    const kept = [];
    let lastY = -Infinity;
    for (const l of landmarks) {
      const y = toY(l);
      if (y - lastY >= minGapPx) {
        kept.push(l);
        lastY = y;
      }
    }
    return kept;
  }
  const order = landmarks
    .map((l, i) => ({ i, y: toY(l), w: weight(l) }))
    .sort((a, b) => b.w - a.w || a.i - b.i);
  const keptYs = [];
  const keptIdx = new Set();
  for (const { i, y } of order) {
    if (keptYs.every((ky) => Math.abs(ky - y) >= minGapPx)) {
      keptYs.push(y);
      keptIdx.add(i);
    }
  }
  return landmarks.filter((_, i) => keptIdx.has(i));
}

/**
 * Bin ascending epoch-ms `times` into `bins` equal-width buckets over [min,max].
 * Powers the date "scent" on the value axis (the same whole-library timestamps
 * the top timeline samples). Out-of-range values clamp to the edge buckets.
 * @returns {number[]} per-bucket counts (length `bins`)
 */
export function densityBins(times, min, max, bins) {
  const out = new Array(Math.max(0, bins)).fill(0);
  if (!times?.length || !(max > min) || bins < 1) return out;
  const span = max - min;
  for (const t of times) {
    let i = Math.floor(((t - min) / span) * bins);
    if (i < 0) i = 0;
    if (i >= bins) i = bins - 1;
    out[i]++;
  }
  return out;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Display label for a landmark, by its coarsest dimension.
 * @param {any} landmark
 * @param {{ groupBy: string[] }} ctx
 */
export function landmarkLabel(landmark, { groupBy }) {
  const dim = groupBy?.[0];
  const v = landmark.value;
  if (dim === "folder" || dim === "folderName") {
    const parts = String(v).split("/").filter(Boolean);
    return parts[parts.length - 1] || v;
  }
  if (dim === "month") {
    const idx = Number(v) - 1;
    return MONTHS[idx] ?? v;
  }
  return String(v); // year, camera, kind, day
}
