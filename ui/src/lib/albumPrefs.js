// Global (not per-folder) Auto-Albums preferences, persisted in localStorage
// under one key. Pure `mergeAlbumPrefs` is unit-tested; the localStorage
// wrapper is thin and guarded so it's a no-op under SSR/tests.
const KEY = "autogallery.albumPrefs";

export const DEFAULT_ALBUM_PREFS = {
  template: "%Y/%Y_%m%b_%d", // e.g. 2017/2017_01Jan_09 (nested year folder)
  gapMode: "fixed", // "fixed" (a concrete gap) | "auto" (mean + k·stddev)
  fixedGapMs: 86400000, // 1 day
  k: 2, // stddev multiplier for auto mode
  move: true, // materialize default is MOVE
};

/** Defaults merged with a possibly-partial/garbage stored object, type-coerced. */
export function mergeAlbumPrefs(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  const gapMode = s.gapMode === "auto" ? "auto" : "fixed";
  const fixedGapMs = Number.isFinite(s.fixedGapMs)
    ? Math.max(1000, s.fixedGapMs)
    : DEFAULT_ALBUM_PREFS.fixedGapMs;
  const k = Number.isFinite(s.k) ? s.k : DEFAULT_ALBUM_PREFS.k;
  return {
    template:
      typeof s.template === "string" && s.template.length
        ? s.template
        : DEFAULT_ALBUM_PREFS.template,
    gapMode,
    fixedGapMs,
    k,
    move: typeof s.move === "boolean" ? s.move : DEFAULT_ALBUM_PREFS.move,
  };
}

function storage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadAlbumPrefs() {
  const st = storage();
  if (!st) return { ...DEFAULT_ALBUM_PREFS };
  try {
    return mergeAlbumPrefs(JSON.parse(st.getItem(KEY) || "null"));
  } catch {
    return { ...DEFAULT_ALBUM_PREFS };
  }
}

export function saveAlbumPrefs(patch) {
  const merged = mergeAlbumPrefs({ ...loadAlbumPrefs(), ...patch });
  const st = storage();
  if (st) {
    try {
      st.setItem(KEY, JSON.stringify(merged));
    } catch {
      /* ignore quota/denied */
    }
  }
  return merged;
}
