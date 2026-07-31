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

/**
 * `minFaces` belongs to the RUN, not to an algorithm — it decides who is on
 * the map at all, and every algorithm projects the same members.
 */
export const MEMBER_PARAMS = Object.freeze([
  Object.freeze({
    key: "minFaces",
    label: "Minimum faces",
    min: 1,
    max: 50,
    step: 1,
    default: 2,
    help: "People with fewer faces than this are left off the map. Most people seen once are strangers in the background of a single photo.",
  }),
]);

/**
 * Each algorithm declares its OWN parameters, as data.
 *
 * Declared here rather than hand-written into the gear because a hardcoded
 * control panel is a third place to edit when an algorithm changes — and the
 * first version of this shipped with UMAP's two parameters as the only
 * controls, so choosing t-SNE offered nothing to tune and its perplexity was
 * frozen in the worker. With a schema, `defaultParams` clamps generically, the
 * gear renders generically, and a new algorithm arrives with its own controls
 * and its own bounds.
 *
 * Every parameter here reaches the run cache key, so changing one is a
 * different map rather than a silently-reused old one.
 *
 * @typedef {{key: string, label: string, min: number, max: number,
 *            step: number, default: number, help: string}} ParamSpec
 */
export const ALGORITHMS = Object.freeze([
  Object.freeze({
    id: "umap",
    label: "UMAP",
    note: "Balanced. Finds the same person in the top 5 about 58% of the time, and works at any size.",
    params: Object.freeze([
      Object.freeze({
        key: "nNeighbors",
        label: "Neighbours",
        min: 2,
        max: 200,
        step: 1,
        default: 15,
        help: "How much of the neighbourhood each point is fitted to. Low values keep tight local groups; high values favour the overall shape.",
      }),
      Object.freeze({
        key: "minDist",
        label: "Minimum distance",
        min: 0,
        max: 5,
        step: 0.05,
        default: 0.1,
        help: "How tightly points may pack together. Lower means denser clumps, which makes near-identical people easier to lasso.",
      }),
      Object.freeze({
        key: "nEpochs",
        label: "Iterations",
        min: 10,
        max: MAX_EPOCHS,
        step: 10,
        default: 200,
        help: "More iterations settle the layout further and take proportionally longer.",
      }),
    ]),
  }),
  Object.freeze({
    id: "tsne",
    label: "t-SNE",
    note: "Slower, best separation — 93% in the top 5. Small maps only.",
    params: Object.freeze([
      Object.freeze({
        key: "perplexity",
        label: "Perplexity",
        min: 2,
        max: 100,
        step: 1,
        default: 30,
        help: "Roughly how many neighbours each point is balanced against. Above about a third of the map it degenerates, so it is capped to that.",
      }),
      Object.freeze({
        key: "epsilon",
        label: "Learning rate",
        min: 1,
        max: 500,
        step: 1,
        default: 10,
        help: "How far points move per iteration. Too high scatters the map; too low leaves it in a ball.",
      }),
      Object.freeze({
        key: "nEpochs",
        label: "Iterations",
        min: 10,
        max: MAX_EPOCHS,
        step: 10,
        default: 200,
        help: "More iterations settle the layout further and take proportionally longer.",
      }),
    ]),
  }),
  Object.freeze({
    id: "pca",
    label: "PCA",
    note: "Instant, but poor separation (7% in the top 5). A sanity check, not a map to merge from.",
    // Deliberately empty, and the gear SAYS so rather than showing a blank
    // panel: PCA is a deterministic projection with nothing to tune, and an
    // empty area with no explanation reads as a broken control.
    params: Object.freeze([]),
  }),
]);

/** @param {string|undefined} id @returns {ReadonlyArray<ParamSpec>} */
export function paramsFor(id) {
  return ALGORITHMS.find((a) => a.id === id)?.params ?? [];
}

/**
 * Every parameter that reaches the cache key for this algorithm: the member
 * params, the algorithm's own, and the seed.
 * @param {string|undefined} id
 */
export function allParamSpecs(id) {
  return [
    ...MEMBER_PARAMS,
    ...paramsFor(id),
    {
      key: "seed",
      label: "Seed",
      min: 0,
      max: 2 ** 31 - 1,
      step: 1,
      default: 1212,
      help: "Change it to get a different arrangement of the same data. The same seed always reproduces the same map.",
    },
  ];
}

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
 * Driven by the SCHEMA rather than a hand-written field list, so an algorithm's
 * parameters are declared once (in `ALGORITHMS`) and are clamped, defaulted and
 * rendered from that one place. The hand-written version silently accepted only
 * UMAP's parameters, which is why t-SNE's perplexity could not be changed.
 *
 * @param {object} [input] may carry `algorithm`; unknown keys are dropped.
 * @returns {Record<string, number>} always includes `minFaces`, `nEpochs` and
 *   `seed`; the rest depend on the algorithm.
 */
export function defaultParams(input = {}) {
  const specs = allParamSpecs(String(input?.algorithm ?? "umap"));
  /** @type {Record<string, number>} */
  const out = {};
  for (const spec of specs) {
    const raw = Number(input?.[spec.key]);
    const v = Number.isFinite(raw) ? raw : spec.default;
    // `step` carries the integer-ness: a step of 1 or more means whole
    // numbers, so `minDist` (0.05) keeps its decimals and `nEpochs` cannot
    // arrive as 200.5 and produce a job whose total is fractional.
    const snapped = spec.step >= 1 ? Math.trunc(v) : v;
    out[spec.key] = Math.min(spec.max, Math.max(spec.min, snapped));
  }
  // `nEpochs` must exist for EVERY algorithm, including ones that declare no
  // iteration parameter: the job's total is read from it before the worker
  // starts, and an indeterminate bar against a knowable total is #208.
  if (out.nEpochs === undefined) out.nEpochs = 200;
  return out;
}
