/**
 * Let go of a video element's network connection (#305).
 *
 * ## Removing the element is NOT enough, and that was the bug
 *
 * The loupe's `{#key item.id}` block tears the `<video>` down on every
 * navigation, and its comment claimed that stopped playback. It stops the
 * PICTURE. The media loader keeps streaming: a detached element goes on
 * holding its connection until it is garbage collected, which may be many
 * seconds later, or not at all while any reference survives.
 *
 * Chrome allows **six connections per origin**, and `/api/image/:id` answers
 * an open-ended `bytes=N-` by streaming the whole rest of the file — so a
 * PLAYING video holds its connection continuously, unlike a metadata-only load
 * that finishes in milliseconds. Arrow through ten clips and the abandoned
 * loaders fill the pool. Then:
 *
 * - the clip you are actually on cannot get a connection, so it sits at a
 *   black frame on 0:00 (`readyState` 0, `networkState` 2 — asking, never
 *   served);
 * - `/api/health` cannot be SENT, times out at 4 s, and the app announces
 *   "Lost the connection to the AutoGallery server" — about a server that is
 *   answering everyone else in 1 ms.
 *
 * Measured against a real folder of 400 MB screen recordings: ten playing
 * videos take `/api/health` from **1 ms to a 4 s timeout**, and calling this
 * brings it back to **2 ms** in the same run.
 *
 * ## All three steps are load-bearing
 *
 * `removeAttribute("src")` is the change the spec's media-load algorithm
 * looks for, and `load()` is what actually RUNS that algorithm and aborts the
 * in-flight fetch. **Those two are what free the connection**; drop either and
 * it stays open — which is why "it is removed from the DOM, surely that is
 * enough" was wrong for two releases.
 *
 * `pause()` is a nicety on top: it stops the decoder, which is CPU nobody
 * asked for on a clip nobody is looking at. It gets its own `try` precisely
 * because it is NOT load-bearing — an earlier version wrapped all three
 * together, so a throwing `pause()` would have skipped the two that matter.
 *
 * Setting `src = ""` instead of removing the attribute is the classic
 * near-miss: it resolves against the document URL, so the element goes off and
 * requests the PAGE, which is a new request rather than no request.
 *
 * @param {HTMLVideoElement|null|undefined} el
 * @returns {boolean} whether it released something, for tests and callers that
 *   want to know they were handed a real element.
 */
export function releaseVideo(el) {
  if (!el || typeof el.load !== "function") return false;
  try {
    // Its OWN try. `pause()` is the one call here that is not load-bearing —
    // it stops the decoder, where `removeAttribute` + `load()` are what abort
    // the fetch. Letting it take the other two down with it would put #305
    // back for that clip, which is exactly the wrong trade for a nicety.
    el.pause();
  } catch {
    /* already detached far enough that pausing is meaningless */
  }
  try {
    el.removeAttribute("src");
    el.load();
    return true;
  } catch {
    // Teardown must never throw: this runs while Svelte is destroying the
    // block, and an exception here leaves the loupe half-torn-down.
    return false;
  }
}
