/**
 * Who owns the keyboard right now?
 *
 * This app is keyboard-first: the grid holds roving focus, and a bare `3` rates
 * the focused photo. That is exactly what makes a text field dangerous — while
 * the user is typing into one, every keystroke must belong to the field and
 * nothing else, and the app must never take focus back out from under them.
 *
 * Both halves of that rule need the same question answered ("is a text field
 * focused?"), which is why it lives here instead of being spelled out a third
 * time inline:
 *
 *  - the global key handler ignores shortcuts when the event came from a field;
 *  - focusTile refuses to move focus to a tile when a field has it — the feed
 *    reloads on every search keystroke, and the post-reload refocus used to yank
 *    the caret out of the search box mid-word (so the REST of what you typed hit
 *    the grid, where digits rate photos).
 *
 * @param {EventTarget | Element | null | undefined} el
 * @returns {boolean}
 */
export function isTypingTarget(el) {
  if (!el || typeof el !== "object") return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}
