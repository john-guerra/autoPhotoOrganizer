# Tree "Follow here" — design (2026-07-17)

## Problem

As you scroll the feed, the tree's "you are here" eye marker (the group at the
top of the feed viewport — the VIEW anchor) moves, but the tree does not scroll
to keep it visible. When the marker moves into a collapsed branch it isn't shown
at all. The user wants an opt-in mode that keeps the eye marker revealed and in
view in the tree while they scroll.

## Behaviour

A checkbox in the tree's action row (beside **Expand all / Collapse all**),
labelled with the eye icon + "Follow" (title: "Keep the feed's location in view
in the tree"). **Off by default**, persisted to `localStorage` like the other
sidebar prefs.

When ON, the tree continuously reveals the feed's VIEW anchor:

- Whenever the VIEW anchor group changes (i.e. as the feed scrolls), App reveals
  it in the tree by calling the existing `TreeSidebar.revealPath(viewHerePath)`.
- `revealPath` already walks the path from the root, **auto-expanding** whatever
  branches are needed, and highlights the node. (Auto-expand was the chosen
  behaviour: the exact node is always shown, even inside a collapsed branch.)
- `revealPath` gains a final `scrollIntoView({ block: "nearest" })` on the
  revealed node so the tree actually scrolls to it. `nearest` scrolls **only when
  the marker is off-screen**, so there is no jitter while it is already visible.

When OFF: no change from today (the manual "reveal current location" button and
the static markers still work exactly as before).

## Anchor: VIEW, not FOCUS

The eye marker IS the VIEW anchor ("the group at the top of the feed viewport —
Eye", `App.svelte`). Follow tracks `viewHerePath`/`viewHereKey`, which already
update from `renderStart` as the feed scrolls. It never touches `selected` — so,
unlike the manual reveal button, follow-mode does not move focus.

## Scope

- Reuse `revealPath`; do NOT build a second reveal/expand engine.
- The follow `$effect` only reacts to the VIEW anchor moving, so browsing the tree
  while the feed is still does not fight the user. Scrolling the feed into a
  branch the user just collapsed will reopen it — inherent to auto-expand.
- Out of scope: following the FOCUS anchor during keyboard culling; pausing while
  the user drags the tree's own scrollbar.

## Components touched

- `ui/src/lib/TreeSidebar.svelte` — `revealPath` adds the `scrollIntoView`; the
  revealed row needs a `bind:this`/ref or a keyed query to scroll.
- `ui/src/App.svelte` — persisted `treeFollowHere` state; the checkbox in the tree
  action row (passed to `TreeSidebar` or rendered where the actions live); the
  `$effect` that calls `treeSidebarRef.revealPath(viewHerePath)` when
  `treeFollowHere && viewHereKey` changes.

## Testing

The VIEW-anchor → tree-reveal wiring is a DOM/scroll seam → e2e (`e2e/`), where
`sidebarHere.spec.js` already exercises the here markers. New spec: enable Follow,
scroll the feed, assert the tree highlights/reveals the new VIEW group (and that a
previously-collapsed ancestor is now expanded). `trackPageErrors` in the spec.
Revert-check it before committing.

## Conventions

Version patch bump + `CHANGELOG.md` entry in the same commit. No new keyboard
shortcut (so no ShortcutsOverlay change).
