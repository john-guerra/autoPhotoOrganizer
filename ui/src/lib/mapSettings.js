/**
 * The Face Map panel's remembered parameters, and its live/Apply boundary
 * (#327, #287).
 *
 * Persistence is `settings.js`, not a second localStorage mechanism — this
 * view already stores its dot-radius preferences there, and two storage
 * helpers in one component is how they drift apart. What lives here is the
 * part `settings.js` deliberately does not do: SANITISING, because these
 * values reach `defaultParams` and become part of a run's cache key.
 */
import { loadSetting, saveSetting } from "./settings.js";

const KEY = "faceMapParams";

/**
 * The latency under which the map may follow a slider.
 *
 * Measured, not guessed. One projection costs 83 ms at 203 people with the
 * preview session's resident graph, ~3.1 s at 5,499 and ~10.7 s at 25,758
 * (`ms = 3.29 * n^0.80`, fitted to real runs). 400 ms puts the boundary where
 * a drag still feels attached to the control.
 *
 * A MEASURED latency rather than a member count, deliberately: the same
 * library is live on a fast machine and Apply-driven on a slow one, and a
 * library that grows past the boundary crosses it by itself. "Live below N
 * people" would be a constant that silently goes stale — the shape of bug this
 * repo keeps paying for.
 */
export const LIVE_MS = 400;

/**
 * May the map follow the slider, given how long the last projection took?
 *
 * `null`/`undefined` is FALSE, not true: before anything has been measured,
 * optimism means a 25,758-person library locks up on the first drag — exactly
 * the case the boundary exists to prevent.
 *
 * @param {number|null|undefined} lastMs
 * @returns {boolean}
 */
export function canGoLive(lastMs) {
  return Number.isFinite(lastMs) && lastMs < LIVE_MS;
}

/**
 * The user's remembered parameters — finite numbers only.
 *
 * A stored `"50"` is not something the schema can clamp, and letting it
 * through would put a string into `defaultParams` and therefore into a run's
 * cache key: the shape of #325, one layer up.
 *
 * @returns {Record<string, number>}
 */
export function loadSettings() {
  const raw = loadSetting(KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** @param {Record<string, number>} obj */
export function saveSettings(obj) {
  saveSetting(KEY, obj ?? {});
}
