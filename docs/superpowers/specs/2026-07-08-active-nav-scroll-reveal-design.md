# Active-navigation scroll reveal

**Date:** 2026-07-08
**Status:** implemented — see amendment below; the geometry module (`scroll.js`)
this spec proposed was superseded during implementation.
**Related:** GitHub issue #40 (selected-thumbnail scroll-hijacking on every reflow)

## Implementation amendment (native scrollIntoView)

The shipped implementation replaced the hand-rolled geometry (`revealScrollTop`
in `scroll.js`, plus content-vs-client coordinate math) with the **native DOM
`element.scrollIntoView({ block })` API** plus a CSS `scroll-margin-top` on the
tile (`--reveal-margin`, set on the scroll container = one sticky-header band per
grouping level + a `PAD` of breathing room). This clears the sticky header
without any manual margin math, and `block: "nearest"` gives the "minimal scroll,
no-op when already visible" behaviour the spec wanted for keyboard nav for free.
`scroll.js` was deleted.

The spec's "one re-reveal after `enrichMeta` settles" (§ Group-jump) proved
insufficient on its own: a _single_ one-shot re-reveal fires at one frame and
can land on a bad one (rapid jumps ended up scrolled far past the target). The
shipped version instead **re-asserts on every reflow while a jump's metadata is
still loading** (`jumpRevealPending` gates a `$: boxes` reactive), which is
self-correcting — rapid jumps converge. Crucially the release is an **event**
(the jump window's metadata finished loading, or the user took over via
keypress/`wheel`), never a timer — matching the "no timeouts" constraint. This
is the continuous-anchor idea from the earlier scroll-anchoring attempt, but
gated to the post-jump window so it never fights ordinary browsing scroll.

## Problem

The grid force-scrolls the selected tile back to center on _every_ layout
reflow, so the user can never scroll away from their selection: any background
metadata reflow or scroll-triggered load yanks the view back. The offending
code is a reactive block in `Thumb.svelte`:

```js
$: if (selected && el) {
  void box.x; // makes this re-fire on every reflow that moves the tile
  void box.y;
  el.scrollIntoView({ block: "center" });
}
```

The `void box.x/box.y` reads exist so a metadata-driven reflow re-centers the
tile after it shifts — but justified-layout positions change constantly as
thumbnail dimensions stream in, so the block re-fires continuously and hijacks
the user's scroll. It also always centers, overriding wherever the user was.

Two additional problems with the current design:

1. A **child tile imperatively scrolls the whole page**, reaching past its own
   responsibility into the App-owned scroll container (the layering smell
   issue #40 names).
2. Firing on _any_ `selected` change means the block also scrolls when
   `loadMore`/jump **re-anchor** `selected` to the same photo at a shifted
   index — a programmatic change the user never made — producing spurious
   "why did it just move" scrolls.

## Desired behavior (confirmed with user)

Revealing the selection is an **active-navigation action**, never a reactive
side-effect of layout:

- **Arrow keys / Home / End / Enter-into-stack:** if the newly-selected tile is
  off-screen, scroll the **minimum** needed to bring it fully into view (offset
  below the sticky-header stack). If it's already fully visible, do nothing —
  in-viewport arrowing never jumps the page. Never re-center.
- **Group-jump (Option+Left/Right):** the landing photo **must** end up visible
  — this is critical, because a jump lands somewhere the user can't see yet.
- **Passive reflow** (streaming metadata, scroll-triggered loads), `loadMore`'s
  silent selected re-anchor, and **the user's own manual scrolling**: never move
  the scroll position. The selection is free to sit off-screen.

## Design (Option B — reveal owned by App, geometry-based)

### `ui/src/lib/scroll.js` (new, pure + tested)

```js
/**
 * The scrollTop that brings a box minimally into a viewport, or null if it's
 * already fully visible. Pure geometry — no DOM. `margin` reserves space at
 * the top for the sticky-header stack so a revealed tile isn't hidden under it.
 * @param {{top:number, height:number}} box   position within the scroll content
 * @param {number} viewTop    current scrollTop
 * @param {number} viewHeight  visible height (clientHeight)
 * @param {number} margin      top inset to keep clear (sticky headers)
 * @returns {number|null}
 */
export function revealScrollTop(box, viewTop, viewHeight, margin) {
  const top = box.top - margin; // where the tile's top sits, header-adjusted
  const bottom = box.top + box.height;
  if (top < viewTop) return top; // above the fold → scroll up to it
  if (bottom > viewTop + viewHeight) return bottom - viewHeight; // below → scroll down just enough
  return null; // already fully visible → no-op
}
```

Unit tests: above-fold, below-fold, already-visible (→ null), a box taller than
the viewport (prefer showing its top), and margin handling.

### `ui/src/App.svelte`

- **`revealSelected()`** — resolves `boxes[selected]`, computes its position
  within the scroll content (`gridEl` offset + `box.y`), calls
  `revealScrollTop(...)` with `margin ≈ HEADER_HEIGHT * (open header depth)`, and
  if non-null does `mainColumnEl.scrollTo({ top, behavior: "smooth" })`. Uses box
  **geometry**, so it works even when the target tile isn't mounted yet (the
  full layout has a box for every entry). No-op if geometry isn't ready.
- **Call sites — only active navigation:** after `selected` is set in the
  Arrow/Home/End/Enter branches of `onKeydown`, and (see below) the group-jump.
  It is **not** called from `loadMore`'s re-anchor, `onGroupByChange`, initial
  load, or any reactive/reflow path.
- **Group-jump:** keep the existing `scrollToSection` landing. Add **one**
  re-reveal after the jump's freshly-loaded metadata settles
  (`enrichMeta(...).then(reveal)`, guarded by `feedEpoch` so a superseded jump
  doesn't scroll) — a jump loads new photos whose metadata reflows the layout a
  beat after landing, which can drift the landing photo out of view; this
  one-shot guarantees it stays visible. Scoped to the jump only, not global.

### `ui/src/lib/Thumb.svelte`

- Remove the reactive `scrollIntoView` block entirely (lines ~135–144). Thumb no
  longer scrolls anything; it only renders. The `el` binding stays only if still
  needed for the resize observer.

## What does NOT change

- `scrollToSection` (used by jump + header-click) stays as-is.
- Virtualization / `buildVisibleItems` still mounts `selected` so the target
  tile renders once revealed; it just no longer needs the element for scrolling.
- Keyboard navigation logic (`navVertical`, `nextSelectable`) is untouched.

## Testing

- **Unit:** `scroll.test.js` for `revealScrollTop` (the geometry).
- **Live (required — App.svelte scroll behavior, per project convention):**
  1. Scroll away from the selection while metadata is still streaming → view
     stays put, selection sits off-screen. (The core bug.)
  2. Arrow past the visible edge → view follows minimally; arrow within view →
     no scroll.
  3. Option+Right into a new group → landing photo visible, and still visible
     after its metadata finishes loading; then scroll freely beyond it.
  4. Rapid `loadMore` (scroll near an edge) → no scroll snap-back.

```

```
