import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { cacheRoot } from "../lib/cachePaths.js";
import { DEFAULT_MODEL_ID, modelById } from "./models.js";

function settingsFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "ml.json");
}

/**
 * Half the cores, floor 1.
 *
 * A separate process is NOT a separate CPU. Left uncapped, ORT takes every core
 * and starves the 16-slot libvips pool server/index.js:19 reserves for
 * thumbnails — measured at 15ms -> 90ms with tiles abandoned mid-scroll. Half
 * leaves the grid responsive while still finishing a large backfill unattended.
 * @returns {number}
 */
export function defaultThreads() {
  return Math.max(1, Math.floor(cpus().length / 2));
}

/**
 * A `writeMlSettings` failure that happened AFTER validation passed — the
 * write to disk itself failed (ENOSPC, EACCES, a read-only cache root under
 * a locked-down profile). Distinguished from a validation failure (bad
 * modelId) so the route can answer 500 ("we couldn't save it") instead of
 * 400 ("you gave us something invalid") — see #161 fix round 1, Minor 4.
 */
export class MlSettingsPersistError extends Error {}

/**
 * How far apart two photos may be taken and still be proposed as the same
 * shot (#162). Twenty times DEFAULT_BURST_GAP_MS (3000) — far enough to reach
 * a re-framed retake the plain time gap would split, nowhere near far enough
 * to reach a different part of the afternoon.
 *
 * The window is what keeps the similarity threshold honest: two unrelated
 * photographs that merely share a genre score 0.61-0.68 (see models.js), so
 * similarity ALONE, applied across a whole library of one genre, would merge
 * distinct shots. Neither signal is sufficient by itself.
 */
export const DEFAULT_NEAR_DUPE_WINDOW_MS = 60_000;

/**
 * @returns {{modelId: string, threads: number, enabled: boolean,
 *   nearDupeThreshold: number|null, nearDupeWindowMs: number}}
 *
 * `enabled` gates whether ANY embedding ever runs — see writeMlSettings and
 *   api.js's kickEmbedSweep. Defaults to false: models are downloaded, never
 *   bundled (the spec's own words), so nothing may fetch one until the user
 *   has opted in from the settings panel and seen what it costs.
 *
 * `nearDupeThreshold` is `null` by default, and null MEANS "use the active
 *   model's own value" rather than standing for some hidden number. That
 *   matters because the two models disagree by ~0.05 on the case that decides
 *   most groupings (models.js): storing a resolved number instead would
 *   silently carry SigLIP's 0.93 over to CLIP the moment the user switched
 *   models, and 0.93 under CLIP misses every re-framed duplicate. Resolve it
 *   with `effectiveThreshold` at the point of use, never at the point of save.
 */
export function readMlSettings() {
  const defaults = {
    modelId: DEFAULT_MODEL_ID,
    threads: defaultThreads(),
    enabled: false,
    nearDupeThreshold: null,
    nearDupeWindowMs: DEFAULT_NEAR_DUPE_WINDOW_MS,
  };
  const file = settingsFile();
  if (!existsSync(file)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    // Validate on READ as well as write: a hand-edited or partially-written
    // file must not take ML down, and must never name a model we never
    // vetted or silently flip a boolean-shaped field to something truthy.
    const modelId = modelIsKnown(raw.modelId) ? raw.modelId : defaults.modelId;
    const enabled =
      typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled;
    return {
      modelId,
      threads: clampThreads(raw.threads ?? defaults.threads),
      enabled,
      nearDupeThreshold: clampThreshold(raw.nearDupeThreshold),
      nearDupeWindowMs: clampWindow(
        raw.nearDupeWindowMs ?? defaults.nearDupeWindowMs
      ),
    };
  } catch {
    return defaults;
  }
}

/**
 * The threshold actually used for a grouping: the user's override when they
 * set one, else the active model's measured default.
 * @param {{modelId: string, nearDupeThreshold: number|null}} settings
 * @returns {number}
 */
export function effectiveThreshold(settings) {
  return (
    settings.nearDupeThreshold ?? modelById(settings.modelId).nearDupeThreshold
  );
}

/**
 * @param {{modelId?: string, threads?: number, enabled?: boolean}} patch
 * @throws {Error} a plain Error for a validation failure (bad modelId) —
 *   the route maps this to 400. Validated FIRST, and outside the try/catch
 *   below, so it can never be reclassified as a persistence failure.
 * @throws {MlSettingsPersistError} for anything that goes wrong AFTER
 *   validation passes — the route maps this to 500. This deliberately
 *   covers `readMlSettings()` (called below to get `current`) as well as
 *   the `writeFileSync` itself: both call `settingsFile()`, and its
 *   unguarded `mkdirSync(cacheRoot(), {recursive: true})` is exactly as
 *   likely to be the thing that throws on EACCES/EROFS as the write is
 *   (#161 fix round 2, Important) — `readMlSettings()`'s OWN try/catch only
 *   covers a corrupt/malformed ml.json, not a cache root it can't even
 *   mkdir into.
 */
export function writeMlSettings(patch) {
  // Validate BEFORE the try/catch below, and using `patch` directly (not
  // `current`, not yet read) — a bad modelId must stay a plain Error no
  // matter what shape the persistence code below takes.
  if (patch.modelId !== undefined) {
    modelById(patch.modelId); // throws "unknown model: …" — do not persist it
  }
  try {
    const current = readMlSettings();
    const next = { ...current };
    if (patch.modelId !== undefined) next.modelId = patch.modelId;
    if (patch.threads !== undefined) next.threads = clampThreads(patch.threads);
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    // Stored as given (or null), never resolved against the current model —
    // see readMlSettings' doc for why resolving here would break a model
    // switch. `null` is a meaningful value the user can set, so it is
    // distinguished from "not in the patch" by the `!== undefined` guard.
    if (patch.nearDupeThreshold !== undefined)
      next.nearDupeThreshold = clampThreshold(patch.nearDupeThreshold);
    if (patch.nearDupeWindowMs !== undefined)
      next.nearDupeWindowMs = clampWindow(patch.nearDupeWindowMs);
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
    return next;
  } catch (err) {
    throw new MlSettingsPersistError(
      `could not save ML settings: ${err.message}`
    );
  }
}

/**
 * `null` (use the model default) survives; anything else is coerced into a
 * usable cosine cutoff. The floor is 0.5, not 0: below the shared-genre band
 * (0.61-0.68, models.js) every photo in a time window matches every other, so
 * a slider dragged to zero would not "group more aggressively" — it would
 * collapse whole minutes of a shoot into one stack. A hand-edited ml.json
 * gets the same protection.
 */
function clampThreshold(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(0.999, Math.max(0.5, n));
}

/** Floor at the burst gap itself (below it the signal adds nothing the time
 *  gap has not already caught), ceiling at an hour. */
function clampWindow(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_NEAR_DUPE_WINDOW_MS;
  return Math.min(3_600_000, Math.max(3_000, n));
}

function clampThreads(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return defaultThreads();
  return Math.min(cpus().length, Math.max(1, v));
}

function modelIsKnown(id) {
  try {
    modelById(id);
    return true;
  } catch {
    return false;
  }
}
