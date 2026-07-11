import { pickCoverId } from "./pickCover.js";

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

/**
 * Runs detectBursts independently within each contiguous run of items that
 * share the same value for every `groupBy` dimension — detectBursts itself
 * is documented as grouping "a folder's photos" (a single group), but
 * App.svelte's endless feed hands it a window that can span several
 * groups (e.g. two different folders back to back). Without this
 * partitioning, two unrelated folders whose photos happen to have
 * time-adjacent (or, for a duplicated backup, literally identical)
 * timestamps get merged into one cross-folder burst — a real case in
 * John's archive (`fotos_peq/2002/..._comida_peq` and
 * `..._grado_Edwin_peq` share an identical timestamp sequence), which
 * silently corrupted stack membership and cover selection for photos
 * nowhere near each other in the library.
 * `items` is assumed already sorted so each group's rows are contiguous
 * (matches the server's composite ORDER BY — groupBy dimensions first,
 * then time/id).
 *
 * Interaction with the feed SORT (issue #15): bursts are ALWAYS clustered
 * chronologically — detectBursts re-sorts each group's members by time before
 * walking gaps, independent of the active sort attribute. So under a non-date
 * sort (Name / Rating / Size), a burst still groups the same time-adjacent
 * photos, and its collapsed stack is positioned by its cover's place in that
 * sort order. Stacking is therefore never "recomputed against the sorted
 * order"; it is deliberately capture-time based in every sort mode.
 * @param {Array<{id, name, rating?, mtimeMs, takenAt?, groupValues: Record<string,string>}>} items
 * @param {string[]} groupBy
 * @param {{ gapMs: number }} opts
 * @returns {Array<{ id, memberIds: Array<number|string>, coverId, count }>}
 */
export function detectBurstsByGroup(items, groupBy, opts) {
  if (!items.length) return [];
  const runs = [];
  let current = [items[0]];
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    const sameGroup = groupBy.every(
      (d) => prev.groupValues?.[d] === cur.groupValues?.[d]
    );
    if (sameGroup) current.push(cur);
    else {
      runs.push(current);
      current = [cur];
    }
  }
  runs.push(current);
  return runs.flatMap((run) => detectBursts(run, opts));
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

/** Returns the shared prefix for same-burst files, or null if not a burst filename. */
function burstFilenameKey(name) {
  const m = BURST_FILENAME_RE.exec(name);
  return m ? m[1].toLowerCase() : null;
}

/** Cover priority for a time-sorted cluster — delegates to the shared canonical
 * rule in pickCover.js (unwrapping the `{item}` walk wrappers first). */
function pickCover(cluster) {
  return pickCoverId(cluster.map((c) => c.item));
}
