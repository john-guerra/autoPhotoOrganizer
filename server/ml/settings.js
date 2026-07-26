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
 * @returns {{modelId: string, threads: number, enabled: boolean}} `enabled`
 *   gates whether ANY embedding ever runs — see writeMlSettings and
 *   api.js's kickEmbedSweep. Defaults to false: models are downloaded, never
 *   bundled (the spec's own words), so nothing may fetch one until the user
 *   has opted in from the settings panel and seen what it costs.
 */
export function readMlSettings() {
  const defaults = {
    modelId: DEFAULT_MODEL_ID,
    threads: defaultThreads(),
    enabled: false,
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
    };
  } catch {
    return defaults;
  }
}

/**
 * @param {{modelId?: string, threads?: number, enabled?: boolean}} patch
 * @throws {Error} a plain Error for a validation failure (bad modelId) —
 *   the route maps this to 400.
 * @throws {MlSettingsPersistError} for a failure to persist a validated
 *   patch — the route maps this to 500.
 */
export function writeMlSettings(patch) {
  const current = readMlSettings();
  const next = { ...current };
  if (patch.modelId !== undefined) {
    modelById(patch.modelId); // throws "unknown model: …" — do not persist it
    next.modelId = patch.modelId;
  }
  if (patch.threads !== undefined) next.threads = clampThreads(patch.threads);
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  try {
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  } catch (err) {
    throw new MlSettingsPersistError(
      `could not save ML settings: ${err.message}`
    );
  }
  return next;
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
