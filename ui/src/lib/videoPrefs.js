/**
 * Remembered playback audio settings for the loupe's <video>.
 *
 * The element was hardcoded `muted`, so EVERY video started silent and every
 * video had to be un-muted by hand — the setting you just chose was thrown away
 * the moment you moved to the next clip. Volume is a property of the person
 * watching, not of the file: it belongs in a preference, like zoom.
 *
 * Muted defaults to true only for the very first video of a fresh install, which
 * is also what keeps autoplay working before the browser trusts us (see Loupe).
 */

export const VIDEO_PREFS_KEY = "autogallery.videoAudio";

const DEFAULTS = { muted: true, volume: 1 };

/** Volume outside [0,1] throws on assignment to a <video>, so a corrupt or
 *  hand-edited value must never reach the element. */
function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.volume;
  return Math.min(1, Math.max(0, n));
}

/**
 * @param {Storage} [storage]
 * @returns {{muted: boolean, volume: number}} always a usable pair — a missing,
 *   malformed or partial entry falls back to the defaults rather than throwing
 *   inside a component's setup (which would take the whole loupe down).
 */
export function loadVideoPrefs(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(VIDEO_PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw);
    return {
      muted: typeof saved?.muted === "boolean" ? saved.muted : DEFAULTS.muted,
      volume: clampVolume(saved?.volume ?? DEFAULTS.volume),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** @param {{muted: boolean, volume: number}} prefs */
export function saveVideoPrefs(prefs, storage = globalThis.localStorage) {
  try {
    storage?.setItem(
      VIDEO_PREFS_KEY,
      JSON.stringify({
        muted: !!prefs?.muted,
        volume: clampVolume(prefs?.volume),
      })
    );
  } catch {
    // A full or disabled localStorage must not break playback — the user just
    // loses the memory of the setting, not the video.
  }
}
