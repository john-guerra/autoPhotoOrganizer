/**
 * Which projections are worth offering, at what size, and with what defaults
 * (#232).
 *
 * A pure module rather than markup, so "is t-SNE offered at 25,758 people?"
 * is a unit test instead of something to eyeball in a dropdown.
 *
 * ---
 *
 * THE NOTES CARRY MEASURED NUMBERS, and the measurement is the reason this
 * menu is three items rather than fifteen. Method and raw results:
 * `docs/experiments/2026-07-28-face-projection/`.
 *
 * Split each person's faces into an earliest half and a latest half at least
 * 24h apart — the real "two clusters the model split because they looked
 * different" case — then measure the 2-D rank of each half's twin:
 *
 *   t-SNE   62.5% nearest   93.1% top-5    (74s at 4,072 points, O(n^2))
 *   UMAP    27.8% nearest   58.3% top-5    (3.9s)
 *   MDS      2.8% nearest   11.1% top-5
 *   PCA      2.8% nearest    6.9% top-5    (0.8s)
 *   SQDMDS   0.0% nearest    0.0% top-5    (median rank 1822)
 *
 * Only the neighbour-graph family works: t-SNE and UMAP optimise local
 * neighbourhood membership, which is literally the question "which other
 * group is mine". Distance-preserving methods score at or near chance.
 *
 * SQDMDS and MDS are absent DELIBERATELY, and SQDMDS is the one to watch: it
 * scores 100% on a naive interleaved split (two halves of one cluster share
 * day, light and angle, so their centroids are nearly identical and any
 * distance-preserving method keeps them together) and 0.0% on the real one.
 * Anyone who benchmarks this again with an easy split will pick it. PCA stays
 * because a fast, obviously-bad baseline is useful for telling "the map is
 * wrong" from "the data is wrong" — and it is labelled as such.
 */

/**
 * t-SNE is O(n^2): 74s at 4,072 points measured, which puts 25,758 at roughly
 * 47 minutes. Above this it is shown DISABLED with a reason rather than hidden
 * — a missing option reads as a missing feature, and an offered one wedges the
 * app.
 */
export const TSNE_MAX_MEMBERS = 6000;

/** Hard ceiling on epochs, so a hostile or fat-fingered request cannot queue a
 *  job nobody asked to wait for. */
export const MAX_EPOCHS = 2000;

export const ALGORITHMS = Object.freeze([
  Object.freeze({
    id: "umap",
    label: "UMAP",
    note: "Balanced. Finds the same person in the top 5 about 58% of the time, and works at any size.",
  }),
  Object.freeze({
    id: "tsne",
    label: "t-SNE",
    note: "Slower, best separation — 93% in the top 5. Small maps only.",
  }),
  Object.freeze({
    id: "pca",
    label: "PCA",
    note: "Instant, but poor separation (7% in the top 5). A sanity check, not a map to merge from.",
  }),
]);

/**
 * Every algorithm, each marked enabled or not for this member count.
 *
 * Returns them ALL rather than filtering, so the UI can show a disabled option
 * with its reason. Silently omitting one is how a user concludes the feature
 * is missing.
 *
 * @param {number} memberCount
 * @returns {Array<{id:string,label:string,note:string,enabled:boolean,reason:string}>}
 */
export function offerableAlgorithms(memberCount) {
  const n = Number.isFinite(Number(memberCount)) ? Number(memberCount) : 0;
  return ALGORITHMS.map((a) => {
    if (a.id === "tsne" && n > TSNE_MAX_MEMBERS) {
      return {
        ...a,
        enabled: false,
        reason: `t-SNE needs ${TSNE_MAX_MEMBERS.toLocaleString("en-US")} people or fewer — raise the minimum faces to shrink the map.`,
      };
    }
    return { ...a, enabled: true, reason: "" };
  });
}

/** @param {string|undefined} id @param {number} memberCount */
export function isOfferable(id, memberCount) {
  return offerableAlgorithms(memberCount).some((a) => a.id === id && a.enabled);
}

/**
 * The run parameters, defaulted and clamped.
 *
 * The returned object IS the cache key (see `paramsKey`), which forces two
 * properties this function exists to guarantee:
 *
 *  - **Only known keys survive.** An unknown field riding in from a JSON body
 *    would change the key, so every request would miss the cache and recompute
 *    a twenty-second map forever, with nothing reporting why.
 *  - **`nEpochs` is always explicit**, never left to umap-js's internal
 *    500/400/300/200 size heuristic. The job's `total` has to be knowable
 *    BEFORE the worker starts, or the bar is indeterminate at exactly the
 *    moment the user is deciding whether it hung (#208) — and a key that
 *    omits it would collide two genuinely different runs.
 *
 * @param {object} [input]
 * @returns {{minFaces:number,nNeighbors:number,minDist:number,nEpochs:number,seed:number}}
 */
export function defaultParams(input = {}) {
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  return {
    // 2, because 20,259 of 25,758 persons in a real library are singletons.
    minFaces: clamp(Math.trunc(num(input.minFaces, 2)), 1, 1_000_000),
    // <2 neighbours is not a neighbourhood; the graph degenerates.
    nNeighbors: clamp(Math.trunc(num(input.nNeighbors, 15)), 2, 200),
    minDist: clamp(num(input.minDist, 0.1), 0, 5),
    nEpochs: clamp(Math.trunc(num(input.nEpochs, 200)), 10, MAX_EPOCHS),
    seed: Math.trunc(num(input.seed, 1212)),
  };
}
