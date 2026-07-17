# Tree keyboard navigation — design (2026-07-17)

## Goal

Make the Library tree keyboard-navigable like VS Code's file explorer: focus it,
arrow through the _visible_ rows, expand/collapse with ←/→, Home/End, PageUp/Down,
type-ahead to a folder, and **Enter/Space jumps the feed** to the cursor's folder.

## Model

- **Focus.** The tree's scroll region (`.tree-scroll`) becomes a single tab stop:
  `role="tree"`, `tabindex="0"`, a visible focus ring. Focus it by clicking the
  tree, Tab, or the global **`T`** shortcut (free key; rebindable later). While the
  tree holds focus the feed's global shortcuts stand down.
- **Cursor.** A keyboard cursor (`treeCursorKey`, a treeKey) marks one row, shown
  with a distinct class (NOT the Follow "here" eye/dot, NOT the reveal highlight).
  Exposed to AT via `aria-activedescendant={cursorRowDomId}` on the container;
  each row is `role="treeitem"` with a stable `id` and `aria-selected`. The cursor
  moves the tree only — the feed does not change until Enter/Space.
- **Visible rows.** Navigation walks a FLAT, ordered list of the rows currently on
  screen (respecting expand state + folder-tree compaction). This is pure and
  goes in a helper with unit tests: `flattenVisibleRows(rootNodes, expandedKeys)`
  → `[{ key, path, depth, hasChildren, expanded, jumpPath, label }]`, in render
  order. Cursor up/down/home/end/pageup-down index into it; ←/→ read
  hasChildren/expanded to decide expand vs move-to-child/parent.

## Keys (handled on the container; each consumed via preventDefault)

- ↑ / ↓ — previous / next visible row (clamp at ends)
- → — collapsed folder: expand it; expanded: move to first child; leaf: no-op
- ← — expanded folder: collapse it; else move to parent row
- Home / End — first / last visible row
- PageUp / PageDown — move by floor(viewportHeight / rowHeight) rows, clamped
- Enter / Space — `onjump(cursorRow.jumpPath)` (same jump the click uses; honours
  the trailing-slash `groupValue` fix and the folded-target handling)
- **Type-ahead** — printable keys append to a buffer that resets ~800 ms after the
  last keystroke (the standard type-ahead buffer, not a "settle" hack); the cursor
  moves to the next visible row whose label starts with the buffer, case-insensitive,
  cycling from the current cursor so repeats step through matches. Space is Enter,
  not type-ahead (matches VS Code).

Moving the cursor scrolls it into view (`block: "nearest"`) inside `.tree-scroll`.

## Coexistence with the feed

The feed's shortcuts live on `<svelte:window onkeydown={onKeydown}>`. Two guards:

- The tree's own keydown handler `preventDefault` + `stopPropagation` for keys it
  handles, so they never reach the window handler.
- `onKeydown` bails at the top when focus is inside the tree
  (`e.target.closest(".tree-sidebar")`), so no feed shortcut (rating, grid arrows)
  fires while the tree is focused — even for keys the tree ignores.

The `T` focus shortcut is added to `onKeydown` (only when NOT already typing / in
the tree), and focuses `.tree-scroll`.

## Components touched

- `ui/src/lib/treeKeyboard.js` (new) + test — pure `flattenVisibleRows` and the
  cursor-movement helpers (next/prev/home/end/page/left/right/type-ahead target).
- `ui/src/lib/TreeSidebar.svelte` — container role/tabindex/aria-activedescendant,
  keydown handler, `treeCursorKey` state, cursor scroll-into-view; passes the
  cursor down.
- `ui/src/lib/TreeNode.svelte` — `role="treeitem"`, stable `id`, `aria-selected`,
  the cursor highlight class.
- `ui/src/App.svelte` — `T` focus shortcut + the "focus in tree → bail" guard in
  `onKeydown`; expose a `focusTree()` the shortcut calls (bind the container).
- `ui/src/lib/ShortcutsOverlay.svelte` — a new "Library tree (when focused)" group.

## Testing

- vitest: `flattenVisibleRows` + movement helpers (order, compaction, expand/collapse
  target resolution, type-ahead match/cycle, page/home/end clamping).
- e2e (`sidebarHere.spec.js` or a new `treeKeyboard.spec.js`): focus the tree with
  `T`, arrow down, →/← expand-collapse, Enter jumps the feed to the cursor folder,
  type-ahead moves the cursor; `trackPageErrors`. Revert-check the Enter-jump.

## Conventions

Patch bump + CHANGELOG entry. Every new shortcut documented in ShortcutsOverlay in
the same commit (the `T` focus key + the in-tree keys).
