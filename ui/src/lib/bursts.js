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
 * @param {Array<{id: number|string, name: string, rating?: number, preferredCover?: boolean, mtimeMs: number, takenAt?: string|number|null, dupeGroupId?: number|null}>} items
 * @param {{ gapMs: number, unrelatedBelow?: number }} opts `unrelatedBelow` is
 *   the refiner bar (#216): a time-adjacent pair whose measured similarity is
 *   below it is NOT stacked. Defaults to 0, which can never fire — so a caller
 *   that does not opt in, and any library with no embeddings, keeps exactly
 *   the previous behaviour.
 * @returns {Array<{ id: string, memberIds: Array<number|string>, coverId: number|string, count: number }>}
 */
export function detectBursts(items, { gapMs, unrelatedBelow = 0 }) {
  if (!items.length) return [];

  const withTime = items
    .map((item) => ({
      item,
      time: toMs(item.takenAt) ?? item.mtimeMs,
      burstKey: burstFilenameKey(item.name),
      dupeGroup: item.dupeGroupId ?? null,
      simPrev: item.simPrev ?? null,
      simPrevId: item.simPrevId ?? null,
    }))
    .sort((a, b) => a.time - b.time);

  // Walk consecutive photos (in chronological order), merging into a
  // running cluster whenever ANY of three independent signals says so:
  // the gap is within gapMs; both photos share the same Pixel
  // burst-filename prefix (a hard-link override for the rare case a genuine
  // burst's timestamps land wider apart than gapMs); or both were placed in
  // the same near-duplicate group by the server's embedding sweep (#162).
  //
  // The third is the same SHAPE as the second: a supporting signal that can
  // rescue a burst the time gap alone would split.
  //
  // Similarity plays a SECOND, opposite role below (#216) — it can also VETO
  // a time merge. #162 deliberately forbade that, on the grounds that a wrong
  // grouping must never dissolve a burst the user relies on; the measurements
  // in the veto's own comment overturned it. Both roles are gated on having
  // actually measured the pair in question, so a library with no embeddings —
  // still the default, since the feature is opt-in — gets byte-for-byte the
  // behaviour it had before either existed.
  const clusters = [];
  let current = [withTime[0]];
  for (let i = 1; i < withTime.length; i++) {
    const prev = current[current.length - 1];
    const cur = withTime[i];
    const withinGap = cur.time - prev.time <= gapMs;
    const sameBurst = prev.burstKey !== null && prev.burstKey === cur.burstKey;
    const sameDupe =
      prev.dupeGroup !== null && prev.dupeGroup === cur.dupeGroup;
    // THE REFINER (#216). Time-adjacency inside the gap turns out to be a poor
    // predictor of "same shot": measured over 10,424 such pairs in a real
    // library, the median similarity is 0.677 and the lower quartile 0.508 —
    // unrelated-subject territory. A quarter of what the gap stacks together
    // is visibly unrelated.
    //
    // So similarity is allowed to VETO a time merge, which reverses #162's
    // "additive only" rule. That rule protected shipped behaviour; the numbers
    // above say the shipped behaviour is the thing that needs fixing. It also
    // retires the bug that forced detectBurstsByGroup to partition by folder:
    // the fotos_peq/2002 false burst (identical timestamps, different photos)
    // scores ~0.5 and is now split on its merits.
    //
    // Three conditions, and every one of them is a guard against splitting a
    // burst we are not entitled to split:
    //   - a score exists at all (both photos embedded — the sweep only writes
    //     a row when it could compare them);
    //   - it describes THIS pair (simPrevId identifies the photo it was
    //     measured against; the client's order inside the active grouping need
    //     not match the sweep's, and comparing the wrong pair is worse than
    //     not comparing);
    //   - it is below the veto bar, which is far lower than the merge bar —
    //     between them the signal is agnostic and time's verdict stands.
    const judged = cur.simPrev !== null && cur.simPrevId === prev.item.id;
    const vetoed = judged && cur.simPrev < unrelatedBelow;
    if ((withinGap && !vetoed) || sameBurst || sameDupe) {
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
