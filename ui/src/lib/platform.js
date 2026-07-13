/**
 * How to NAME the platform's modifier key in the UI.
 *
 * One source of truth, because the same shortcut gets described in three places
 * (the ? overlay, the status line, a button tooltip) and a Windows user should
 * never be told to press ⌘. Writing "⌘ / Ctrl" was the other way out, but the
 * overlay renders each token as its own key pill, so the slash read as a third
 * key to press.
 *
 * Naming only — the handler itself accepts `metaKey || ctrlKey` on every
 * platform, and that stays true regardless of what we call it here.
 */
const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

/** "⌘" on a Mac, "Ctrl" everywhere else. */
export const MOD = isMac ? "⌘" : "Ctrl";

/**
 * A whole combo, written the way that platform writes it: "⌘A" / "Ctrl+A",
 * "⌘⇧A" / "Ctrl+Shift+A".
 * @param {string} key
 * @param {{shift?: boolean}} [opts]
 */
export function combo(key, { shift = false } = {}) {
  return isMac
    ? `⌘${shift ? "⇧" : ""}${key}`
    : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}
