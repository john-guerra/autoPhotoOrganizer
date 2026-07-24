# Group-by-folder: fold and snapshot a parent as one subtree (#142)

**Status:** approved — implementing
**Issue:** #142 — "When group by folder, I cannot show the snapshot of a subfolder."

## Problem

When grouping by folder, the feed shows **leaf** folder groups nested under
client-invented ancestor headers (`folderSections.js`). Today the fold icon on a
group cycles that one group (`cycleGroupState`) — grid → snapshot → collapsed —
and only a leaf that carries its own photos can be folded. A **parent** folder
(a real folder with children, or a virtual ancestor like `Cards` with no photos
of its own) cannot be folded or snapshotted as a single unit:

- Plain-clicking a real parent folds only its _own_ photos; its subfolders stay
  full grids.
- A virtual ancestor has no group of its own, so plain-click already fans out to
  its leaves (`cycleLeafPaths`) rather than collapsing the subtree as one.
- There is **no** "one snapshot strip for the whole subtree" anywhere — snapshot
  is strictly per-leaf-group. That is the literal "cannot show the snapshot of a
  subfolder."

## Desired behaviour (confirmed with the user)

Standard tree / VS-Code region-folding semantics, on a **parent** node's fold
control (in both the feed header and the tree sidebar):

| Gesture         | Result                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plain click** | Cycle the **whole subtree as one unit**: expanded → **one aggregate snapshot strip** (sampled across every photo under the subtree) → **one aggregate collapsed bar** (subtree total count) → expanded. |
| **Shift-click** | VS-Code region-fold: keep the parent expanded, render **each leaf** under it as its own snapshot strip.                                                                                                 |

Leaf folders (no children) keep today's behaviour exactly. Only parents change.

Non-goals: no change to any grouping other than `folder`; no change to selection,
rating, or export; the aggregate strip is read-only sampling, it moves no files.

## Approach

Two capabilities are missing — one server, one client — plus a fold-dispatch
remap. Each is small on its own; the design keeps them isolated.

### 1. Server — sample and count a folder SUBTREE (not just an exact group)

The `folderPath` filter (`server/db/filters.js`) already matches a whole subtree
by `abs_path` prefix (`abs_path = ? OR abs_path LIKE ?/%`). Two existing
read paths need a "this path is a subtree root, match by prefix" mode:

- **`GET /api/group/sample`** (`server/api.js`): today it samples one exact group
  identified by `path`. Add an optional `subtree=1` (or a distinct `folderPath`
  param) so the count + `sampleOffsets` run over the prefix set instead of the
  exact-group set. This yields the aggregate strip's frames. No new sampling
  math — `sampleOffsets`/`fetchGroupRowsAtOffsets` are reused; only the WHERE
  changes from exact-group to prefix.
- **Feed collapse** (`server/db/feed.js`): a collapsed _subtree_ must exclude
  every photo under the prefix and emit **one** placeholder with the subtree
  total. `collapsedPathCondition`/`exclusionClause` pin a group by exact value
  today; add a subtree variant keyed by prefix. The placeholder's identity is
  the parent's `abs_path`.

Both reuse the exact prefix predicate `filters.js` already ships, so there is one
notion of "under this folder", not a new one that can drift (cf. the feed-vs-SQL
identity note at the top of `feed.js`).

### 2. Client — render a parent subtree as one bar / one strip

`folderSections.js` turns flat leaf headers into the nested hierarchy. Add a
parent-level renderer state so that when a parent path is in
`aggregateSnapshot`/`aggregateCollapsed`, the module emits a **single** header
for the parent (bar or strip) and **suppresses** the child headers and their
items beneath it. The parent's snapshot strip is fed by the subtree `sample`
endpoint above; the collapsed bar shows the subtree total.

State lives beside the existing `collapsedPaths` + `snapshotGroupKeys` in
`App.svelte`, as a parallel set keyed by the parent's `pathKey`. `rendererIdFor`
and the tree's `TreeNode` mirror it (the tree already reads these sets).

### 3. Fold dispatch remap (`App.svelte` `onGroupToggle` and the tree)

- **Leaf**, plain or shift → `cycleGroupState` (unchanged).
- **Parent, plain click** → new `cycleSubtreeAggregate(path)`: expanded →
  aggregate-snapshot → aggregate-collapsed → expanded, over the whole subtree.
- **Parent, shift-click** → existing per-leaf `cycleGroupLeaves`/`cycleLeafPaths`
  (already collects leaves; re-point it so its snapshot state is per-leaf strips
  — this is largely today's virtual-ancestor plain-click behaviour, moved onto
  shift).

The tree sidebar's `cycleView` (`TreeNode` → App) gets the same split: a parent
row's plain click aggregates, shift fans out to leaves.

## Data flow

```
parent fold icon (feed header OR tree row)
  → onGroupToggle(path, event)         [App.svelte]
    → plain  → cycleSubtreeAggregate(path)
                 sets aggregate{Snapshot|Collapsed}Keys[pathKey]
                 → loadInitialFeed()  (collapse sends subtree paths to server)
    → shift  → cycleLeafPaths(leaves)  (per-leaf snapshot, existing machinery)

feed render:
  folderSections(headers, collapsedPaths, snapshotKeys, aggregateKeys)
    → parent in aggregate state ? emit ONE bar/strip, drop child headers+items
    → else nest as today
  SnapshotStrip for an aggregate parent → GET /api/group/sample?subtree=1&path=<parent>
```

## Testing

- **vitest (server):** `group/sample` subtree mode returns frames sampled across
  descendants; feed collapse of a subtree emits one placeholder with the subtree
  total and excludes all descendant items. (`feed.test.js`, `api.test.js`.)
- **vitest (client):** `folderSections` emits a single header for an
  aggregate-state parent and suppresses its descendants; `rendererIdFor`/dispatch
  choose aggregate vs per-leaf by plain-vs-shift. (`folderSections.test.js`.)
- **e2e (Playwright):** group by folder on the nested fixture (`Cards/Cam 1`,
  `Cards/Cam 10`); plain-click `Cards` → one snapshot strip sampling both cameras,
  then one collapsed bar reading the subtree total; shift-click `Cards` → two
  per-leaf strips. Assert the item count hidden/shown, not internals. Revert the
  fix and confirm the spec's e2e goes red first.

## Resolved decisions (approved 2026-07-24)

1. **Aggregate snapshot ordering** — sample the subtree in the feed's current
   sort (date/name): a representative spread across the whole card. ✅
2. **Real parent with its OWN photos + children** (e.g. `Trip` has loose photos
   AND `Trip/Sub`): plain-click aggregates _everything under `Trip`, including
   its own loose photos_, into the one strip/bar. ✅
3. **Shift on a leaf** — no-op (identical to plain); a leaf has nothing to fan
   out. ✅
