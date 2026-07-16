/**
 * Tiny localStorage-backed settings persistence. Deliberately dumb: JSON in, JSON
 * out, swallow every storage error (private-mode / disabled storage must never
 * break the grid). Callers own reactivity — they read once at init via
 * {@link loadSetting} and write via {@link saveSetting} from a `$effect`.
 */

const PREFIX = "autogallery.";

/** Read a persisted setting, returning `fallback` if absent or unparsable. */
export function loadSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Persist a setting (JSON-serialized). Silently no-ops if storage is unavailable. */
export function saveSetting(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full / disabled — a lost preference is not worth a thrown error */
  }
}
