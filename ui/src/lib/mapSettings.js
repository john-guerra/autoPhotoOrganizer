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
 * What one projection will cost, before we have measured one.
 *
 * `ms = 3.29 * n^0.80`, fitted to real runs on the real library (21 -> 46 ms,
 * 203 -> 201 ms, 852 -> 842 ms). It exists ONLY to answer the first question,
 * because a real measurement is not available yet and the two candidates are
 * both wrong: assuming live locks up a 25,758-person library on the first
 * drag, and assuming Apply means a small library can never become live, since
 * a measurement only ever arrives from a preview that live mode would have to
 * allow first.
 *
 * It is a cold-start prior and nothing else — one warm measurement replaces
 * it, and `canGoLive` prefers the measurement whenever there is one.
 *
 * @param {number|null|undefined} members
 * @returns {number|null} milliseconds, or null when the count is unknown
 */
export function estimateMs(members) {
  const n = Number(members);
  if (!Number.isFinite(n) || n < 1) return null;
  return 3.29 * n ** 0.8;
}

/**
 * May the map follow the slider, given how long the last projection took?
 *
 * `lastMs` must come from a WARM projection. A cold one paid to build the
 * neighbour graph — 438 ms against 127 ms warm, measured on the real library —
 * and thresholding on that one-off would disqualify live mode using a cost
 * that never recurs.
 *
 * With no measurement, falls back to `estimateMs(members)`; with neither, it
 * is false, because assuming live is how a large library locks up on the first
 * drag.
 *
 * @param {number|null|undefined} lastMs a WARM projection's duration
 * @param {number|null|undefined} [members] for the cold-start estimate
 * @returns {boolean}
 */
export function canGoLive(lastMs, members) {
  const ms = Number.isFinite(lastMs) ? lastMs : estimateMs(members);
  return Number.isFinite(ms) && ms < LIVE_MS;
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
