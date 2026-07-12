# Group photo renderers — design contract

**Status:** contract agreed; registry landed, migration in progress (issue #100).
**Applies to:** how a group's PHOTOS are drawn in the feed.

## The idea

> "This should be a widget that I just give a group of photos and parameters, and
> it renders them." — snapshot is only the first such widget.

A group's **label** and its **photos** are two different concerns:

- The **header** is universal. Every group always renders exactly **one**
  `.section-header`: its label, its state icon, its count, its actions
  (select-all / keep-only / remove / jump). It owns the depth indentation and the
  dendrogram connectors.
- The **renderer** is pluggable. It only fills the **band beneath** the header.
  Grid, snapshot strip, and "collapsed" (an empty band) are just three entries in
  a registry. Contact sheet, map, best-of, histogram, timeline strip — all future
  entries.

**A renderer never draws a label, a count, an icon, or an action.** If a widget
needs one of those, it belongs in the header, not the widget.

## Why (the debt this replaces)

Before this, a group was drawn **three different ways, each re-implementing the
label**:

| state     | markup                             | label                  |
| --------- | ---------------------------------- | ---------------------- |
| expanded  | `.section-header`                  | label + icon + actions |
| snapshot  | `.snapshot-row` › `.snapshot-head` | a **second** label     |
| collapsed | `.placeholder-row` pill            | a **third** label      |

`suppressPlaceholderHeaders()` existed purely to _delete_ a group's real header
whenever it was collapsed, so the pill/strip could show its own. The consequences
were exactly what you'd predict:

- the snapshot **ignored the header's indentation** (it wasn't a header),
- the label was **duplicated** (`2025 / December / Canon 5` under `Canon 5`),
- the tri-state icon had to be **retrofitted into all three**,
- adding a fourth way meant touching **all of them**.

Presentation was also smeared across two parallel structures — `collapsedPaths`
("not a grid") and `snapshotGroupKeys` ("…specifically a strip") — so "which
widget draws this group" had no single home.

## The contract

### State: one renderer id per group

```js
// pathKey -> { path, rendererId }.  "grid" is the default and stores no entry.
groupRendererIds: Map<string, {path, rendererId}>
```

`collapsedPaths` (the **server** contract — which groups the feed folds into a
placeholder row) is **derived**, never hand-maintained:

```js
collapsedPaths = entries
  .filter((e) => isServerCollapsed(e.rendererId))
  .map((e) => e.path);
```

### The renderer descriptor

`ui/src/lib/groupRenderers.js`:

```js
/**
 * @typedef {object} GroupRenderer
 * @property {string} id
 * @property {string} label                 human name (tooltip / future menu)
 * @property {"grid"|"strip"|"bar"} icon    which GroupStateIcon the HEADER shows
 * @property {boolean} needsFeedPhotos
 *   true  → the group's photos stream into the feed; the justified grid draws
 *           them. The renderer reserves no band of its own.
 *   false → the group is collapsed SERVER-side (it becomes one placeholder row);
 *           the widget draws the band itself from its own sampled data.
 * @property {(ctx: {snapshotRowHeight: number}) => number} bandHeight
 *   px to reserve under the header. 0 = header only.
 * @property {import("svelte").ComponentType|null} component
 *   Rendered into the band with { group, rect, params }. null = empty band.
 */
```

### What a renderer component receives

```js
{
  group,   // { path, count, photos? }  photos only when needsFeedPhotos
  rect,    // { x, y, width, height } — the layout's CONTENT RECT for this group
  params,  // renderer-specific options (thumb size, sampling, …)
}
```

**`rect` is the contract's teeth.** A renderer is handed a rectangle and must
draw inside it. It must NOT assume `left: 0` / `width: 100%` — a nested group's
rect is inset by `depth * GROUP_INDENT` so its photos line up under its own
header (see `sectionedJustifiedLayout`'s `indentPerDepth`). The old snapshot row
hardcoded full width, which is exactly why it broke when nesting arrived.

### Height must be knowable _before_ render

The feed is virtualized: `sectionedJustifiedLayout` reserves each band **before**
anything mounts. So a renderer must answer `bandHeight(ctx)` up front. A widget
that can only know its height after measuring the DOM does not fit this contract —
give it a fixed or computable height.

### Server-side cost

`needsFeedPhotos: false` means the group is folded server-side into ONE
placeholder row. That's what makes a snapshot of a 10,000-photo folder cheap: the
feed never streams those photos. Such a widget fetches its own **sample** (see
`SnapshotStrip` → `/api/group/sample`). Prefer this for any widget that shows a
summary rather than every photo.

## Adding a renderer

1. Write `ui/src/lib/renderers/MyWidget.svelte` taking `{ group, rect, params }`.
   Draw inside `rect`. No label, no count, no actions.
2. Add one entry to `GROUP_RENDERERS` in `ui/src/lib/groupRenderers.js`.
3. If it needs a new icon, add a variant to `GroupStateIcon.svelte` and reference
   it via `icon`.

That's all. The header, the cycle, the tree sidebar, Shift+fold-the-leaves, the
layout and the indentation all pick it up for free — because they only ever talk
to the registry.

## Invariants (do not break)

1. **One header per group, always** — even when it isn't grid-rendered. There is
   no such thing as a group without its label. (`suppressPlaceholderHeaders` is
   gone; do not reintroduce it.)
2. **Renderers draw photos, never chrome.**
3. **Renderers respect `rect`** — never assume full width.
4. **`bandHeight` is knowable before mount.**
5. **`collapsedPaths` is derived from `needsFeedPhotos`**, never hand-set.
6. The cycle order is just the registry array order.
