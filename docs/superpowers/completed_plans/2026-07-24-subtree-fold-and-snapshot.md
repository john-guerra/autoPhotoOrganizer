# Subtree fold + aggregate snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In group-by-folder, let a parent node fold/snapshot its whole subtree as one unit (plain click), or fan out to per-leaf snapshots (shift-click).

**Architecture:** Reuse the `folderPath` prefix predicate for a new "subtree" collapse/sample mode server-side; render an aggregate-state parent as one header client-side; remap the fold dispatch so plain = aggregate-subtree, shift = per-leaf.

**Tech Stack:** Node + better-sqlite3 (server), Svelte 4 + Vite (UI), vitest, Playwright.

Spec: `docs/superpowers/specs/2026-07-24-subtree-fold-and-snapshot-design.md`.

## Global Constraints

- **Versioning:** bump `package.json` patch in the same commit that closes a slice; update `CHANGELOG.md` (newest first, one user-facing line, issue #142). Final packaged build is a separate minor bump — not part of this plan.
- **ESM, no TypeScript** (JSDoc types), **prettier** formatting, **vitest** colocated `*.test.js`.
- **Feed-window rule (CLAUDE.md):** any change to the feed window goes through `withFeedTransaction` (replace) or `loadMore` (extend) — never a 7th hand-rolled guard. Subtree fold is a _replace_ (it re-requests the window), so it rides `loadInitialFeed`/the existing fold path, exactly as `cycleGroupState` does.
- **Verify feed-window/ordering changes LIVE** against the exact scenario before claiming done — a passing suite + screenshot is not sufficient here (CLAUDE.md debugging discipline; memory `live-verify-ui-beyond-review`).
- **Every new/changed shortcut or gesture** that users must discover belongs in help; shift-to-fan-out is a mouse gesture — document it in `ShortcutsOverlay.svelte`'s mouse/gesture group if one exists, else note it in the group header tooltip.
- Isolate destructive/index tests with a temp `AUTOGALLERY_HOME` (memory `isolate-destructive-index-tests`); never touch real `~/.autogallery` or real photo folders.

## Data model: how a subtree fold is represented

A collapsed/snapshot path is today `Array<{dimension, value}>`. Extend the LAST segment with an optional `subtree: true` flag for the folder dimension:

```js
// exact leaf group (today):        [{ dimension: "folder", value: "/L/Cards/Cam 1" }]
// aggregate subtree (new, #142):   [{ dimension: "folder", value: "/L/Cards", subtree: true }]
```

`subtree` rides the same `collapsedPaths` array and `snapshotGroupKeys` set the feed already ships, so client state stays two sets, not three. The parent's `pathKey` (JSON of the path incl. `subtree:true`) is its identity everywhere.

---

### Task 1: Server — folder subtree predicate helper

**Files:**

- Modify: `server/db/feed.js` (add `folderSubtreeCondition`, near `collapsedPathCondition`)
- Test: `server/db/feed.test.js`

**Interfaces:**

- Produces: `folderSubtreeCondition(absPath) -> { sql: string, params: any[] }` — the POSITIVE "this row is under (or is) `absPath`" predicate, matching `filters.js`'s escaping exactly.

- [ ] **Step 1: Write the failing test**

```js
// server/db/feed.test.js — new describe near the collapse tests
import { folderSubtreeCondition } from "./feed.js";

describe("folderSubtreeCondition (#142)", () => {
  it("matches the folder itself and any descendant, escaping LIKE metachars", () => {
    const { sql, params } = folderSubtreeCondition("/L/Cards");
    // exact OR prefix; prefix uses ESCAPE so a literal % / _ can't wildcard
    expect(sql).toMatch(/folders\.abs_path = \?/);
    expect(sql).toMatch(/LIKE \? ESCAPE/);
    expect(params).toEqual(["/L/Cards", "/L/Cards/%"]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run server/db/feed.test.js -t folderSubtreeCondition` → FAIL (`folderSubtreeCondition is not a function`).

- [ ] **Step 3: Implement** (mirror `server/db/filters.js:74-92` exactly so the two notions of "under this folder" can't drift)

```js
/** POSITIVE predicate: a row whose folder IS `absPath` or is nested under it.
 * Mirrors server/db/filters.js's folderPath branch verbatim so subtree collapse,
 * subtree sample, and the folderPath filter all mean the same set of rows. */
export function folderSubtreeCondition(absPath) {
  const escaped = absPath.replace(/([\\%_])/g, "\\$1");
  return {
    sql: "(folders.abs_path = ? OR folders.abs_path LIKE ? ESCAPE '\\\\')",
    params: [absPath, escaped + "/%"],
  };
}
```

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** — `git add server/db/feed.js server/db/feed.test.js && git commit -m "feat(feed): folder-subtree predicate for #142 (mirrors filters.js)"`

---

### Task 2: Server — count and exclude a subtree-collapsed path

**Files:**

- Modify: `server/db/feed.js` — `collapsedPathCondition`, `exclusionClause`, `countCollapsedPaths` to honor a `subtree` segment on the folder dimension.
- Test: `server/db/feed.test.js`

**Interfaces:**

- Consumes: `folderSubtreeCondition` (Task 1).
- Produces: the feed query already excludes collapsed groups and emits placeholders with counts; after this task a `{dimension:"folder", value, subtree:true}` path (a) contributes ONE placeholder whose count is the subtree total, and (b) removes every descendant row from the feed.

- [ ] **Step 1: Write the failing test** (use the existing `upsertScan` fixture pattern; scan `/p/Cards/Cam 1` + `/p/Cards/Cam 10`, group by folder)

```js
it("a subtree-collapsed folder yields ONE placeholder with the whole-subtree count and hides descendants (#142)", () => {
  const db = getDb();
  seedVolume(db, 1);
  upsertScan(db, "/p/Cards/Cam 1", 1, [
    { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    { name: "b.jpg", size: 1, mtimeMs: 2, kind: "image" },
  ]);
  upsertScan(db, "/p/Cards/Cam 10", 1, [
    { name: "c.jpg", size: 1, mtimeMs: 3, kind: "image" },
  ]);
  const { items } = queryFeed(db, {
    groupBy: ["folder"],
    collapsed: [[{ dimension: "folder", value: "/p/Cards", subtree: true }]],
    after: 100,
  });
  const placeholders = items.filter((i) => i.collapsed);
  const reals = items.filter((i) => !i.collapsed && i.kind);
  expect(placeholders).toHaveLength(1);
  expect(placeholders[0].count).toBe(3); // 2 + 1 across the subtree
  expect(reals).toHaveLength(0); // no descendant photos leak in
});
```

(Confirm the exact `queryFeed` export name and options shape from the top of `feed.test.js` before writing — match the existing collapse tests in that file.)

- [ ] **Step 2: Run it, verify it fails** (descendants currently leak; no subtree handling).

- [ ] **Step 3: Implement** — three touch-points, each guarding on `seg.subtree`:
  - `collapsedPathCondition(path, dims)`: if the (single, last) folder segment has `subtree`, return `folderSubtreeCondition(value)` instead of `expr = ?`.
  - `exclusionClause(collapsedPaths, dims)`: split paths into exact vs subtree. Exact ones keep the tuple `NOT IN (VALUES …)` optimization untouched. Each subtree path adds one `AND NOT <folderSubtreeCondition(value).sql>` term (there are only ever a handful of subtree folds, so the expression-tree-depth concern that motivated the tuple form does not apply — leave a comment saying so).
  - `countCollapsedPaths(db, paths, dims, filter)`: route subtree paths to a per-path `SELECT COUNT(*) … WHERE stale=0 AND (filter) AND <folderSubtreeCondition>`; keep exact paths on the existing grouped-by-shape query.

- [ ] **Step 4: Run it, verify it passes**, plus the whole `feed.test.js` (`npx vitest run server/db/feed.test.js`) — the exact-collapse path must stay green (no regression to the tuple optimization).
- [ ] **Step 5: Commit** — `git commit -m "feat(feed): collapse a folder subtree as one placeholder (#142)"`

---

### Task 3: Server — placeholder ordering for a subtree path

**Files:**

- Modify: `server/db/feed.js` — `selectPlaceholders`/`spliceInPlaceholders`/`keyPassesSeek` use `path.map(p=>p.value)` as the key; confirm a length-1 folder key for `/p/Cards` seeks/splices at the parent's pre-order position (before its children). `itemDepth` already returns `path.length` for placeholders, so a subtree placeholder is depth 1 — verify no comparison reads past it.
- Test: `server/db/feed.test.js`

**Interfaces:**

- Consumes: Task 2.
- Produces: a subtree placeholder lands in correct feed order relative to sibling folders and to a focus/seek.

- [ ] **Step 1: Write the failing test** — two sibling subtrees + a loose top-level folder; collapse one subtree; assert the placeholder sits in pre-order between the right siblings, and that a `focusId`/`before` page still orders it correctly.

```js
it("orders a subtree placeholder at its parent's pre-order position (#142)", () => {
  const db = getDb();
  seedVolume(db, 1);
  upsertScan(db, "/p/AAA/x", 1, [
    { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
  ]);
  upsertScan(db, "/p/Cards/Cam 1", 1, [
    { name: "b.jpg", size: 1, mtimeMs: 2, kind: "image" },
  ]);
  upsertScan(db, "/p/ZZZ/y", 1, [
    { name: "c.jpg", size: 1, mtimeMs: 3, kind: "image" },
  ]);
  const { items } = queryFeed(db, {
    groupBy: ["folder"],
    after: 100,
    collapsed: [[{ dimension: "folder", value: "/p/Cards", subtree: true }]],
  });
  const order = items.map((i) =>
    i.collapsed ? "PH:" + i.path[0].value : i.groupValues.folder
  );
  // AAA's photo, then the Cards placeholder, then ZZZ's photo (pre-order by path)
  expect(order.indexOf("PH:/p/Cards")).toBeGreaterThan(
    order.indexOf("/p/AAA/x")
  );
  expect(order.indexOf("PH:/p/Cards")).toBeLessThan(order.indexOf("/p/ZZZ/y"));
});
```

- [ ] **Step 2: Run it, verify it fails or — if it already passes — KEEP it as a regression guard and note in the commit that ordering worked out of the box.** (This is genuinely uncertain; the test decides.)
- [ ] **Step 3: If failing**, fix `sortKeyOf(folderDim, "/p/Cards")` to sort in pre-order before descendants (the folder dim already sorts by a pre-order `sort_path` key — the placeholder's value must map through the same `sortExpr`). Add a JS `sortKey` twin if the parent path isn't already handled.
- [ ] **Step 4: Run `npx vitest run server/db/feed.test.js server/db/queryPlan.test.js`** — all green (queryPlan guards the generated date expr indexes; folder isn't a date dim, but run it since we touched sort mapping).
- [ ] **Step 5: Commit** — `git commit -m "feat(feed): subtree placeholder orders in pre-order (#142)"`

---

### Task 4: Server — subtree mode for the snapshot sample endpoint

**Files:**

- Modify: `server/api.js` — `GET /api/group/sample` accepts `subtree=1`.
- Modify: `server/db/feed.js` — `countGroupPath` / `fetchGroupRowsAtOffsets` accept a subtree flag (prefix predicate) OR add thin `countSubtree`/`fetchSubtreeRowsAtOffsets` wrappers that swap the WHERE for `folderSubtreeCondition`.
- Test: `server/api.test.js` (endpoint), `server/db/feed.test.js` (sampling math over a subtree).

**Interfaces:**

- Consumes: Task 1.
- Produces: `GET /api/group/sample?groupBy=folder&subtree=1&path=[{"dimension":"folder","value":"/p/Cards"}]&slots=12` → `{ count, samples }` where `count` is the subtree total and `samples` are drawn across ALL descendants in feed sort order.

- [ ] **Step 1: Write the failing test** (api.test.js) — scan Cards/Cam 1 (3) + Cards/Cam 10 (3); request sample with `subtree=1&path=[folder:/…/Cards]&slots=4`; assert `count===6` and samples come from BOTH cameras.

- [ ] **Step 2: Run it, verify it fails** (endpoint ignores `subtree`, counts the exact — empty — `/Cards` group → 0).
- [ ] **Step 3: Implement** — in the endpoint, parse `subtree = req.query.subtree === "1"`; when set and the single-segment path is a folder, count/fetch via the subtree predicate. Reuse `sampleOffsets` unchanged.
- [ ] **Step 4: Run `npx vitest run server/api.test.js -t sample` and `server/db/feed.test.js`** — green.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): group/sample subtree mode for aggregate snapshot (#142)"`

---

### Task 5: Client — aggregate renderer state + folderSections single-header

**Files:**

- Modify: `ui/src/lib/folderSections.js` — when a parent path is in the aggregate set, emit ONE header (bar or strip) for it and SUPPRESS its child headers + their items.
- Modify: `ui/src/lib/feed.js` (if `pathKey`/renderer helpers live there) — add an `aggregate` renderer id alongside `grid`/`snapshot`/`collapsed`.
- Test: `ui/src/lib/folderSections.test.js`

**Interfaces:**

- Consumes: nothing server-side yet (pure transform test).
- Produces: `folderSections(headers, { collapsedKeys, snapshotKeys, aggregateKeys })` (extend the existing signature) returns a single header with `rendererId: "aggregate-snapshot" | "aggregate-collapsed"` for an aggregated parent and none of its descendants.

- [ ] **Step 1: Write the failing test** — headers for `Cards/Cam 1` + `Cards/Cam 10`; pass `aggregateKeys` containing `pathKey([{dimension:"folder",value:"/…/Cards",subtree:true}])`; assert exactly one emitted section for `/…/Cards` and none for the cameras.
- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement** in `emitChain`/the trie walk: if the node's subtree path is aggregated, emit its single header and `return` without descending. Keep the existing per-leaf path otherwise.
- [ ] **Step 4: Run `npx vitest run ui/src/lib/folderSections.test.js ui/src/lib/folderTree.test.js`** — green.
- [ ] **Step 5: Commit** — `git commit -m "feat(feed-ui): render an aggregated parent as one section (#142)"`

---

### Task 6: Client — SnapshotStrip fetches the aggregate sample

**Files:**

- Modify: `ui/src/lib/SnapshotStrip.svelte` — when the strip's path is a subtree, call `/api/group/sample?subtree=1`.
- Modify: `ui/src/lib/api.js` — `groupSample(path, { subtree })` passes the param.
- Test: `ui/src/lib/*` unit test for the api helper; strip behavior covered by e2e in Task 8.

**Interfaces:**

- Consumes: Task 4 (endpoint), Task 5 (renderer id).
- Produces: an aggregate parent strip shows frames sampled across the subtree.

- [ ] **Step 1: Write the failing test** for `groupSample` building the URL with `subtree=1` when asked.
- [ ] **Step 2–4:** implement + green.
- [ ] **Step 5: Commit** — `git commit -m "feat(feed-ui): aggregate snapshot strip fetches subtree sample (#142)"`

---

### Task 7: Client — fold dispatch remap (feed header + tree)

**Files:**

- Modify: `ui/src/App.svelte` — `onGroupToggle` / `cycleGroupState` / `cycleLeafPaths`; add `cycleSubtreeAggregate(path)` (expanded → aggregate-snapshot → aggregate-collapsed → expanded) that writes the aggregate set and a `subtree:true` collapsed path, then reloads via the existing fold flow (NOT a new guard). Plain-click a parent → aggregate; shift-click a parent → existing per-leaf `cycleLeafPaths`.
- Modify: `ui/src/lib/TreeNode.svelte` / the tree `cycleView` handler in `App.svelte` (~line 2867) — same plain-vs-shift split for a parent row; mirror the aggregate state in the tree icon.
- Test: `ui/src/lib/*` unit test for the pure "next renderer" decision if extracted; dispatch covered by e2e (Task 8).

**Interfaces:**

- Consumes: Tasks 2–6.
- Produces: plain-vs-shift behavior per the spec; a leaf ignores shift (no-op, per resolved Q3).

- [ ] **Step 1:** extract the decision `foldTargetFor(path, { isParent, shiftKey }) -> "aggregate" | "perLeaf" | "leaf"` as a pure function and unit-test it (parent+plain→aggregate, parent+shift→perLeaf, leaf+either→leaf).
- [ ] **Step 2–4:** wire `onGroupToggle` and the tree `cycleView` to it; implement `cycleSubtreeAggregate`. Green on the pure test + `npm run build`.
- [ ] **Step 5: Commit** — `git commit -m "feat(feed-ui): plain-fold aggregates a parent, shift fans out to leaves (#142)"`

---

### Task 8: e2e + live verification + version/changelog

**Files:**

- Create: `e2e/subtree-fold.spec.js`
- Modify: `package.json` (version), `CHANGELOG.md`, `ui/src/lib/ShortcutsOverlay.svelte` (document shift-to-fan-out gesture)

- [ ] **Step 1: e2e** using the fixture's `Cards/Cam 1` + `Cards/Cam 10` (see `e2e/fixture.mjs`), with `trackPageErrors(page)`:
  - group by folder; plain-click the `Cards` fold icon → assert ONE snapshot strip and the two camera grids are gone; click again → ONE collapsed bar whose count == subtree total; click again → back to expanded.
  - shift-click `Cards` → assert TWO per-leaf strips (one per camera).
  - Selectors go in `e2e/helpers.js`.
- [ ] **Step 2: Run `npx playwright test e2e/subtree-fold.spec.js`** — green. Then revert Task 7's dispatch and confirm it goes RED (the "never-failed test proves nothing" rule), then restore.
- [ ] **Step 3: LIVE verify** in the real app (throwaway server + temp `AUTOGALLERY_HOME`, nested fixture): plain-fold a parent → one aggregate strip sampling across subfolders, then one bar; shift-fold → per-leaf strips; scroll away and back (virtualized feed) to confirm no ordering/duplicate-key breakage. This is mandatory for feed-window changes.
- [ ] **Step 4: Full suite** — `npm test` green; `npm run build` clean.
- [ ] **Step 5: Version + changelog + commit** — bump patch; CHANGELOG line: "**Fold a whole folder as one (#142).** Clicking a parent folder's fold icon now snapshots or collapses its entire subtree as one strip/bar; Shift-click shows each subfolder's own snapshot." Commit.

---

## Self-review notes

- **Spec coverage:** server subtree sample (Task 4) + subtree collapse (Tasks 1–3) = spec §1; client single-header render (Task 5) + strip fetch (Task 6) = spec §2; dispatch remap (Task 7) = spec §3; testing (Task 8) = spec Testing. Resolved decisions Q1–Q3 are honored (sample in current sort; a real parent's own loose photos are inside its subtree predicate; leaf ignores shift).
- **Risk / uncertainty flagged inline:** Task 3 (placeholder ordering) may already work or may need a sort-key twin — the test decides; do NOT assume. All feed-window behavior gets a LIVE check (Task 8 Step 3).
- **No new feed-window guard** is introduced; subtree fold reuses the existing replace/`loadInitialFeed` fold flow.
