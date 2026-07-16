/**
 * Predictive-prefetch POLICY — the decision of whether/how much to warm ahead on
 * a scroll frame, plus the two scheduling levers (issue order vs loadMore, and
 * request priority). Extracted from `warmAhead` so the SAME code that ships is
 * what the benchmark scores (`prefetchPolicy.bench.test.js`) and what the settings
 * menu tunes. Nothing here touches the DOM or the network — pure, deterministic.
 *
 * Why a policy object at all: the prefetch shares one HTTP/1.1 origin (≈6 sockets)
 * with loadMore's `/api/feed` fetch. Firing too many `new Image()` warms per frame
 * pegs those sockets with slow COLD-thumbnail generations, so the feed request
 * queues behind them and the user out-scrolls the loader ("reached the end before
 * it loaded more"). The knobs below all exist to bound that contention.
 */

/**
 * @typedef {Object} PrefetchConfig
 * @property {boolean} enabled                    master switch
 * @property {number}  minVelocity                px/ms; below this the user is idle/slow → no warm
 * @property {number}  lookaheadMs                warm ~this much travel ahead...
 * @property {number}  maxAheadPx                 ...capped at this many px
 * @property {number}  maxPerFrame                new warms issued per scroll frame
 * @property {number}  inFlightCap                never exceed this many OUTSTANDING warms
 * @property {boolean} suppressWhileFetchingFeed  don't warm while a loadMore fetch is in flight
 * @property {boolean} suppressWhileRunwayShort   don't warm while a loadMore is imminent (below < runway)
 * @property {boolean} loadMoreFirst              issue loadMore BEFORE warms in the frame
 * @property {boolean} lowPriority                mark warms fetchpriority="low" (yield to visible tiles)
 */

/** The candidate strategies — scored by the benchmark AND offered in the settings
 *  menu. Keep these in sync: a strategy that wins the benchmark is a menu preset. */
export const PREFETCH_PRESETS = {
  // Prefetch off entirely — the pre-2.16.4 behaviour (loader had the pipe to itself).
  off: {
    enabled: false,
    minVelocity: 0.15,
    lookaheadMs: 600,
    maxAheadPx: 1000,
    maxPerFrame: 0,
    inFlightCap: 0,
    suppressWhileFetchingFeed: true,
    suppressWhileRunwayShort: true,
    loadMoreFirst: true,
    lowPriority: true,
  },
  // Exactly what shipped in 2.16.4 — unbounded, warm-before-loadMore, normal priority.
  // Kept so the benchmark can reproduce the regression and the menu can A/B it.
  baseline: {
    enabled: true,
    minVelocity: 0.15,
    lookaheadMs: 600,
    maxAheadPx: 2500,
    maxPerFrame: 12,
    inFlightCap: Infinity,
    suppressWhileFetchingFeed: false,
    suppressWhileRunwayShort: false,
    loadMoreFirst: false,
    lowPriority: false,
  },
  // Bounded + yields to the loader. Intended default — validated by the benchmark.
  balanced: {
    enabled: true,
    minVelocity: 0.15,
    lookaheadMs: 600,
    maxAheadPx: 1000,
    maxPerFrame: 4,
    inFlightCap: 4,
    suppressWhileFetchingFeed: true,
    suppressWhileRunwayShort: true,
    loadMoreFirst: true,
    lowPriority: true,
  },
  // Minimal warming — for slow disks / very large libraries.
  conservative: {
    enabled: true,
    minVelocity: 0.25,
    lookaheadMs: 400,
    maxAheadPx: 500,
    maxPerFrame: 2,
    inFlightCap: 2,
    suppressWhileFetchingFeed: true,
    suppressWhileRunwayShort: true,
    loadMoreFirst: true,
    lowPriority: true,
  },
};

/** Shipped default. Set to the benchmark winner. */
export const PREFETCH_CONFIG = PREFETCH_PRESETS.balanced;

/** Tunable knobs, in the order the settings panel renders them. `kind` picks the
 *  control: "range" → slider (min/max/step), "toggle" → checkbox. `hint` is the
 *  one-liner under the control. Kept here (not in the .svelte) so the panel and
 *  {@link normalizePrefetch} agree on every bound. */
export const PREFETCH_KNOBS = [
  {
    key: "enabled",
    label: "Prefetch enabled",
    kind: "toggle",
    hint: "Master switch for warming tiles ahead of the scroll.",
  },
  {
    key: "maxPerFrame",
    label: "Warms per frame",
    kind: "range",
    min: 0,
    max: 24,
    step: 1,
    hint: "New thumbnails requested each scroll frame. Higher = more aggressive.",
  },
  {
    key: "inFlightCap",
    label: "Max outstanding warms",
    kind: "range",
    min: 0,
    max: 32,
    step: 1,
    hint: "Ceiling on warms in flight at once — the main contention limit.",
  },
  {
    key: "maxAheadPx",
    label: "Look-ahead distance (px)",
    kind: "range",
    min: 0,
    max: 4000,
    step: 100,
    hint: "How far below the viewport to warm, in pixels.",
  },
  {
    key: "lookaheadMs",
    label: "Look-ahead time (ms)",
    kind: "range",
    min: 0,
    max: 1500,
    step: 50,
    hint: "Warm roughly this much scroll-travel ahead (capped by distance).",
  },
  {
    key: "minVelocity",
    label: "Min scroll speed",
    kind: "range",
    min: 0,
    max: 1,
    step: 0.05,
    hint: "px/ms below which the user is idle → don't warm.",
  },
  {
    key: "suppressWhileFetchingFeed",
    label: "Yield to the loader",
    kind: "toggle",
    hint: "Pause warming while a page fetch is in flight (protects the feed).",
  },
  {
    key: "suppressWhileRunwayShort",
    label: "Yield when a load is imminent",
    kind: "toggle",
    hint: "Pause warming when the next page is about to load.",
  },
  {
    key: "loadMoreFirst",
    label: "Load pages before warming",
    kind: "toggle",
    hint: "Issue the page fetch ahead of warms within a frame.",
  },
  {
    key: "lowPriority",
    label: "Low-priority warms",
    kind: "toggle",
    hint: "Mark warms low priority so visible tiles win the pipe.",
  },
];

const KNOB = Object.fromEntries(PREFETCH_KNOBS.map((k) => [k.key, k]));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Coerce a (possibly user-edited / persisted) config into a valid one: every
 *  range knob clamped to its bounds, every toggle a boolean, missing keys filled
 *  from {@link PREFETCH_CONFIG}. `inFlightCap` of the max slider value means
 *  "unlimited" (Infinity) so a Custom preset can reproduce baseline. */
export function normalizePrefetch(cfg = {}) {
  const out = { ...PREFETCH_CONFIG };
  for (const k of PREFETCH_KNOBS) {
    const v = cfg[k.key];
    if (k.kind === "toggle") {
      if (typeof v === "boolean") out[k.key] = v;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k.key] = clamp(v, k.min, k.max);
    } else if (v === Infinity && k.key === "inFlightCap") {
      out[k.key] = k.max;
    }
  }
  if (out.inFlightCap >= KNOB.inFlightCap.max) out.inFlightCap = Infinity;
  return out;
}

const NONE = Object.freeze({ aheadPx: 0, maxRequests: 0 });

/**
 * Decide this frame's warm budget.
 *
 * @param {{ velocity:number, direction:"up"|"down", jumpPinned?:boolean,
 *           fetchingFeed?:boolean, belowRunwayPx:number, runwayPx:number,
 *           inFlight:number }} s  current scroll/pipe state
 * @param {PrefetchConfig} cfg
 * @returns {{ aheadPx:number, maxRequests:number }} px to look ahead, and how many
 *   NEW warms to issue (0 ⇒ warm nothing this frame)
 */
export function planPrefetch(s, cfg = PREFETCH_CONFIG) {
  if (!cfg.enabled) return NONE;
  if (!(s.velocity >= cfg.minVelocity)) return NONE;
  // Don't prefetch backward while a jump/expand landing is being pinned (same
  // reason loadMore("before") is suppressed there).
  if (s.direction === "up" && s.jumpPinned) return NONE;
  // Yield the connection pool to the loader: a queued /api/feed behind a pool full
  // of cold-thumbnail warms is exactly what makes the feed land late.
  if (cfg.suppressWhileFetchingFeed && s.fetchingFeed) return NONE;
  if (cfg.suppressWhileRunwayShort && s.belowRunwayPx < s.runwayPx) return NONE;
  const maxRequests = Math.min(
    cfg.maxPerFrame,
    Math.max(0, cfg.inFlightCap - s.inFlight)
  );
  if (maxRequests <= 0) return NONE;
  return {
    aheadPx: Math.min(cfg.maxAheadPx, s.velocity * cfg.lookaheadMs),
    maxRequests,
  };
}
