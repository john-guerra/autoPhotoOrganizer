# Library dropdown: browse offline folders from cache — Design

Status: Approved, ready for implementation plan
Date: 2026-07-07

## Context & problem

GitHub issue #8 ("Multi-folder / recent-folders switching") asks for a way
to keep several folders bookmarked and flip between them quickly, since
John's real archive is split across multiple external drives, not all
mounted at once. Investigating the current codebase, this need turns out
to be mostly already met: the "Library ▾" dropdown (`ui/src/App.svelte`)
already lists every previously-scanned folder and lets you click to switch,
and the persistent SQLite index (`docs/superpowers/specs/2026-07-06-persistent-multi-drive-index-design.md`,
already implemented) means switching between folders is already fast
(incremental rescan, unchanged files skipped) — no new "recent folders"
feature is needed.

The one real gap: `selectFromLibrary` (`App.svelte:471-475`) currently
does nothing for an offline (unmounted) folder — the button is simply
`disabled={!entry.mounted}`. But `docs/TEST_FOLDERS.local.md`'s own
architecture invariant (CLAUDE.md: "with the external drive unmounted,
previews/metadata/ratings still browse from cache... with an 'offline'
badge") already promises offline browsing works — and it does, just not
through this dropdown. The tree sidebar's `jumpToPath` (`App.svelte:267-299`)
queries the SQLite index directly via `fetchFeed`'s `startPath` seeking,
with no volume-mount check anywhere in that path (`server/db/tree.js`,
`server/db/feed.js`) — so browsing an offline folder's cached content
already works today via the tree sidebar. The Library dropdown just
doesn't offer the same shortcut.

## Goal

When clicking an offline folder entry in the "Library ▾" dropdown, browse
its cached content read-only (same mechanism the tree sidebar already
uses for any folder) instead of doing nothing. A mounted folder's entry
keeps its current behavior unchanged (live incremental rescan via
`doScan()`).

## Implementation

`selectFromLibrary(entry)` (`ui/src/App.svelte:471-475`) currently:

```js
function selectFromLibrary(entry) {
  if (!entry.mounted) return;
  dir = entry.path;
  libraryOpen = false;
  doScan();
}
```

Changes to:

```js
function selectFromLibrary(entry) {
  libraryOpen = false;
  if (!entry.mounted) {
    jumpToPath([{ dimension: "folder", value: entry.path }]);
    return;
  }
  dir = entry.path;
  doScan();
}
```

`jumpToPath` already exists and is exactly the function the tree sidebar
calls on a folder-node click (`TreeNode.svelte:49` → `dispatch("jump", path)`
→ `TreeSidebar.svelte:86` → `App.svelte`'s `on:jump={(e) => jumpToPath(e.detail)}`)
— a single-entry path array `[{dimension:"folder", value: <abs_path>}]`
is exactly the shape a top-level folder tree node already produces, so no
new server-side work or new client function is needed; this reuses the
existing, already-tested seek path verbatim.

The template's `disabled={!entry.mounted}` (`App.svelte:973`) is removed so
offline entries become clickable; the `class:offline` styling and the
"offline" `<span>` badge (`App.svelte:972,976`) stay exactly as they are —
still the visual signal that this folder's content is being browsed from
cache, not live.

## Testing

No automated test — this is a client-only Svelte change reusing an
already-tested server-side code path (`jumpToPath`/`startPath` seeking are
covered by existing tests in `server/db/feed.test.js`); manual verification
only, matching this project's established convention for Svelte components.

## Out of scope

- Any new "recent folders" list, ordering, or persistence beyond what
  `GET /api/library` already provides.
- Any change to `doScan()`'s mounted-folder rescan behavior.
- Any change to the tree sidebar itself — this only extends the Library
  dropdown to use the same existing mechanism.

## Validation

After implementation: unmount (or point at a since-removed) test folder's
volume, confirm its Library dropdown entry now shows the "offline" badge
AND is clickable (not grayed out/disabled), click it, and confirm the feed
jumps to that folder's photos showing cached thumbnails/metadata with no
scan/error — matching exactly what already happens when reaching the same
folder via the tree sidebar today.
