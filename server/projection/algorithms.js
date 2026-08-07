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
 *   UMAP    27.8% nearest   58.3% top-5    (3.9s, at nNeighbors=15)
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
 * The fewest people worth projecting, for PREVIEW AND APPLY ALIKE (#345).
 *
 * One constant because they had drifted: Apply refused below 3 and the preview
 * below 5, so a 3-4 person library could commit a map it was never allowed to
 * preview — the slider 400'd every time, at exactly the size where looking
 * before committing matters most. Neither number was a technical floor;
 * measured against the real worker, n=3 and n=4 project fine and only n=2
 * raises umap-js's "Not enough data points" (it needs nNeighbors >= 2, and the
 * workers clamp k to n - 1). So this is a judgement about what deserves to be
 * called a map, and a judgement is exactly the kind of thing that must not
 * exist twice.
 */
export const MIN_MEMBERS = 3;

/**
 * Why `members` is too few to map, or null when it is enough.
 *
 * Returns the SENTENCE rather than a boolean, because the two cases need
 * different advice: nobody qualifying means "group faces first", while two
 * people qualifying means "lower the minimum". A generic refusal at this
 * boundary leaves the user with a dead button and no next step.
 *
 * @param {number} members
 * @param {number} minFaces
 * @returns {string|null}
 */
export function tooFewMembers(members, minFaces) {
  if (members >= MIN_MEMBERS) return null;
  if (members === 0) {
    return `Nobody has ${minFaces} or more faces yet. Group faces first, or lower the minimum.`;
  }
  const has = members === 1 ? "person has" : "people have";
  return `Only ${members} ${has} ${minFaces} or more faces — that is not a map. Lower the minimum faces.`;
}

/**
 * The largest neighbourhood the slider offers.
 *
 * Exported so the preview session builds its graph at the SAME ceiling — a
 * preview capped lower than the slider would show one map while Apply produced
 * another, which is the #325 failure family (a view quietly presenting itself
 * as something it is not).
 *
 * `worker.js` clamps to `n - 1` regardless, so this is a ceiling on the
 * control rather than a promise about any particular library.
 */
export const MAX_N_NEIGHBORS = 300;

/**
 * How many faces a person needs before they are worth a dot (#255).
 *
 * Exported so the server's own fallbacks (`personCentroids`, `runStaleness`)
 * cannot drift from the schema the gear renders.
 *
 * There is no longer a client copy to keep in step. `ui/` never imports
 * `server/`, and it used to hold literals for `minFaces`/`nNeighbors`/
 * `minDist` and send them with every request — which meant the client's copy
 * WAS the default and this one was unreachable (#307). The client now sends
 * only the parameters the user has actually chosen, so this is the single
 * source and changing it takes effect.
 */
export const DEFAULT_MIN_FACES = 5;

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
    // 5, not 2 (#255). Small groups dominate the map BY COUNT while carrying
    // almost no information — most are detection noise or a stranger in the
    // background of one photo — so at 2 the people you actually came to find
    // and merge are crowded out by thousands of dots you will never name.
    // The threshold is the map's one scope dimension, so raising it also makes
    // the default run cheaper; the gear lowers it whenever you want the tail.
    default: DEFAULT_MIN_FACES,
    help: "People with fewer faces than this are left off the map. Most people seen once or twice are strangers in the background of a photo.",
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
        max: MAX_N_NEIGHBORS,
        step: 1,
        // 30, measured (#326) — and the paragraph below is the part that
        // matters more than the number.
        //
        // Forty real UMAP runs over the real library (one seed, one minDist,
        // 200 epochs, only this parameter moving), rendered as small multiples
        // with real face crops across five photo scopes, John picking the best
        // cell in each:
        //
        //   whole library  255 people -> 30      Austria 2   42 people -> 15
        //   Austria 5      151 people -> 22      Austria 4   53 people -> 36
        //
        // DO NOT DERIVE THIS FROM THE MEMBER COUNT. #307's note argued for
        // exactly that ("a default derived from the point count would preserve
        // what he actually saw"), and this sweep refutes it: Austria 2 and
        // Austria 4 hold 42 and 53 people — nearly the same size — and want
        // values 2.4x apart, so no f(members) can return both. Fitting one
        // anyway gives k = 12.4 * members^0.149 at R^2 = 0.11 (linear would be
        // exponent 1.0, sqrt 0.5); member counts span 6.1x across the scopes
        // while the picks span 2.4x. A cheap clustering pass does not rescue
        // it either — those two scopes have near-identical structure (9 vs 15
        // components at cosine 0.5, mean cluster size 4.7 vs 3.5) and every
        // structural measure correlates r ~ 0.2 with the picks.
        //
        // 50 came from ONE screenshot of a 254-person library and did not
        // replicate: shown the same map again, John picked 30.
        //
        // The honest reading is that the right neighbourhood is a property of
        // the photographs, not of anything the index can count — which is why
        // #327 makes the control live instead of making the default cleverer.
        // Method, the four picks, and the caveats (n=4, eight discrete
        // options) live in
        // `docs/superpowers/specs/2026-08-06-face-map-neighbourhood-design.md`.
        default: 30,
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
