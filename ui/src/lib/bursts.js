/**
 * Groups a folder's photos into bursts by chronological proximity, with a
 * filename-based hard-link override for genuine Pixel burst-mode
 * sequences, and picks a cover photo per burst.
 *
 * Pure — no DOM, no Svelte. See
 * docs/superpowers/specs/2026-07-06-burst-detection-design.md for the
 * full rationale (in particular: why time-gap grouping is the primary
 * mechanism and filename matching is a supporting signal, not a
 * competing gate).
 *
 * @param {Array<{id: number|string, name: string, rating?: number, preferredCover?: boolean, mtimeMs: number, takenAt?: string|number|null}>} items
 * @param {{ gapMs: number }} opts
 * @returns {Array<{ id: string, memberIds: Array<number|string>, coverId: number|string, count: number }>}
 */
export function detectBursts(items, { gapMs }) {
  if (!items.length) return [];

  const withTime = items
    .map((item) => ({
      item,
      time: toMs(item.takenAt) ?? item.mtimeMs,
      burstKey: burstFilenameKey(item.name),
    }))
    .sort((a, b) => a.time - b.time);

  // Walk consecutive photos (in chronological order), merging into a
  // running cluster whenever either the gap is within gapMs, or both
  // photos share the same Pixel burst-filename prefix (a hard-link
  // override for the rare case a genuine burst's timestamps land wider
  // apart than gapMs).
  const clusters = [];
  let current = [withTime[0]];
  for (let i = 1; i < withTime.length; i++) {
    const prev = current[current.length - 1];
    const cur = withTime[i];
    const withinGap = cur.time - prev.time <= gapMs;
    const sameBurst = prev.burstKey !== null && prev.burstKey === cur.burstKey;
    if (withinGap || sameBurst) {
      current.push(cur);
    } else {
      clusters.push(current);
      current = [cur];
    }
  }
  clusters.push(current);

  return clusters
    .filter((cluster) => cluster.length >= 2)
    .map((cluster) => {
      const coverId = pickCover(cluster);
      return {
        // Anchored to the chronologically-first member (cluster is
        // time-sorted, so cluster[0] is stable), NOT coverId — coverId
        // can change when a user rates a different member the highest
        // (pickCover prefers the highest-rated member), and the stack's
        // identity must survive that so a grid that's tracking "this
        // stack is expanded" by id doesn't silently lose track of it.
        id: `burst-${cluster[0].item.id}`,
        memberIds: cluster.map((c) => c.item.id),
        coverId,
        count: cluster.length,
      };
    });
}

/** Coerces a numeric ms value or ISO-8601 string into ms; null if unparseable. */
function toMs(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

const BURST_FILENAME_RE = /^(.*)\.BURST-\d+(?:\.COVER)?\.[^.]+$/i;
const COVER_FILENAME_RE = /\.COVER\.[^.]+$/i;

/** Returns the shared prefix for same-burst files, or null if not a burst filename. */
function burstFilenameKey(name) {
  const m = BURST_FILENAME_RE.exec(name);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Cover priority: a manually-chosen member (item.preferredCover === true),
 * else the highest-rated member, else the file marked `.COVER.`, else the
 * chronologically-first member. `cluster` is already sorted chronologically
 * (it's a run from the outer time-sorted walk), so cluster[0] is the
 * chronologically-first member. If more than one member somehow carries
 * `preferredCover`, the first in cluster order wins — the app's own UI
 * never lets that happen (see
 * docs/superpowers/specs/2026-07-06-burst-stack-visual-and-manual-cover-design.md),
 * this is just a deterministic fallback.
 */
function pickCover(cluster) {
  const manual = cluster.find((c) => c.item.preferredCover === true);
  if (manual) return manual.item.id;

  let bestRated = null;
  for (const c of cluster) {
    if (
      c.item.rating > 0 &&
      (bestRated === null || c.item.rating > bestRated.item.rating)
    ) {
      bestRated = c;
    }
  }
  if (bestRated) return bestRated.item.id;

  const coverMarked = cluster.find((c) => COVER_FILENAME_RE.test(c.item.name));
  if (coverMarked) return coverMarked.item.id;

  return cluster[0].item.id;
}
