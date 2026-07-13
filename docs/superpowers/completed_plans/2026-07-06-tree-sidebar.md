# Tree Sidebar & In-Place Collapse Folding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, lazily-loaded tree sidebar that becomes the primary way to navigate and fold/unfold the grouping hierarchy, and rework collapsed sections to fold in place in the feed (a synthetic placeholder row spliced into the feed's own ordered results) instead of the current topbar-chip workaround.

**Architecture:** A new server endpoint (`GET /api/tree`) computes one hierarchy level's counts per lazy expand-click, reusing `server/db/feed.js`'s existing dimension machinery. `getFeedPage` gains two capabilities: splicing a lightweight `{collapsed:true, ...}` placeholder into `items` at its correct sort position for any currently-collapsed path that falls within the fetched page, and seeking to an arbitrary hierarchy path (not just a specific photo id) for tree-driven navigation. The client's existing pure pipeline (`displayEntries.js` → `sectionedJustified.js` → `App.svelte`'s render loop) gains a third entry kind, `"placeholder"`, threaded through with minimal changes — the placeholder participates in the SAME index-aligned `boxes` array photos do, just marked `.placeholder: true` instead of carrying `x`/`width`. A new `TreeSidebar.svelte` + `TreeNode.svelte` pair (recursive, lazy per-node fetch) renders the tree and owns its own local expand/collapse state, kept deliberately separate from the shared `collapsedPaths` state that controls what the feed excludes.

**Tech Stack:** Node.js + better-sqlite3 (server), Svelte + Vite (client), vitest.

## Global Constraints

- ESM everywhere (`"type": "module"`), no TypeScript — plain JS with JSDoc types.
- Tests: vitest, colocated as `*.test.js` next to sources (server tests under `server/`, client pure-logic tests under `ui/src/lib/`).
- No automated tests for Svelte components (`TreeSidebar.svelte`, `TreeNode.svelte`, `App.svelte` changes) — manual browser verification only, per this project's established convention (`docs/ROADMAP.md`'s working agreement). Any nontrivial logic inside a component must be extracted to a plain, tested function first.
- Comments: no "what" comments — only non-obvious "why" comments (hidden constraints, subtle invariants).
- Every file-serving endpoint routes through `server/lib/safeResolve.js` — not touched by this plan (no new file-path-taking endpoints).
- `collapsedPaths` (what the feed excludes) and the tree's own local expand/collapse state are two distinct pieces of state, never conflated — see the design doc's "Two distinct kinds of state" section.
- Neither the tree's expand state nor `collapsedPaths` persist across reloads (matches the existing decision for `collapsedPaths`, extended to the tree for the same reason).
- Read-only against real test data during manual validation (Task 10) — per `docs/TEST_FOLDERS.local.md`'s working agreement, never write/move/rename/delete inside those folders.

Full design: `docs/superpowers/specs/2026-07-06-tree-sidebar-design.md`.

---

### Task 1: Server — hierarchy-count query

**Files:**

- Create: `server/db/tree.js`
- Modify: `server/db/feed.js:27` (add `export` to `resolveDimensions` — needed by `tree.js`; no other change to this function)
- Test: `server/db/tree.test.js`

**Interfaces:**

- Consumes: `resolveDimensions(groupBy)` (now exported from `server/db/feed.js`) — returns `Array<{name, expr, direction}>`, throws `Error` on an unknown dimension name.
- Produces: `getTreeNode(db, {groupBy, path})` from `server/db/tree.js`, returning `{total: number, nodes: Array<{value, label, count, hasChildren}>}`. Later tasks (2) call this directly.

- [ ] **Step 1: Export `resolveDimensions` from `server/db/feed.js`**

Change line 27 of `server/db/feed.js` from:

```js
function resolveDimensions(groupBy) {
```

to:

```js
export function resolveDimensions(groupBy) {
```

No other change to this function.

- [ ] **Step 2: Write the failing tests**

Create `server/db/tree.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getTreeNode } from "./tree.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-db-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  _resetDbForTest();
});

afterEach(async () => {
  _resetDbForTest();
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

function seedVolume(db, id) {
  db.prepare(`INSERT INTO volumes (id, label) VALUES (?, ?)`).run(
    id,
    `vol${id}`
  );
}

function setTakenAt(db, id, isoOrNull) {
  db.prepare(`UPDATE photos SET taken_at = ? WHERE id = ?`).run(
    isoOrNull ? Date.parse(isoOrNull) : null,
    id
  );
}

describe("getTreeNode — root level", () => {
  it("returns the whole library's total and top-level nodes with counts", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "a2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { total, nodes } = getTreeNode(db, { groupBy: ["folder", "year"] });
    expect(total).toBe(3);
    expect(nodes).toEqual([
      {
        value: "/photos/a-folder",
        label: "/photos/a-folder",
        count: 2,
        hasChildren: true,
      },
      {
        value: "/photos/b-folder",
        label: "/photos/b-folder",
        count: 1,
        hasChildren: true,
      },
    ]);
  });

  it("marks hasChildren false at the deepest grouping level", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/only", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { nodes } = getTreeNode(db, { groupBy: ["folder"] });
    expect(nodes[0].hasChildren).toBe(false);
  });
});

describe("getTreeNode — nested path", () => {
  it("scopes counts to the given path prefix", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "old.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "new1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "new2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(
      db,
      rows.find((r) => r.name === "old.jpg").id,
      "2020-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "new1.jpg").id,
      "2024-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "new2.jpg").id,
      "2024-01-01T00:00:00.000Z"
    );
    const { nodes } = getTreeNode(db, {
      groupBy: ["folder", "year"],
      path: [{ dimension: "folder", value: "/photos/trip" }],
    });
    expect(nodes).toEqual([
      { value: "2024", label: "2024", count: 2, hasChildren: false },
      { value: "2020", label: "2020", count: 1, hasChildren: false },
    ]);
  });

  it("formats the empty-string date sentinel as Unknown", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "noexif.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { nodes } = getTreeNode(db, {
      groupBy: ["folder", "year"],
      path: [{ dimension: "folder", value: "/photos/trip" }],
    });
    expect(nodes).toEqual([
      { value: "", label: "Unknown", count: 1, hasChildren: false },
    ]);
  });

  it("throws when path is already at the deepest grouping level", () => {
    const db = getDb();
    seedVolume(db, 1);
    expect(() =>
      getTreeNode(db, {
        groupBy: ["folder"],
        path: [{ dimension: "folder", value: "/x" }],
      })
    ).toThrow(/deepest/);
  });

  it("throws when a path dimension doesn't match groupBy's order", () => {
    const db = getDb();
    seedVolume(db, 1);
    expect(() =>
      getTreeNode(db, {
        groupBy: ["folder", "year"],
        path: [{ dimension: "year", value: "2020" }],
      })
    ).toThrow(/dimension mismatch/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run server/db/tree.test.js`
Expected: FAIL — `Cannot find module './tree.js'` (file doesn't exist yet).

- [ ] **Step 4: Implement `server/db/tree.js`**

```js
import { resolveDimensions } from "./feed.js";

/**
 * One level of the grouping hierarchy tree: the distinct values (with
 * counts) of the dimension at depth `path.length` within `groupBy`, scoped
 * to whatever prefix `path` already fixes. Lazily computed per call — one
 * GROUP BY query per expand click, not a full-tree walk, so this stays
 * cheap regardless of library size.
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], path?: Array<{dimension:string, value:string}>}} opts
 * @returns {{total: number, nodes: Array<{value:string, label:string, count:number, hasChildren:boolean}>}}
 */
export function getTreeNode(db, { groupBy, path = [] }) {
  const dims = resolveDimensions(groupBy);
  if (path.length >= dims.length) {
    throw new Error("path is already at the deepest grouping level");
  }

  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM photos WHERE stale = 0`)
    .get().count;

  const prefixClauses = [];
  const prefixParams = [];
  path.forEach((p, i) => {
    const dim = dims[i];
    if (dim.name !== p.dimension) {
      throw new Error(
        `path dimension mismatch at depth ${i}: expected ${dim.name}, got ${p.dimension}`
      );
    }
    prefixClauses.push(`${dim.expr} = ?`);
    prefixParams.push(p.value);
  });

  const nextDim = dims[path.length];
  const whereSql = ["photos.stale = 0", ...prefixClauses].join(" AND ");
  const rows = db
    .prepare(
      `SELECT ${nextDim.expr} AS value, COUNT(*) AS count
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE ${whereSql}
       GROUP BY ${nextDim.expr}
       ORDER BY ${nextDim.expr} ${nextDim.direction}`
    )
    .all(...prefixParams);

  const hasChildren = path.length + 1 < dims.length;
  const nodes = rows.map((r) => ({
    value: r.value,
    label: formatTreeLabel(r.value),
    count: r.count,
    hasChildren,
  }));
  return { total, nodes };
}

/** Mirrors ui/src/lib/feed.js's formatGroupValue: the empty-string date
 * sentinel (see feed.js's DIMENSIONS doc comment) displays as "Unknown".
 * Kept in sync manually — there is no shared module between server and
 * client to import this from. */
function formatTreeLabel(value) {
  return value === "" ? "Unknown" : value;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run server/db/tree.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full server test suite to confirm no regressions**

Run: `npx vitest run server/`
Expected: All existing tests still pass (exporting `resolveDimensions` doesn't change its behavior).

- [ ] **Step 7: Commit**

```bash
git add server/db/tree.js server/db/tree.test.js server/db/feed.js
git commit -m "feat: add getTreeNode, a lazy per-level hierarchy-count query"
```

---

### Task 2: Server — `GET /api/tree` endpoint

**Files:**

- Modify: `server/api.js`
- Test: `server/api.test.js`

**Interfaces:**

- Consumes: `getTreeNode(db, {groupBy, path})` from Task 1; `DIMENSIONS` (already exported from `server/db/feed.js`).
- Produces: `GET /api/tree?groupBy=<comma-list>&path=<json>` → `{total, nodes}`. Consumed by Task 7's `fetchTreeNode` client wrapper.

- [ ] **Step 1: Write the failing tests**

Add to `server/api.test.js`, after the existing `describe("GET /api/feed", ...)` block (find it by searching for `describe("GET /api/feed"` in the file):

```js
describe("GET /api/tree", () => {
  beforeEach(async () => {
    const db = getDb();
    db.prepare("DELETE FROM photos").run();
    db.prepare("DELETE FROM folders").run();
  });

  it("returns the library total and root-level nodes", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/tree?groupBy=folder,year`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.nodes[0]).toHaveProperty("value");
    expect(body.nodes[0]).toHaveProperty("count");
    expect(body.nodes[0].hasChildren).toBe(true);
  });

  it("scopes to a given path prefix", async () => {
    await scan(srv.base, photosDir);
    const path = encodeURIComponent(
      JSON.stringify([{ dimension: "folder", value: photosDir }])
    );
    const res = await fetch(
      `${srv.base}/api/tree?groupBy=folder,year&path=${path}`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.nodes[0].hasChildren).toBe(false);
  });

  it("400s on an unknown groupBy dimension", async () => {
    const res = await fetch(`${srv.base}/api/tree?groupBy=bogus`);
    expect(res.status).toBe(400);
  });

  it("400s when groupBy is missing", async () => {
    const res = await fetch(`${srv.base}/api/tree`);
    expect(res.status).toBe(400);
  });

  it("400s on malformed path JSON", async () => {
    const res = await fetch(
      `${srv.base}/api/tree?groupBy=folder&path=not-json`
    );
    expect(res.status).toBe(400);
  });

  it("400s when path is already at the deepest grouping level", async () => {
    await scan(srv.base, photosDir);
    const path = encodeURIComponent(
      JSON.stringify([{ dimension: "folder", value: photosDir }])
    );
    const res = await fetch(`${srv.base}/api/tree?groupBy=folder&path=${path}`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/api.test.js -t "GET /api/tree"`
Expected: FAIL — all requests 404 (route doesn't exist yet).

- [ ] **Step 3: Implement the route**

In `server/api.js`, change the import on line 20 from:

```js
import { getFeedPage, DIMENSIONS } from "./db/feed.js";
```

to:

```js
import { getFeedPage, DIMENSIONS } from "./db/feed.js";
import { getTreeNode } from "./db/tree.js";
```

Add this route in `registerApi`, immediately after the existing `GET /api/feed` route (right before the closing `}` of `registerApi`, i.e. before line 291's closing brace):

```js
// --- Hierarchy tree (lazy, per-level) --------------------------------------
app.get("/api/tree", (req, res) => {
  const groupBy = String(req.query.groupBy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!groupBy.length) {
    return res.status(400).json({ error: "groupBy is required" });
  }
  if (groupBy.some((d) => !DIMENSIONS[d])) {
    return res.status(400).json({
      error: `unknown dimension in groupBy: ${groupBy.join(",")}`,
    });
  }

  let path = [];
  if (req.query.path) {
    try {
      path = JSON.parse(String(req.query.path));
    } catch {
      return res.status(400).json({ error: "path must be JSON" });
    }
  }

  const db = getDb();
  try {
    const { total, nodes } = getTreeNode(db, { groupBy, path });
    res.json({ total, nodes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/api.test.js -t "GET /api/tree"`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full server test suite to confirm no regressions**

Run: `npx vitest run server/`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/api.js server/api.test.js
git commit -m "feat: add GET /api/tree endpoint"
```

---

### Task 3: Server — in-place collapsed placeholder + arbitrary-path seeking

**Files:**

- Modify: `server/db/feed.js`
- Modify: `server/api.js`
- Test: `server/db/feed.test.js`
- Test: `server/api.test.js`

**Interfaces:**

- Consumes: nothing new from earlier tasks.
- Produces: `getFeedPage(db, {groupBy, collapsed, focusId, startPath, before, after})` — same signature as before, PLUS a new optional `startPath` (`Array<{dimension,value}>`, mutually exclusive with `focusId` in practice though not enforced — if both are given, `focusId` takes precedence since it's resolved first). Returns `{items, focusItem}` — **`sections` is removed** from the return value; a currently-collapsed path that falls within the fetched window now appears as an entry in `items` shaped `{collapsed: true, id, path, count, groupValues}` instead. Real (non-collapsed) items are unchanged in shape. Task 4/5/6 consume this new `items` shape on the client. Task 9 updates `GET /api/feed`'s callers to stop reading `sections` and to pass `startPath` for tree-driven jumps.

**Why the placeholder needs its own splicing pass:** the real-row query already excludes collapsed rows (unchanged, cheap — no real rows for a collapsed range are ever fetched). This task adds a _second_, small pass that decides, per collapsed path, whether its block falls inside what THIS specific page actually covers (using the same per-dimension ASC/DESC comparator already used for keyset seeking), and if so, builds a one-row synthetic placeholder and splices it into the correct position among the real rows. A collapsed path outside the current window costs nothing (no query at all beyond a cheap comparison against already-fetched boundary values) until scrolled near.

**Why `startPath` is needed:** jumping to a tree node has no specific photo id to seek from (the target section may never have been loaded) — `startPath` seeks to the first row whose hierarchy prefix matches (or sorts after) the given path, independent of any particular row's id.

- [ ] **Step 1: Write the failing tests**

In `server/db/feed.test.js`, **replace** the entire `describe("getFeedPage — collapsed section summaries", ...)` block (currently lines 122–155) with:

```js
describe("getFeedPage — in-place collapsed placeholder", () => {
  it("splices a placeholder in place of a fully-collapsed leading section", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "a2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/a-folder" }]],
      after: 10,
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      collapsed: true,
      id: "collapsed:folder=/photos/a-folder",
      path: [{ dimension: "folder", value: "/photos/a-folder" }],
      count: 2,
      groupValues: { folder: "/photos/a-folder" },
    });
    expect(items[1].name).toBe("b1.jpg");
  });

  it("splices a placeholder BETWEEN two real sections, in the right order", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/c-folder", 1, [
      { name: "c1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/b-folder" }]],
      after: 10,
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual([
      "a1.jpg",
      "collapsed:folder=/photos/b-folder",
      "c1.jpg",
    ]);
  });

  it("splices multiple placeholders within one page, each in the right position", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/c-folder", 1, [
      { name: "c1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [
        [{ dimension: "folder", value: "/photos/a-folder" }],
        [{ dimension: "folder", value: "/photos/c-folder" }],
      ],
      after: 10,
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual([
      "collapsed:folder=/photos/a-folder",
      "b1.jpg",
      "collapsed:folder=/photos/c-folder",
    ]);
  });

  it("does not splice a placeholder for a collapsed path outside the requested window", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(
      db,
      rows.find((r) => r.name === "a.jpg").id,
      "2022-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "b.jpg").id,
      "2021-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rows.find((r) => r.name === "c.jpg").id,
      "2020-01-01T00:00:00.000Z"
    );
    // Fetch only 2020 (year DESC, so "after" from the c.jpg focus is empty
    // in this fixture — instead fetch just after b.jpg, limit 1, so only
    // c.jpg's year is in range and 2022's collapse (unrelated, "before"
    // everything fetched) must not appear).
    const focus = rows.find((r) => r.name === "b.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["year"],
      collapsed: [[{ dimension: "year", value: "2022" }]],
      focusId: focus.id,
      after: 1,
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual(["c.jpg"]);
  });

  it("splices a placeholder at the true start of the feed with no focusId", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/a-folder" }]],
      after: 10,
    });
    expect(items[0].collapsed).toBe(true);
  });

  it("splices a placeholder at the true end of the feed (fewer real rows than the limit)", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/b-folder" }]],
      after: 10, // limit far exceeds the 1 real row left after a1.jpg
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual([
      "a1.jpg",
      "collapsed:folder=/photos/b-folder",
    ]);
  });

  it("orders two placeholders of DIFFERENT collapse depths correctly in one page", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const rowsB = upsertScan(db, "/photos/b-folder", 1, [
      { name: "b2020.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b2019.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(
      db,
      rowsB.find((r) => r.name === "b2020.jpg").id,
      "2020-01-01T00:00:00.000Z"
    );
    setTakenAt(
      db,
      rowsB.find((r) => r.name === "b2019.jpg").id,
      "2019-01-01T00:00:00.000Z"
    );
    // a-folder is collapsed entirely (depth 1); only b-folder's 2020 is
    // collapsed (depth 2) — the two placeholders share no common prefix
    // value, so this exercises comparing across different depths without
    // reading past either one's own known dimensions.
    const { items } = getFeedPage(db, {
      groupBy: ["folder", "year"],
      collapsed: [
        [{ dimension: "folder", value: "/photos/a-folder" }],
        [
          { dimension: "folder", value: "/photos/b-folder" },
          { dimension: "year", value: "2020" },
        ],
      ],
      after: 10,
    });
    expect(items.map((i) => i.name ?? i.id)).toEqual([
      "collapsed:folder=/photos/a-folder",
      "collapsed:folder=/photos/b-folder>year=2020",
      "b2019.jpg",
    ]);
  });
});

describe("getFeedPage — startPath (jump to an arbitrary hierarchy path)", () => {
  it("seeks to the first row at or after the given path, without a focusId", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/c-folder", 1, [
      { name: "c1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      startPath: [{ dimension: "folder", value: "/photos/b-folder" }],
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["b1.jpg", "c1.jpg"]);
  });

  it("is inclusive of the exact path prefix (not strictly-after)", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/only", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      startPath: [{ dimension: "folder", value: "/photos/only" }],
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["a.jpg"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/db/feed.test.js`
Expected: FAIL — the "collapsed section summaries" describe block no longer matches current behavior (still returns a separate `sections` field, doesn't splice), and the new `startPath` tests fail since `getFeedPage` doesn't recognize that option yet (it will just ignore it and return every row, since `focusId` is null and no seek condition applies).

- [ ] **Step 3: Implement the changes in `server/db/feed.js`**

Remove the entire `getCollapsedSummaries` function (currently lines 74–93) and replace it, along with the rest of the file from `cmpOp` onward (currently lines 95–230), with:

```js
/** @param {string} direction @param {boolean} wantAfter @returns {">"|"<"} */
function cmpOp(direction, wantAfter) {
  if (direction === "ASC") return wantAfter ? ">" : "<";
  return wantAfter ? "<" : ">";
}

/**
 * Standard multi-column keyset "seek" condition: rows strictly after (or
 * before) the focus tuple in the composite sort order.
 * `(d0 op d0v) OR (d0=d0v AND d1 op d1v) OR (d0=d0v AND d1=d1v AND ...)`.
 * @param {Array<{expr:string, direction:string}>} seekDims includes the
 *   trailing `photos.id` tiebreaker as its own entry.
 * @param {any[]} focusValues one value per seekDim, in order.
 * @param {boolean} wantAfter
 * @returns {{sql:string, params:any[]}}
 */
function seekCondition(seekDims, focusValues, wantAfter) {
  const clauses = [];
  const params = [];
  for (let i = 0; i < seekDims.length; i++) {
    const parts = [];
    for (let j = 0; j < i; j++) {
      parts.push(`${seekDims[j].expr} = ?`);
      params.push(focusValues[j]);
    }
    const op = cmpOp(seekDims[i].direction, wantAfter);
    parts.push(`${seekDims[i].expr} ${op} ?`);
    params.push(focusValues[i]);
    clauses.push(`(${parts.join(" AND ")})`);
  }
  return { sql: clauses.join(" OR "), params };
}

/**
 * Like seekCondition, but seeks to an arbitrary hierarchy PATH's position
 * rather than a specific row — used for "jump to this tree node," which has
 * no focusId to anchor on since the target section may never have been
 * loaded. Inclusive of the path's own exact prefix match (seekCondition
 * seeks strictly past a given row; this seeks AT-OR-after a path).
 * @param {Array<{expr:string, direction:string}>} dims
 * @param {Array<{dimension:string, value:string}>} path a prefix of dims
 * @returns {{sql:string, params:any[]}}
 */
function startPathCondition(dims, path) {
  const clauses = [];
  const params = [];
  path.forEach(({ value }, i) => {
    const parts = [];
    for (let j = 0; j < i; j++) {
      parts.push(`${dims[j].expr} = ?`);
      params.push(path[j].value);
    }
    const op = cmpOp(dims[i].direction, true);
    const inclusiveOp = op === ">" ? ">=" : "<=";
    parts.push(`${dims[i].expr} ${inclusiveOp} ?`);
    params.push(value);
    clauses.push(`(${parts.join(" AND ")})`);
  });
  return { sql: clauses.join(" OR "), params };
}

/**
 * @param {{id:number, name:string, size:number, mtimeMs:number, rating:number, preferredCover:number, width:number|null, height:number|null, taken_at:number|null}} r
 * @param {Array<{name:string}>} dims
 */
function rowToItem(r, dims) {
  const groupValues = {};
  dims.forEach((d, i) => (groupValues[d.name] = r[`dim${i}`]));
  return {
    id: r.id,
    name: r.name,
    size: r.size,
    mtimeMs: r.mtimeMs,
    rating: r.rating,
    preferredCover: r.preferredCover === 1,
    width: r.width,
    height: r.height,
    takenAt: r.taken_at ? new Date(r.taken_at).toISOString() : null,
    groupValues,
  };
}

/** @param {Array<{dimension:string,value:string}>} path @returns {string} */
function placeholderId(path) {
  return "collapsed:" + path.map((p) => `${p.dimension}=${p.value}`).join(">");
}

/** @param {Array<{dimension:string,value:string}>} path @returns {Record<string,string>} */
function pathGroupValues(path) {
  const groupValues = {};
  for (const { dimension, value } of path) groupValues[dimension] = value;
  return groupValues;
}

/** Per-dimension comparison of two key tuples of the SAME length, honoring
 * each dimension's own sort direction. @returns {-1|0|1} */
function compareKeyTuples(a, b, dims) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const lt = dims[i].direction === "ASC" ? a[i] < b[i] : a[i] > b[i];
    return lt ? -1 : 1;
  }
  return 0;
}

/** True if `key` (a collapsed path's own tuple, possibly shorter than
 * `dims`) sorts strictly on the `wantAfter` side of `focusValues` in
 * composite order. A full tie can't occur in practice: focusId always
 * names a real, non-collapsed row, so no collapsed path's full prefix can
 * equal it. */
function keyPassesSeek(key, focusValues, dims, wantAfter) {
  for (let i = 0; i < key.length; i++) {
    if (key[i] === focusValues[i]) continue;
    const gt =
      dims[i].direction === "ASC"
        ? key[i] > focusValues[i]
        : key[i] < focusValues[i];
    return wantAfter ? gt : !gt;
  }
  return false;
}

function countCollapsedPath(db, path, dims) {
  const { sql, params } = collapsedPathCondition(path, dims);
  const positiveSql = sql.replace(/^NOT /, "");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0 AND ${positiveSql}`
    )
    .get(...params);
  return row.count;
}

/**
 * Which collapsed paths belong in this direction's page, as fully-built
 * placeholder objects (with their count already queried): on the correct
 * side of the focus (or, with no focus, only the "after" direction — there
 * is nothing "before" the true start of the whole feed), and not further
 * out than what was actually fetched — UNLESS fetching returned fewer than
 * `limit` real rows, meaning this direction hit the true edge of the whole
 * dataset, so nothing bounds it from that side.
 */
function selectPlaceholders(
  db,
  collapsed,
  dims,
  focusValues,
  wantAfter,
  realRows,
  limit
) {
  if (!collapsed.length) return [];
  const hitEdge = realRows.length < limit;
  const boundaryRow = realRows.length
    ? realRows[wantAfter ? realRows.length - 1 : 0]
    : null;
  const boundaryKey = boundaryRow
    ? dims.map((d) => boundaryRow.groupValues[d.name])
    : null;

  return collapsed
    .filter((path) => {
      const key = path.map((p) => p.value); // length = path.length, NOT dims.length
      if (focusValues) {
        if (!keyPassesSeek(key, focusValues, dims, wantAfter)) return false;
      } else if (!wantAfter) {
        return false;
      }
      if (!hitEdge && boundaryKey) {
        const cmp = compareKeyTuples(
          key,
          boundaryKey.slice(0, key.length),
          dims
        );
        const withinBound = wantAfter ? cmp <= 0 : cmp >= 0;
        if (!withinBound) return false;
      }
      return true;
    })
    .map((path) => ({
      collapsed: true,
      id: placeholderId(path),
      path,
      groupValues: pathGroupValues(path),
      count: countCollapsedPath(db, path, dims),
    }));
}

/** How many leading dimensions an item's groupValues actually has real
 * values for — the full dims.length for a real row, or just its own
 * collapsed path's length for a placeholder. Needed so two placeholders of
 * DIFFERENT depths landing in the same page never get compared past
 * whichever one's shallower (comparing past that point would read
 * `undefined` off the shorter one's groupValues). */
function itemDepth(item, dims) {
  return item.collapsed ? item.path.length : dims.length;
}

/** Inserts each placeholder into `realRows` (already in ascending composite
 * order) at the position of the first row — real or a previously-inserted
 * placeholder — that sorts after it. */
function spliceInPlaceholders(realRows, placeholders, dims) {
  if (!placeholders.length) return realRows;
  const result = [...realRows];
  for (const ph of placeholders) {
    const key = ph.path.map((p) => p.value);
    let insertAt = result.length;
    for (let i = 0; i < result.length; i++) {
      const depth = Math.min(key.length, itemDepth(result[i], dims));
      const itemKey = dims
        .slice(0, depth)
        .map((d) => result[i].groupValues[d.name]);
      if (compareKeyTuples(key.slice(0, depth), itemKey, dims) < 0) {
        insertAt = i;
        break;
      }
    }
    result.splice(insertAt, 0, ph);
  }
  return result;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string,value:string}>>, focusId?: number|null, startPath?: Array<{dimension:string,value:string}>|null, before?: number, after?: number}} opts
 */
export function getFeedPage(
  db,
  {
    groupBy,
    collapsed = [],
    focusId = null,
    startPath = null,
    before = 0,
    after = 50,
  }
) {
  const dims = resolveDimensions(groupBy);
  const seekDims = [
    ...dims,
    { name: "__id", expr: "photos.id", direction: "ASC" },
  ];
  const selectDimCols = dims.map((d, i) => `${d.expr} AS dim${i}`).join(", ");
  const { sql: exclSql, params: exclParams } = exclusionClause(collapsed, dims);

  let focusValues = null;
  let focusItem = null;
  if (focusId != null) {
    const focusRow = db
      .prepare(
        `SELECT photos.id, photos.filename AS name, photos.size,
                photos.mtime AS mtimeMs, photos.rating,
                photos.preferred_cover AS preferredCover,
                photos.width, photos.height, photos.taken_at,
                ${selectDimCols}
         FROM photos JOIN folders ON folders.id = photos.folder_id
         WHERE photos.id = ?`
      )
      .get(focusId);
    if (!focusRow) throw new Error(`focusId ${focusId} not found`);
    focusValues = dims.map((_, i) => focusRow[`dim${i}`]).concat(focusRow.id);
    focusItem = rowToItem(focusRow, dims);
  }

  function fetchRealRows(wantAfter, limit) {
    if (!limit) return [];
    let seekSql = "1=1";
    let seekParams = [];
    if (focusValues) {
      const seek = seekCondition(seekDims, focusValues, wantAfter);
      seekSql = seek.sql;
      seekParams = seek.params;
    } else if (startPath && startPath.length && wantAfter) {
      const seek = startPathCondition(dims, startPath);
      seekSql = seek.sql;
      seekParams = seek.params;
    }
    // Fetching "before" a focus needs the DB to walk backwards from the
    // focus (nearest-first) so LIMIT keeps the N closest rows, not an
    // arbitrary N from the start of the whole table — then reverse back
    // to ascending-output order once the page itself is small.
    const orderCols = seekDims
      .map((d, i) => {
        const col = i < dims.length ? `dim${i}` : "photos.id";
        const direction = wantAfter
          ? d.direction
          : d.direction === "ASC"
            ? "DESC"
            : "ASC";
        return `${col} ${direction}`;
      })
      .join(", ");
    const rows = db
      .prepare(
        `SELECT photos.id, photos.filename AS name, photos.size,
                photos.mtime AS mtimeMs, photos.rating,
                photos.preferred_cover AS preferredCover,
                photos.width, photos.height, photos.taken_at,
                ${selectDimCols}
         FROM photos
         JOIN folders ON folders.id = photos.folder_id
         WHERE photos.stale = 0 AND (${exclSql}) AND (${seekSql})
         ORDER BY ${orderCols}
         LIMIT ?`
      )
      .all(...exclParams, ...seekParams, limit);
    const items = rows.map((r) => rowToItem(r, dims));
    return wantAfter ? items : items.reverse();
  }

  const beforeReal = fetchRealRows(false, before);
  const afterReal = fetchRealRows(true, after);

  const beforePlaceholders = selectPlaceholders(
    db,
    collapsed,
    dims,
    focusValues,
    false,
    beforeReal,
    before
  );
  const afterPlaceholders = selectPlaceholders(
    db,
    collapsed,
    dims,
    focusValues,
    true,
    afterReal,
    after
  );

  const items = [
    ...spliceInPlaceholders(beforeReal, beforePlaceholders, dims),
    ...spliceInPlaceholders(afterReal, afterPlaceholders, dims),
  ];
  return { items, focusItem };
}
```

Leave `resolveDimensions`, `collapsedPathCondition`, and `exclusionClause` (lines 27–72 of the original file) untouched — they're unchanged inputs to the new code.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/db/feed.test.js`
Expected: PASS (all tests, including the new placeholder and startPath blocks).

- [ ] **Step 5: Update `GET /api/feed` in `server/api.js`**

Change the route handler (currently around line 246–290) from:

```js
const focusIdParam = req.query.focusId;
const focusId =
  focusIdParam !== undefined && focusIdParam !== ""
    ? Number(focusIdParam)
    : null;
const before = Math.max(0, Number(req.query.before) || 0);
const after = Math.max(0, Number(req.query.after) || 50);

const db = getDb();
try {
  const { items, sections, focusItem } = getFeedPage(db, {
    groupBy,
    collapsed,
    focusId,
    before,
    after,
  });
  res.json({ items, sections, focusItem });
} catch (err) {
  res.status(400).json({ error: err.message });
}
```

to:

```js
const focusIdParam = req.query.focusId;
const focusId =
  focusIdParam !== undefined && focusIdParam !== ""
    ? Number(focusIdParam)
    : null;
let startPath = null;
if (req.query.startPath) {
  try {
    startPath = JSON.parse(String(req.query.startPath));
  } catch {
    return res.status(400).json({ error: "startPath must be JSON" });
  }
}
const before = Math.max(0, Number(req.query.before) || 0);
const after = Math.max(0, Number(req.query.after) || 50);

const db = getDb();
try {
  const { items, focusItem } = getFeedPage(db, {
    groupBy,
    collapsed,
    focusId,
    startPath,
    before,
    after,
  });
  res.json({ items, focusItem });
} catch (err) {
  res.status(400).json({ error: err.message });
}
```

- [ ] **Step 6: Update the existing `/api/feed` tests that reference `sections`**

In `server/api.test.js`, within the existing `describe("GET /api/feed", ...)` block:

Change:

```js
expect(body.items[0]).toHaveProperty("groupValues.folder");
expect(body.sections).toEqual([]);
```

to:

```js
expect(body.items[0]).toHaveProperty("groupValues.folder");
```

Change the `"excludes a collapsed folder and returns its summary count"` test from:

```js
it("excludes a collapsed folder and returns its summary count", async () => {
  await scan(srv.base, photosDir);
  const collapsed = encodeURIComponent(
    JSON.stringify([[{ dimension: "folder", value: photosDir }]])
  );
  const res = await fetch(
    `${srv.base}/api/feed?groupBy=folder&collapsed=${collapsed}&after=50`
  );
  const body = await res.json();
  expect(body.items).toEqual([]);
  expect(body.sections).toHaveLength(1);
  expect(body.sections[0].count).toBeGreaterThan(0);
});
```

to:

```js
it("folds a collapsed folder into one in-place placeholder item", async () => {
  await scan(srv.base, photosDir);
  const collapsed = encodeURIComponent(
    JSON.stringify([[{ dimension: "folder", value: photosDir }]])
  );
  const res = await fetch(
    `${srv.base}/api/feed?groupBy=folder&collapsed=${collapsed}&after=50`
  );
  const body = await res.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0].collapsed).toBe(true);
  expect(body.items[0].count).toBeGreaterThan(0);
});
```

Add a new test for `startPath` at the end of the same describe block, before its closing `});`:

```js
it("supports startPath to jump to an arbitrary hierarchy path", async () => {
  await scan(srv.base, photosDir);
  const startPath = encodeURIComponent(
    JSON.stringify([{ dimension: "folder", value: photosDir }])
  );
  const res = await fetch(
    `${srv.base}/api/feed?groupBy=folder&startPath=${startPath}&after=50`
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.items.length).toBeGreaterThan(0);
});
```

- [ ] **Step 7: Run the full server test suite**

Run: `npx vitest run server/`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/db/feed.js server/db/feed.test.js server/api.js server/api.test.js
git commit -m "feat: splice in-place collapsed placeholders into getFeedPage, add startPath seeking"
```

---

### Task 4: Client — `feed.js` helpers for placeholder-aware rendering and pagination

**Files:**

- Modify: `ui/src/lib/feed.js`
- Test: `ui/src/lib/feed.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `suppressPlaceholderHeaders(headers, displayEntries)` and `nearestRealItemId(items, from)`, both exported from `ui/src/lib/feed.js`. Task 9 uses both in `App.svelte`.

- [ ] **Step 1: Write the failing tests**

Add to `ui/src/lib/feed.test.js`, after the existing `describe("deriveSectionHeaders", ...)` block, and update the import line at the top of the file from:

```js
import {
  formatGroupValue,
  mergeFeedPage,
  deriveSectionHeaders,
} from "./feed.js";
```

to:

```js
import {
  formatGroupValue,
  mergeFeedPage,
  deriveSectionHeaders,
  suppressPlaceholderHeaders,
  nearestRealItemId,
} from "./feed.js";
```

Then append:

```js
describe("suppressPlaceholderHeaders", () => {
  const displayEntries = [
    { kind: "photo", item: { id: 1 } },
    {
      kind: "placeholder",
      item: {
        id: "collapsed:year=2019",
        path: [{ dimension: "year", value: "2019" }],
      },
    },
    { kind: "photo", item: { id: 2 } },
  ];

  it("drops a header at or below a placeholder's own collapse depth", () => {
    const headers = [
      { index: 1, depth: 0, dimension: "folder", value: "/a", label: "/a" },
      { index: 1, depth: 1, dimension: "year", value: "2019", label: "2019" },
    ];
    const kept = suppressPlaceholderHeaders(headers, displayEntries);
    expect(kept).toEqual([
      { index: 1, depth: 0, dimension: "folder", value: "/a", label: "/a" },
    ]);
  });

  it("keeps headers on real photo entries untouched", () => {
    const headers = [
      { index: 0, depth: 0, dimension: "folder", value: "/a", label: "/a" },
      { index: 2, depth: 0, dimension: "folder", value: "/b", label: "/b" },
    ];
    expect(suppressPlaceholderHeaders(headers, displayEntries)).toEqual(
      headers
    );
  });
});

describe("nearestRealItemId", () => {
  it("finds the last real item's id, skipping a trailing placeholder", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: "ph", collapsed: true }];
    expect(nearestRealItemId(items, "end")).toBe(2);
  });

  it("finds the first real item's id, skipping a leading placeholder", () => {
    const items = [{ id: "ph", collapsed: true }, { id: 1 }, { id: 2 }];
    expect(nearestRealItemId(items, "start")).toBe(1);
  });

  it("returns null when every item is a placeholder", () => {
    const items = [
      { id: "ph1", collapsed: true },
      { id: "ph2", collapsed: true },
    ];
    expect(nearestRealItemId(items, "end")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/lib/feed.test.js`
Expected: FAIL — `suppressPlaceholderHeaders`/`nearestRealItemId` are not exported yet.

- [ ] **Step 3: Implement in `ui/src/lib/feed.js`**

Add these two functions at the end of the file:

```js
/**
 * Drops any header deriveSectionHeaders would otherwise emit at or below a
 * placeholder's own collapse depth — the placeholder already renders its
 * own folded label/count (see App.svelte's grid template), so a normal
 * sticky-header band there would duplicate the same boundary.
 * @param {Array<{index:number, depth:number}>} headers
 * @param {Array<{kind:string, item:object}>} displayEntries
 * @returns {Array<{index:number, depth:number, dimension:string, value:string, label:string}>}
 */
export function suppressPlaceholderHeaders(headers, displayEntries) {
  return headers.filter((h) => {
    const entry = displayEntries[h.index];
    if (entry?.kind !== "placeholder") return true;
    return h.depth < entry.item.path.length - 1;
  });
}

/**
 * The id of the nearest non-placeholder item from one end of the array —
 * used as a keyset seek anchor for loadMore, since a placeholder's
 * synthetic id has no corresponding photos row for the server to look up a
 * position from.
 * @param {Array<{id: number|string, collapsed?: boolean}>} items
 * @param {'start'|'end'} from
 * @returns {number|string|null}
 */
export function nearestRealItemId(items, from) {
  const seq = from === "end" ? [...items].reverse() : items;
  const real = seq.find((it) => !it.collapsed);
  return real ? real.id : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/feed.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/feed.js ui/src/lib/feed.test.js
git commit -m "feat: add suppressPlaceholderHeaders and nearestRealItemId to feed.js"
```

---

### Task 5: Client — `displayEntries.js` placeholder entry kind

**Files:**

- Modify: `ui/src/lib/displayEntries.js`
- Test: `ui/src/lib/displayEntries.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `buildDisplayEntries` now emits a third entry kind, `{kind: "placeholder", item}`, for any input item shaped `{collapsed: true, ...}`. `entryDomId`/`resolvePhoto` handle it. Task 6/9 rely on this.

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/lib/displayEntries.test.js`:

```js
describe("buildDisplayEntries — placeholder entries", () => {
  const placeholder = {
    collapsed: true,
    id: "collapsed:year=2019",
    path: [{ dimension: "year", value: "2019" }],
    count: 42,
    groupValues: { year: "2019" },
  };

  it("passes a collapsed item through as its own placeholder entry, never treated as a photo or burst member", () => {
    const mixed = [items[0], placeholder, items[1]];
    const entries = buildDisplayEntries(mixed, [], new Set());
    expect(entries).toEqual([
      { kind: "photo", item: items[0], stackId: null },
      { kind: "placeholder", item: placeholder },
      { kind: "photo", item: items[1], stackId: null },
    ]);
  });
});

describe("entryDomId — placeholder entries", () => {
  it("returns the placeholder's own id", () => {
    const placeholder = {
      collapsed: true,
      id: "collapsed:year=2019",
      path: [],
      count: 1,
      groupValues: {},
    };
    expect(entryDomId({ kind: "placeholder", item: placeholder })).toBe(
      "collapsed:year=2019"
    );
  });
});

describe("resolvePhoto — placeholder entries", () => {
  it("returns the placeholder object itself", () => {
    const placeholder = {
      collapsed: true,
      id: "collapsed:year=2019",
      path: [],
      count: 1,
      groupValues: {},
    };
    expect(resolvePhoto({ kind: "placeholder", item: placeholder })).toBe(
      placeholder
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/lib/displayEntries.test.js`
Expected: FAIL — a `collapsed:true` item currently gets treated as a normal photo (no burst match), landing in a `{kind:"photo", ...}` entry rather than `{kind:"placeholder", ...}`.

- [ ] **Step 3: Implement in `ui/src/lib/displayEntries.js`**

Update the module doc comment's return-type union (currently lines 17–20) to:

```js
 * @returns {Array<
 *   | { kind: 'photo', item: object, stackId: string|null }
 *   | { kind: 'stack', stack: object, coverItem: object, peekItems: object[] }
 *   | { kind: 'placeholder', item: object }
 * >}
```

Change the body of `buildDisplayEntries` (currently lines 22–53) from:

```js
export function buildDisplayEntries(items, stacks, expandedStackIds) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const stackByMemberId = new Map();
  for (const stack of stacks) {
    for (const id of stack.memberIds) stackByMemberId.set(id, stack);
  }

  const emittedStackIds = new Set();
  const entries = [];
  for (const item of items) {
    const stack = stackByMemberId.get(item.id);
```

to:

```js
export function buildDisplayEntries(items, stacks, expandedStackIds) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const stackByMemberId = new Map();
  for (const stack of stacks) {
    for (const id of stack.memberIds) stackByMemberId.set(id, stack);
  }

  const emittedStackIds = new Set();
  const entries = [];
  for (const item of items) {
    if (item.collapsed) {
      entries.push({ kind: "placeholder", item });
      continue;
    }
    const stack = stackByMemberId.get(item.id);
```

(the rest of the function body — the `if (!stack)`/`else if`/`else` chain — is unchanged, just now unreachable for a placeholder item).

Change `entryDomId` from:

```js
export function entryDomId(entry) {
  return String(entry.kind === "stack" ? entry.stack.id : entry.item.id);
}
```

to:

```js
export function entryDomId(entry) {
  if (entry.kind === "placeholder") return String(entry.item.id);
  return String(entry.kind === "stack" ? entry.stack.id : entry.item.id);
}
```

`resolvePhoto` needs no code change — `entry.kind === "stack" ? entry.coverItem : entry.item` already falls through to `entry.item` for a `"placeholder"` entry, which IS the placeholder object. Update its doc comment only, from:

```js
/** The underlying photo a display entry represents (a stack's cover, or the photo itself). */
```

to:

```js
/** The underlying photo a display entry represents (a stack's cover, the
 * photo itself, or — for a placeholder entry — the placeholder object
 * itself, which callers must check `entry.kind` before treating as a real
 * photo). */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/displayEntries.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/displayEntries.js ui/src/lib/displayEntries.test.js
git commit -m "feat: add a placeholder display-entry kind for in-place collapsed sections"
```

---

### Task 6: Client — `sectionedJustified.js` placeholder-aware layout

**Files:**

- Modify: `ui/src/lib/layouts/sectionedJustified.js`
- Test: `ui/src/lib/layouts/sectionedJustified.test.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `sectionedJustifiedLayout` now accepts an `items` array where an entry can be `{id, placeholder: true}` instead of `{id, aspectRatio}`. Return shape is UNCHANGED (`{boxes, headers, totalHeight}`) — `boxes` stays index-aligned 1:1 with `items` (this is the critical property: every index gets exactly one box, either `{id,x,y,width,height}` for a real photo or `{id,y,height,placeholder:true}` for a placeholder, so callers can keep using positional `boxes[i]` lookups without a separate id-lookup map). Task 9 relies on this alignment.

**Why `boxes` must stay index-aligned:** this project has hit the same class of bug three times already this session — an index derived in one array's space (e.g. `items`) silently misapplied to a different array (e.g. `displayEntries`) whose length diverges once something (a burst stack, now a placeholder) collapses multiple entries into fewer. Keeping every index contribute exactly one `boxes` entry, whatever kind, avoids reintroducing that bug class here.

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/lib/layouts/sectionedJustified.test.js`:

```js
it("reserves a band for a placeholder, excludes it from photo packing, and keeps boxes index-aligned with items", () => {
  const its = [
    ...items(4),
    { id: "ph-1", placeholder: true },
    ...items(4).map((it) => ({ ...it, id: it.id + 100 })),
  ];
  const { boxes, totalHeight } = sectionedJustifiedLayout(its, [], {
    ...opts,
    headerHeight,
    placeholderHeight: 40,
  });
  expect(boxes).toHaveLength(its.length); // one box per item, including the placeholder
  const placeholderBox = boxes[4];
  expect(placeholderBox).toEqual({
    id: "ph-1",
    x: 0,
    y: expect.any(Number),
    width: opts.containerWidth,
    height: 40,
    placeholder: true,
  });
  const before = boxes.slice(0, 4);
  const after = boxes.slice(5);
  expect(before.every((b) => !b.placeholder)).toBe(true);
  expect(after.every((b) => !b.placeholder)).toBe(true);
  const maxBeforeY = Math.max(...before.map((b) => b.y));
  const minAfterY = Math.min(...after.map((b) => b.y));
  expect(placeholderBox.y).toBeGreaterThanOrEqual(maxBeforeY);
  expect(placeholderBox.y + placeholderBox.height).toBeLessThanOrEqual(
    minAfterY
  );
  expect(totalHeight).toBeGreaterThan(placeholderBox.y + placeholderBox.height);
});

it("combines a placeholder with a header at the same index without conflict", () => {
  const its = [
    ...items(3),
    { id: "ph-1", placeholder: true },
    ...items(3).map((it) => ({ ...it, id: it.id + 100 })),
  ];
  const headersIn = [
    { index: 3, depth: 0, dimension: "year", value: "2019", label: "2019" },
  ];
  const { boxes, headers } = sectionedJustifiedLayout(its, headersIn, {
    ...opts,
    headerHeight,
    placeholderHeight: 40,
  });
  expect(boxes).toHaveLength(its.length);
  expect(boxes[3].placeholder).toBe(true);
  expect(headers).toHaveLength(1);
  expect(boxes[3].y).toBeGreaterThanOrEqual(headers[0].y + headerHeight);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/lib/layouts/sectionedJustified.test.js`
Expected: FAIL — `justifiedLayout` currently receives the placeholder item too (it has no `aspectRatio`, so it gets treated as `DEFAULT_RATIO`-like via `justified.js`'s own fallback), producing an extra photo box instead of a placeholder band.

- [ ] **Step 3: Implement in `ui/src/lib/layouts/sectionedJustified.js`**

Replace the entire file with:

```js
import { justifiedLayout, layoutHeight } from "./justified.js";

/**
 * Wraps justifiedLayout to reserve full-width header bands at section
 * boundaries and restart each section on a fresh row, so a header never
 * splits a row of photos across two sections. Also computes each header's
 * vertical extent (y..endY) so the caller can render a per-section wrapper
 * bounding a sticky header — true "sticky within this section only"
 * behavior requires a bounded ancestor; a flat position:sticky sibling of
 * absolutely-positioned photo boxes has no such bound on its own.
 *
 * An item marked `{ id, placeholder: true }` instead of carrying an
 * `aspectRatio` (a collapsed section's folded row — see
 * ui/src/lib/displayEntries.js's "placeholder" entry kind) also forces a
 * row-break on both sides and reserves its own full-width band, sized by
 * `placeholderHeight` — it never participates in the photo-packing rows.
 * Every original index still contributes exactly one entry to `boxes`
 * (either a real photo box or a placeholder box), so `boxes` stays
 * index-aligned 1:1 with the input `items` array — callers can keep using
 * a positional `boxes[i]` lookup rather than needing a separate id-keyed
 * map.
 *
 * @param {Array<{id: number|string, aspectRatio: number} | {id: number|string, placeholder: true}>} items
 * @param {Array<{index: number, depth: number, dimension: string, value: string, label: string}>} headers
 *   from deriveSectionHeaders, indices into `items`, ascending order.
 * @param {{ targetRowHeight?: number, containerWidth: number, gap?: number, headerHeight?: number, placeholderHeight?: number }} opts
 * @returns {{
 *   boxes: Array<{id: number|string, x: number, y: number, width: number, height: number, placeholder?: true}>,
 *   headers: Array<{index: number, depth: number, dimension: string, value: string, label: string, y: number, endY: number}>,
 *   totalHeight: number
 * }}
 */
export function sectionedJustifiedLayout(
  items,
  headers,
  {
    targetRowHeight = 220,
    containerWidth,
    gap = 8,
    headerHeight = 32,
    placeholderHeight = 32,
  }
) {
  const headersByIndex = new Map();
  for (const h of headers) {
    if (!headersByIndex.has(h.index)) headersByIndex.set(h.index, []);
    headersByIndex.get(h.index).push(h);
  }

  const boxes = [];
  const openHeaders = []; // stack of headers currently "in scope", ordered by depth
  const closedHeaders = [];
  let yOffset = 0;
  let chunkStart = 0;

  function flushChunk(end) {
    if (end <= chunkStart) {
      chunkStart = end;
      return;
    }
    // Placeholders always advance chunkStart past themselves the moment
    // they're encountered (below), so a chunk slice never contains one —
    // this filter is a defensive no-op given the current call pattern,
    // kept because it makes that invariant checkable in isolation.
    const chunkItems = items
      .slice(chunkStart, end)
      .filter((it) => !it.placeholder);
    const chunkBoxes = justifiedLayout(chunkItems, {
      targetRowHeight,
      containerWidth,
      gap,
    });
    for (const b of chunkBoxes) boxes.push({ ...b, y: b.y + yOffset });
    yOffset += chunkBoxes.length ? layoutHeight(chunkBoxes) + gap : 0;
    chunkStart = end;
  }

  // A header at depth D closes every currently-open header at depth >= D —
  // an outer boundary (smaller depth) always ends every inner section
  // nested under it; a new header at the SAME depth as an open one replaces
  // it (a sibling section, not a child).
  function closeAtOrBelow(depth, endY) {
    while (
      openHeaders.length &&
      openHeaders[openHeaders.length - 1].depth >= depth
    ) {
      closedHeaders.push({ ...openHeaders.pop(), endY });
    }
  }

  for (let i = 0; i < items.length; i++) {
    const hs = headersByIndex.get(i);
    if (hs) {
      flushChunk(i);
      for (const h of hs) {
        closeAtOrBelow(h.depth, yOffset);
        openHeaders.push({ ...h, y: yOffset });
        yOffset += headerHeight;
      }
    }
    if (items[i].placeholder) {
      flushChunk(i);
      // x/width span the full row (matching a real box's shape) rather
      // than being omitted — App.svelte's navVertical computes
      // `box.x + box.width / 2` for ANY box, placeholder or not; leaving
      // these undefined would silently produce NaN and desync arrow-key
      // navigation around a placeholder row.
      boxes.push({
        id: items[i].id,
        x: 0,
        y: yOffset,
        width: containerWidth,
        height: placeholderHeight,
        placeholder: true,
      });
      yOffset += placeholderHeight + gap;
      chunkStart = i + 1;
    }
  }
  flushChunk(items.length);
  closeAtOrBelow(0, yOffset);

  closedHeaders.sort((a, b) => a.index - b.index || a.depth - b.depth);
  return { boxes, headers: closedHeaders, totalHeight: yOffset };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/layouts/sectionedJustified.test.js`
Expected: PASS (all tests, including the 4 pre-existing ones — this change is additive and backward compatible, since none of the existing fixtures include a `.placeholder` item).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/layouts/sectionedJustified.js ui/src/lib/layouts/sectionedJustified.test.js
git commit -m "feat: make sectionedJustifiedLayout placeholder-aware, keeping boxes index-aligned"
```

---

### Task 7: Client — `treeState.js`, `fetchTreeNode`, `fetchFeed`'s `startPath`

**Files:**

- Create: `ui/src/lib/treeState.js`
- Test: `ui/src/lib/treeState.test.js`
- Modify: `ui/src/lib/api.js`

**Interfaces:**

- Consumes: nothing new.
- Produces: `treeKey(path)`, `collapseDescendants(expandedKeys, path)` from `ui/src/lib/treeState.js`; `fetchTreeNode({groupBy, path})` from `ui/src/lib/api.js`; `fetchFeed` gains an optional `startPath` param. Task 8/9 consume all three.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/treeState.test.js`:

```js
import { describe, it, expect } from "vitest";
import { treeKey, collapseDescendants } from "./treeState.js";

describe("treeKey", () => {
  it("joins dimension=value pairs with '>'", () => {
    expect(
      treeKey([
        { dimension: "folder", value: "/a" },
        { dimension: "year", value: "2020" },
      ])
    ).toBe("folder=/a>year=2020");
  });

  it("returns an empty string for the root path", () => {
    expect(treeKey([])).toBe("");
  });
});

describe("collapseDescendants", () => {
  it("removes every key nested under the given path", () => {
    const expanded = new Set([
      "folder=/a",
      "folder=/a>year=2020",
      "folder=/a>year=2020>month=2020-01",
      "folder=/b",
    ]);
    const next = collapseDescendants(expanded, [
      { dimension: "folder", value: "/a" },
    ]);
    expect(next).toEqual(new Set(["folder=/a", "folder=/b"]));
  });

  it("leaves the path's own key untouched", () => {
    const expanded = new Set(["folder=/a"]);
    const next = collapseDescendants(expanded, [
      { dimension: "folder", value: "/a" },
    ]);
    expect(next.has("folder=/a")).toBe(true);
  });

  it("does not remove a sibling whose key merely starts with the same string prefix", () => {
    const expanded = new Set(["folder=/a", "folder=/a2"]);
    const next = collapseDescendants(expanded, [
      { dimension: "folder", value: "/a" },
    ]);
    expect(next).toEqual(new Set(["folder=/a", "folder=/a2"]));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/lib/treeState.test.js`
Expected: FAIL — `Cannot find module './treeState.js'`.

- [ ] **Step 3: Implement `ui/src/lib/treeState.js`**

```js
/**
 * Pure tree-local expand-state helpers for TreeSidebar/TreeNode — track
 * which paths currently have their children fetched and shown, entirely
 * independent of collapsedPaths (which controls what the FEED excludes;
 * see docs/superpowers/specs/2026-07-06-tree-sidebar-design.md's "Two
 * distinct kinds of state"). Keyed by the same convention App.svelte's own
 * pathKey uses (dimension=value>dimension=value...).
 */

/** @param {Array<{dimension:string,value:string}>} path @returns {string} */
export function treeKey(path) {
  return path.map((p) => `${p.dimension}=${p.value}`).join(">");
}

/**
 * Resets every currently-expanded descendant of `path` back to collapsed —
 * "fold all descendants." A descendant's key starts with this path's own
 * key followed by the '>' separator, so string-prefix matching identifies
 * them without needing the tree's actual node objects. The separator
 * matters: without it, "folder=/a" would incorrectly match a sibling key
 * like "folder=/a2". `path` itself is left untouched — the caller decides
 * separately whether the clicked node stays expanded or collapses too.
 * @param {Set<string>} expandedKeys
 * @param {Array<{dimension:string,value:string}>} path
 * @returns {Set<string>}
 */
export function collapseDescendants(expandedKeys, path) {
  const prefix = treeKey(path) + ">";
  const next = new Set();
  for (const key of expandedKeys) {
    if (!key.startsWith(prefix)) next.add(key);
  }
  return next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/treeState.test.js`
Expected: PASS.

- [ ] **Step 5: Add `fetchTreeNode` and `startPath` support to `ui/src/lib/api.js`**

Add this function to `ui/src/lib/api.js`, after `fetchFeed`:

```js
/**
 * @param {{groupBy: string[], path?: Array<{dimension:string,value:string}>}} opts
 * @returns {Promise<{total:number, nodes: Array<{value:string,label:string,count:number,hasChildren:boolean}>}>}
 */
export async function fetchTreeNode({ groupBy, path = [] }) {
  const params = new URLSearchParams({ groupBy: groupBy.join(",") });
  if (path.length) params.set("path", JSON.stringify(path));
  const res = await fetch(`/api/tree?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `tree failed (${res.status})`);
  }
  return res.json();
}
```

Change `fetchFeed`'s signature and body from:

```js
/**
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string,value:string}>>, focusId?: number|null, before?: number, after?: number}} opts
 * @returns {Promise<{items: object[], sections: Array<{path: Array<{dimension:string,value:string}>, count: number}>, focusItem: object|null}>}
 */
export async function fetchFeed({
  groupBy,
  collapsed = [],
  focusId = null,
  before = 0,
  after = 50,
}) {
  const params = new URLSearchParams({
    groupBy: groupBy.join(","),
    before: String(before),
    after: String(after),
  });
  if (focusId != null) params.set("focusId", String(focusId));
  if (collapsed.length) params.set("collapsed", JSON.stringify(collapsed));
  const res = await fetch(`/api/feed?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `feed failed (${res.status})`);
  }
  return res.json();
}
```

to:

```js
/**
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string,value:string}>>, focusId?: number|null, startPath?: Array<{dimension:string,value:string}>|null, before?: number, after?: number}} opts
 * @returns {Promise<{items: object[], focusItem: object|null}>}
 */
export async function fetchFeed({
  groupBy,
  collapsed = [],
  focusId = null,
  startPath = null,
  before = 0,
  after = 50,
}) {
  const params = new URLSearchParams({
    groupBy: groupBy.join(","),
    before: String(before),
    after: String(after),
  });
  if (focusId != null) params.set("focusId", String(focusId));
  if (startPath && startPath.length) {
    params.set("startPath", JSON.stringify(startPath));
  }
  if (collapsed.length) params.set("collapsed", JSON.stringify(collapsed));
  const res = await fetch(`/api/feed?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `feed failed (${res.status})`);
  }
  return res.json();
}
```

`ui/src/lib/api.js` has no dedicated test file today (thin fetch wrappers, exercised via the server's own route tests and manual verification) — this task doesn't add one, matching that existing precedent.

- [ ] **Step 6: Run the full client test suite**

Run: `npx vitest run ui/`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/treeState.js ui/src/lib/treeState.test.js ui/src/lib/api.js
git commit -m "feat: add treeState helpers, fetchTreeNode, and fetchFeed's startPath param"
```

---

### Task 8: Client — `TreeNode.svelte` and `TreeSidebar.svelte`

**Files:**

- Create: `ui/src/lib/TreeNode.svelte`
- Create: `ui/src/lib/TreeSidebar.svelte`

**Interfaces:**

- Consumes: `fetchTreeNode` (Task 7's `api.js`), `treeKey`/`collapseDescendants` (Task 7's `treeState.js`).
- Produces: `TreeSidebar.svelte` — props `groupBy` (`string[]`), `collapsedPaths` (`Array<Array<{dimension,value}>>`); dispatches `toggle` (detail: `path`) and `jump` (detail: `path`); exports `revealPath(targetPath)` for a parent to call via `bind:this`. Task 9 wires this into `App.svelte`.

No automated test for these two files — Svelte components, manual browser verification only (Task 10), per this project's convention. All nontrivial logic they use (`treeKey`, `collapseDescendants`) is already extracted and tested in Task 7.

- [ ] **Step 1: Create `ui/src/lib/TreeNode.svelte`**

```svelte
<script>
  import { createEventDispatcher } from "svelte";
  import { treeKey } from "./treeState.js";

  export let groupBy; // string[]
  export let path; // Array<{dimension,value}> — this node's own path
  export let node; // {value, label, count, hasChildren}
  export let expandedKeys; // Set<string>
  export let childrenByKey; // Map<string, {nodes, error?}>
  export let loadingKeys; // Set<string>
  export let highlightedKey; // string|null
  export let isCollapsedInFeed; // (path) => boolean

  const dispatch = createEventDispatcher();

  $: depth = path.length - 1;
  $: key = treeKey(path);
  $: expanded = expandedKeys.has(key);
  $: loading = loadingKeys.has(key);
  $: children = childrenByKey.get(key)?.nodes ?? [];
  $: childError = childrenByKey.get(key)?.error;
  $: collapsedInFeed = isCollapsedInFeed(path);
</script>

<li class="tree-node" class:highlighted={highlightedKey === key}>
  <div class="tree-node-row">
    {#if node.hasChildren}
      <button
        class="tree-fold-icon"
        title="Expand/collapse in tree (shift-click: fold all descendants)"
        on:click={(e) => dispatch("toggleExpand", { path, event: e })}
      >
        {expanded ? "▾" : "▸"}
      </button>
    {:else}
      <span class="tree-fold-spacer"></span>
    {/if}
    <button
      class="tree-collapse-icon"
      title={collapsedInFeed ? "Expand in feed" : "Collapse in feed"}
      on:click={(e) => dispatch("toggleCollapse", { path, event: e })}
    >
      {collapsedInFeed ? "▸" : "▾"}
    </button>
    <button class="tree-label" on:click={() => dispatch("jump", path)}>
      {node.label}
    </button>
    <span class="tree-count">{node.count}</span>
  </div>
  {#if expanded}
    <ul class="tree-level">
      {#if loading}
        <li class="tree-loading">Loading…</li>
      {:else if childError}
        <li class="tree-error">{childError}</li>
      {:else}
        {#each children as child (child.value)}
          <svelte:self
            {groupBy}
            path={[
              ...path,
              { dimension: groupBy[depth + 1], value: child.value },
            ]}
            node={child}
            {expandedKeys}
            {childrenByKey}
            {loadingKeys}
            {highlightedKey}
            {isCollapsedInFeed}
            on:toggleExpand
            on:toggleCollapse
            on:jump
          />
        {/each}
      {/if}
    </ul>
  {/if}
</li>

<style>
  .tree-node-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
  }
  .tree-fold-icon,
  .tree-collapse-icon {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    width: 16px;
    padding: 0;
  }
  .tree-fold-spacer {
    display: inline-block;
    width: 16px;
  }
  .tree-label {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-label:hover {
    text-decoration: underline;
  }
  .tree-count {
    color: #888;
    font-size: 0.85em;
  }
  .tree-node.highlighted > .tree-node-row {
    background: #2a2a2a;
    border-radius: 4px;
  }
  .tree-loading,
  .tree-error {
    color: #888;
    font-size: 0.85em;
    padding: 2px 0 2px 20px;
  }
  .tree-level {
    list-style: none;
    margin: 0;
    padding-left: 14px;
  }
</style>
```

- [ ] **Step 2: Create `ui/src/lib/TreeSidebar.svelte`**

```svelte
<script>
  import { createEventDispatcher } from "svelte";
  import { fetchTreeNode } from "./api.js";
  import { treeKey, collapseDescendants } from "./treeState.js";
  import TreeNode from "./TreeNode.svelte";

  export let groupBy; // string[]
  export let collapsedPaths; // Array<Array<{dimension,value}>>

  const dispatch = createEventDispatcher();

  let rootTotal = null;
  let rootNodes = [];
  let childrenByKey = new Map(); // treeKey(path) -> { nodes, error? }
  let expandedKeys = new Set();
  let loadingKeys = new Set();
  let highlightedKey = null;

  function isCollapsedInFeed(path) {
    const key = treeKey(path);
    return collapsedPaths.some((p) => treeKey(p) === key);
  }

  async function loadRoot() {
    try {
      const { total, nodes } = await fetchTreeNode({ groupBy, path: [] });
      rootTotal = total;
      rootNodes = nodes;
    } catch {
      rootTotal = null;
      rootNodes = [];
    }
  }

  // A path is only meaningful under the groupBy order it was fetched
  // with, so the whole tree resets whenever the hierarchy order changes —
  // matches the same reasoning collapsedPaths already resets on hierarchy
  // change in App.svelte.
  function resetAndLoad() {
    childrenByKey = new Map();
    expandedKeys = new Set();
    loadingKeys = new Set();
    highlightedKey = null;
    loadRoot();
  }
  $: (groupBy, resetAndLoad());

  async function loadChildren(path) {
    const key = treeKey(path);
    if (childrenByKey.has(key) || loadingKeys.has(key)) return;
    loadingKeys = new Set(loadingKeys).add(key);
    try {
      const { nodes } = await fetchTreeNode({ groupBy, path });
      childrenByKey = new Map(childrenByKey).set(key, { nodes });
    } catch (e) {
      childrenByKey = new Map(childrenByKey).set(key, {
        nodes: [],
        error: e.message,
      });
    } finally {
      const next = new Set(loadingKeys);
      next.delete(key);
      loadingKeys = next;
    }
  }

  function deleteKey(set, key) {
    const next = new Set(set);
    next.delete(key);
    return next;
  }

  function handleToggleExpand({ detail: { path, event } }) {
    const key = treeKey(path);
    if (expandedKeys.has(key)) {
      expandedKeys = event.shiftKey
        ? collapseDescendants(expandedKeys, path)
        : deleteKey(expandedKeys, key);
    } else {
      expandedKeys = new Set(expandedKeys).add(key);
      loadChildren(path);
    }
  }

  function handleToggleCollapse({ detail: { path, event } }) {
    event.stopPropagation();
    dispatch("toggle", path);
  }

  function handleJump({ detail: path }) {
    dispatch("jump", path);
  }

  /** Walks `targetPath` from the root, fetching + expanding each level as
   * needed, then highlights the resulting node — called by App.svelte's
   * "reveal current location" button via bind:this. */
  export async function revealPath(targetPath) {
    let prefix = [];
    for (let i = 0; i < targetPath.length; i++) {
      const key = treeKey(prefix);
      if (!expandedKeys.has(key)) {
        expandedKeys = new Set(expandedKeys).add(key);
      }
      await loadChildren(prefix);
      prefix = [...prefix, targetPath[i]];
    }
    highlightedKey = treeKey(targetPath);
  }
</script>

<nav class="tree-sidebar" aria-label="Library hierarchy">
  <div class="tree-root">
    <span class="tree-root-label">Library</span>
    <span class="tree-root-count">{rootTotal ?? "…"}</span>
  </div>
  <ul class="tree-level">
    {#each rootNodes as node (node.value)}
      <TreeNode
        {groupBy}
        path={[{ dimension: groupBy[0], value: node.value }]}
        {node}
        {expandedKeys}
        {childrenByKey}
        {loadingKeys}
        {highlightedKey}
        {isCollapsedInFeed}
        on:toggleExpand={handleToggleExpand}
        on:toggleCollapse={handleToggleCollapse}
        on:jump={handleJump}
      />
    {/each}
  </ul>
</nav>

<style>
  .tree-sidebar {
    width: 260px;
    flex: 0 0 260px;
    overflow-y: auto;
    border-right: 1px solid #2a2a2a;
    padding: 8px;
    box-sizing: border-box;
  }
  .tree-root {
    display: flex;
    justify-content: space-between;
    font-weight: 700;
    padding: 4px 0 8px;
    border-bottom: 1px solid #2a2a2a;
    margin-bottom: 4px;
  }
  .tree-level {
    list-style: none;
    margin: 0;
    padding-left: 14px;
  }
</style>
```

- [ ] **Step 3: Run the full client test suite to confirm nothing broke**

Run: `npx vitest run ui/`
Expected: All tests pass (these two files have no automated tests of their own; this confirms no accidental regressions in files they import from).

- [ ] **Step 4: Run the build to catch any Svelte/import syntax issues**

Run: `npm run build`
Expected: Builds successfully — `TreeSidebar.svelte`/`TreeNode.svelte` aren't imported by `App.svelte` yet (that's Task 9), so this only validates the two new files parse and compile in isolation via Vite's module graph once Task 9 wires them in. If the build succeeds without importing them yet (likely, since unimported files aren't compiled), defer full validation to Task 9's build step — note this in the task's completion report rather than treating it as a blocker.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/TreeNode.svelte ui/src/lib/TreeSidebar.svelte
git commit -m "feat: add TreeNode and TreeSidebar components (lazy hierarchy tree)"
```

---

### Task 9: Client — `App.svelte` integration

**Files:**

- Modify: `ui/src/App.svelte`

**Interfaces:**

- Consumes: everything from Tasks 4–8.
- Produces: the finished feature, wired into the running app. No new exports — this is the integration point.

- [ ] **Step 1: Update imports**

Read the current top of `ui/src/App.svelte` (lines 1–26) before editing — this section may have shifted slightly since last read. Change the import block from:

```js
import {
  mergeFeedPage,
  deriveSectionHeaders,
  formatGroupValue,
} from "./lib/feed.js";
import {
  fetchFeed,
  setRating as apiSetRating,
  setCover as apiSetCover,
  fetchMeta,
  fetchLibrary,
  scan as apiScan,
} from "./lib/api.js";
import Thumb, { PEEK_STEP_PX, MAX_PEEK_DEPTH } from "./lib/Thumb.svelte";
import Loupe from "./lib/Loupe.svelte";
import MultiAutoSelect from "multi-auto-select";
```

to:

```js
import {
  mergeFeedPage,
  deriveSectionHeaders,
  suppressPlaceholderHeaders,
  nearestRealItemId,
  formatGroupValue,
} from "./lib/feed.js";
import {
  fetchFeed,
  setRating as apiSetRating,
  setCover as apiSetCover,
  fetchMeta,
  fetchLibrary,
  scan as apiScan,
} from "./lib/api.js";
import Thumb, { PEEK_STEP_PX, MAX_PEEK_DEPTH } from "./lib/Thumb.svelte";
import Loupe from "./lib/Loupe.svelte";
import TreeSidebar from "./lib/TreeSidebar.svelte";
import MultiAutoSelect from "multi-auto-select";
```

- [ ] **Step 2: Remove the `collapsedSummaries` state and its topbar chip rendering**

Remove these lines (currently around line 100–106):

```js
// Summaries (path + count) for every currently-collapsed path, as returned
// alongside items/focusItem by the most recent successful feed fetch —
// getCollapsedSummaries computes these from the full `collapsed` array
// passed to getFeedPage, not just newly-collapsed paths, so any fetch's
// response reflects the complete current list regardless of which page
// triggered it. Rendered as re-expand chips in the topbar.
let collapsedSummaries = [];
```

Add a `treeSidebarRef` binding variable in its place:

```js
let treeSidebarRef; // bound to TreeSidebar, for revealCurrentLocation to call revealPath
```

Search the file for every `collapsedSummaries = sections;` line (there are three — in `loadInitialFeed`, `onGroupByChange`, and `loadMore`) and delete each one. Search for every `const { items: page, sections } = await fetchFeed(...)`-shaped destructure (or `afterPage, focusItem, sections`) and drop `sections` from the destructure, since `getFeedPage`/`/api/feed` no longer returns it (Task 3). For example, in `loadInitialFeed`, change:

```js
const { items: page, sections } = await fetchFeed({
  groupBy,
  collapsed: collapsedPaths,
  after: PAGE_SIZE,
});
```

to:

```js
const { items: page } = await fetchFeed({
  groupBy,
  collapsed: collapsedPaths,
  after: PAGE_SIZE,
});
```

In `onGroupByChange`, change:

```js
      const { items: afterPage, focusItem, sections } = await fetchFeed({
```

to:

```js
      const { items: afterPage, focusItem } = await fetchFeed({
```

In `loadMore`, change:

```js
      const { items: page, sections } = await fetchFeed({
```

to:

```js
      const { items: page } = await fetchFeed({
```

Find and remove the topbar chip template block (currently around lines 807–815, right after `<div class="group-by" ...></div>` in the `<header class="topbar">`):

```svelte
{#if collapsedSummaries.length}
  <div class="collapsed-sections">
    {#each collapsedSummaries as entry (pathKey(entry.path))}
      <button
        class="collapsed-chip"
        on:click={() => toggleSectionCollapse(entry.path)}
      >
        {formatGroupValue(
          entry.path[entry.path.length - 1].dimension,
          entry.path[entry.path.length - 1].value
        )}
        ({entry.count.toLocaleString()})
      </button>
    {/each}
  </div>
{/if}
```

(read the actual current block first — the exact chip markup may differ slightly from this reconstruction; remove whatever renders `collapsedSummaries` in the topbar, along with its CSS rules `.collapsed-sections`/`.collapsed-chip`/`.collapsed-chip:hover` in the `<style>` block.)

- [ ] **Step 3: Fix `loadMore`'s focusId to skip placeholder boundary items**

Change (currently around line 296–297):

```js
const focusId =
  direction === "after" ? items[items.length - 1].id : items[0].id;
```

to:

```js
const focusId =
  direction === "after"
    ? nearestRealItemId(items, "end")
    : nearestRealItemId(items, "start");
if (focusId == null) {
  // Every currently-loaded item is a placeholder (e.g. everything
  // visible right now is collapsed) — nothing real to seek from yet.
  if (direction === "after") fetchingAfter = false;
  else fetchingBefore = false;
  return;
}
```

- [ ] **Step 4: Add `suppressPlaceholderHeaders` to the section-header pipeline, and mark placeholder entries in the layout input**

Find (currently around line 448):

```js
$: sectionHeaders = deriveSectionHeaders(resolvedPhotos, groupBy);
```

Change to:

```js
$: sectionHeaders = suppressPlaceholderHeaders(
  deriveSectionHeaders(resolvedPhotos, groupBy),
  displayEntries
);
```

This alone is not sufficient — `layoutResult` (computed just below `sectionHeaders`) builds its own `{id, aspectRatio}` array from `displayEntries`, and currently has no branch for a placeholder entry, so it would compute a normal (fallback-ratio) photo box for one instead of the `{id, placeholder:true}` marker Task 6's `sectionedJustifiedLayout` needs to recognize. Find the reactive block that builds this array (currently around line 449-477):

```js
$: layoutResult =
  displayEntries.length && gridWidth > 2 * PAD
    ? sectionedJustifiedLayout(
        displayEntries.map((e) => {
          const photo = resolvePhoto(e);
          const baseRatio =
            photo.width && photo.height
              ? photo.width / photo.height
              : DEFAULT_RATIO;
          // Reserve extra width for a collapsed stack's peek layers (see
          // stackMarginPx) by inflating its aspect ratio at the target
          // row height — an approximation, not pixel-exact once a row's
          // uniform scale factor is applied, but close enough for a
          // cosmetic margin.
          const marginPx = stackMarginPx(e);
          return {
            id: entryDomId(e),
            aspectRatio: baseRatio + (2 * marginPx) / rowHeight,
          };
        }),
        sectionHeaders,
        {
          containerWidth: gridWidth - 2 * PAD,
          gap: 8,
          targetRowHeight: rowHeight,
          headerHeight: HEADER_HEIGHT,
        }
      )
    : null;
```

(read the actual current block first to confirm this matches exactly — it may have shifted slightly since last documented) and change it to:

```js
$: layoutResult =
  displayEntries.length && gridWidth > 2 * PAD
    ? sectionedJustifiedLayout(
        displayEntries.map((e) => {
          if (e.kind === "placeholder") {
            return { id: entryDomId(e), placeholder: true };
          }
          const photo = resolvePhoto(e);
          const baseRatio =
            photo.width && photo.height
              ? photo.width / photo.height
              : DEFAULT_RATIO;
          // Reserve extra width for a collapsed stack's peek layers (see
          // stackMarginPx) by inflating its aspect ratio at the target
          // row height — an approximation, not pixel-exact once a row's
          // uniform scale factor is applied, but close enough for a
          // cosmetic margin.
          const marginPx = stackMarginPx(e);
          return {
            id: entryDomId(e),
            aspectRatio: baseRatio + (2 * marginPx) / rowHeight,
          };
        }),
        sectionHeaders,
        {
          containerWidth: gridWidth - 2 * PAD,
          gap: 8,
          targetRowHeight: rowHeight,
          headerHeight: HEADER_HEIGHT,
          placeholderHeight: PLACEHOLDER_HEIGHT,
        }
      )
    : null;
```

Add a `PLACEHOLDER_HEIGHT` constant next to the existing `HEADER_HEIGHT` constant (find `const HEADER_HEIGHT = 32;`):

```js
const HEADER_HEIGHT = 32;
const PLACEHOLDER_HEIGHT = 40; // a bit taller than a header — needs room for an icon, label, and count on one line
```

- [ ] **Step 5: Add `jumpToPath` and `revealCurrentLocation` functions**

Add these near `onGroupByChange` (after it, before `pathKey`):

```js
/** Jump the feed to an arbitrary hierarchy path from the tree — unlike
 * onGroupByChange's re-centering, there's no specific photo id to seek
 * from (the target section may never have been loaded), so this uses
 * getFeedPage's startPath seek instead of a focusId. */
async function jumpToPath(path) {
  error = "";
  status = "loading…";
  const epoch = ++feedEpoch;
  try {
    const { items: page } = await fetchFeed({
      groupBy,
      collapsed: collapsedPaths,
      startPath: path,
      after: PAGE_SIZE,
    });
    if (epoch !== feedEpoch) return;
    const merged = mergeFeedPage(
      { items: [], hasMoreBefore: false, hasMoreAfter: true },
      { items: page },
      "after",
      PAGE_SIZE
    );
    items = merged.items;
    hasMoreBefore = merged.hasMoreBefore;
    hasMoreAfter = merged.hasMoreAfter;
    selected = 0;
    loupeOpen = false;
    focusPending = true;
    status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
    enrichMeta(page.map((i) => i.id));
  } catch (e) {
    error = e.message;
    status = "";
  }
}

/** "Reveal current location": walks the tree down to whatever photo is
 * currently selected, expanding/fetching each level as needed. Manual,
 * not continuous — doesn't fight the tree's own navigation while the
 * user is mid-scroll or has it open to a different part of the library. */
async function revealCurrentLocation() {
  const entry = displayEntries[selected];
  if (!entry || entry.kind === "placeholder") return;
  const photo = resolvePhoto(entry);
  if (!photo?.groupValues) return;
  const path = groupBy
    .filter((d) => photo.groupValues[d] !== undefined)
    .map((d) => ({ dimension: d, value: photo.groupValues[d] }));
  treeSidebarRef?.revealPath(path);
}
```

- [ ] **Step 6: Wire the persistent sidebar layout and the "reveal" button**

Read the current template from `<div class="app">` through the end of `<header class="topbar">` (currently around lines 803–905) before editing — exact line numbers may have shifted. Wrap the existing grid section in a new `.app-body` flex container alongside `<TreeSidebar>`, and add the reveal button to the topbar.

Change the structure from:

```svelte
<div class="app">
  <header class="topbar" bind:clientHeight={topbarHeight}>
    <h1>AutoGallery</h1>
    <div class="group-by" use:groupBySelector={groupBy}></div>
    <!-- (topbar chip block just removed in Step 2) -->
    ... rest of topbar controls ...
  </header>

  {#if items.length}
    <div class="grid" ...>...</div>
  {:else if !scanning && status !== "loading…"}
    <div class="empty">Nothing indexed yet — scan a folder to get started.</div>
  {/if}
</div>
```

to:

```svelte
<div class="app">
  <header class="topbar" bind:clientHeight={topbarHeight}>
    <h1>AutoGallery</h1>
    <div class="group-by" use:groupBySelector={groupBy}></div>
    <button
      class="reveal-btn"
      on:click={revealCurrentLocation}
      title="Reveal the current photo's location in the tree"
    >
      Locate
    </button>
    ... rest of topbar controls (unchanged) ...
  </header>

  <div class="app-body">
    <TreeSidebar
      bind:this={treeSidebarRef}
      {groupBy}
      {collapsedPaths}
      on:toggle={(e) => toggleSectionCollapse(e.detail)}
      on:jump={(e) => jumpToPath(e.detail)}
    />
    <div class="main-column">
      {#if items.length}
        <div class="grid" ...>...</div>
      {:else if !scanning && status !== "loading…"}
        <div class="empty">
          Nothing indexed yet — scan a folder to get started.
        </div>
      {/if}
    </div>
  </div>
</div>
```

(the `...` sections are the EXISTING topbar controls and grid markup, unchanged — only the wrapping structure and the two additions above are new; do not rewrite the grid's internals here, that's Step 7)

Add to the `<style>` block:

```css
.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.main-column {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.reveal-btn {
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  color: inherit;
  font: inherit;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.reveal-btn:hover {
  background: #2a2a2a;
}
```

Today the WHOLE PAGE scrolls (`<svelte:window on:scroll={scheduleVisibleRangeUpdate}>`), and `topbarHeight` (measured via `bind:clientHeight`) exists solely so sticky section headers can clear the ALSO-sticky topbar sharing that same page-level scroll. Once `.main-column` becomes its own `overflow-y:auto` container — a flex sibling of the topbar, not its scrolling descendant — the topbar is no longer in the same scroll box as the grid at all, so `topbarHeight` and its offset math become unnecessary; a sticky header only needs to clear `.main-column`'s own top edge.

Add `let mainColumnEl;` next to the existing `let gridEl;` (line 123):

```js
let gridEl;
let mainColumnEl;
```

Remove `topbarHeight` entirely — its declaration (line 418):

```js
let topbarHeight = 0;
```

delete this line. Its binding on the topbar (line 804):

```svelte
  <header class="topbar" bind:clientHeight={topbarHeight}>
```

becomes:

```svelte
  <header class="topbar">
```

Bind `.main-column` in the template (from Step 6's layout restructure above):

```svelte
    <div class="main-column" bind:this={mainColumnEl} on:scroll={scheduleVisibleRangeUpdate}>
```

Remove the window-level scroll listener, keeping only resize (a window resize still needs a recompute regardless of which element scrolls; scroll no longer happens on `window` at all). Change (line 797-801):

```svelte
<svelte:window
  on:keydown={onKeydown}
  on:scroll={scheduleVisibleRangeUpdate}
  on:resize={scheduleVisibleRangeUpdate}
/>
```

to:

```svelte
<svelte:window on:keydown={onKeydown} on:resize={scheduleVisibleRangeUpdate} />
```

In `updateVisibleRange` (around line 611-634), `gridEl.getBoundingClientRect().top` is already viewport-relative and scroll-container-agnostic — no change needed there. Only `viewportHeight` needs to reflect `.main-column`'s own visible height rather than the whole window (the window is now taller than what's actually visible within the scroll container). Change:

```js
const rect = gridEl.getBoundingClientRect();
const range = visibleRange(boxes, {
  scrollTop: -rect.top,
  viewportHeight: window.innerHeight,
});
```

to:

```js
const rect = gridEl.getBoundingClientRect();
const range = visibleRange(boxes, {
  scrollTop: -rect.top,
  viewportHeight: mainColumnEl.clientHeight,
});
```

In `scrollToSection` (around line 279-285), change:

```js
function scrollToSection(pos) {
  if (!gridEl) return;
  const gridTop = gridEl.getBoundingClientRect().top + window.scrollY;
  const target =
    gridTop + pos.y - topbarHeight - pos.depth * HEADER_HEIGHT + PAD;
  window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}
```

to:

```js
function scrollToSection(pos) {
  if (!gridEl || !mainColumnEl) return;
  const gridTop = gridEl.getBoundingClientRect().top + mainColumnEl.scrollTop;
  const target = gridTop + pos.y - pos.depth * HEADER_HEIGHT + PAD;
  mainColumnEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}
```

In `loadMore` (around line 302-328), change:

```js
const gridHeightBefore = gridEl ? gridEl.getBoundingClientRect().height : 0;
```

(unchanged — this line doesn't reference `window` and stays as-is) and change:

```js
window.scrollBy(0, gridHeightAfter - gridHeightBefore);
```

to:

```js
mainColumnEl.scrollBy(0, gridHeightAfter - gridHeightBefore);
```

(read the surrounding 5-10 lines in the actual file first to confirm this is the only `window.scrollBy` call and that the variable names `gridHeightAfter`/`gridHeightBefore` match exactly before applying — this reconstruction is based on the plan's own earlier-read excerpt of this function, which may have shifted slightly since)

Finally, the section-header's sticky `top` style (around line 917-919), change:

```svelte
class="section-header" style="top:{topbarHeight +
  header.depth * HEADER_HEIGHT}px; z-index:{15 - header.depth};"
```

to:

```svelte
class="section-header" style="top:{header.depth * HEADER_HEIGHT}px; z-index:{15 -
  header.depth};"
```

Verify all of this live in Task 10 — sticky positioning and scroll-container behavior are exactly the class of thing this project's own experience shows can look right in code and still be wrong on screen (see the `live-verify-ui-beyond-review` memory from the previous branch's three-round header-positioning saga).

- [ ] **Step 7: Render placeholder entries in the grid template**

Read the current `{#each visibleItems as { i, entry } (entryDomId(entry))}` loop (search for it) before editing. Add a branch before the existing `<Thumb ... />` for non-placeholder entries. Change:

```svelte
{#each visibleItems as { i, entry } (entryDomId(entry))}
  <!-- (header rendering, unchanged) -->
  <Thumb item={resolvePhoto(entry)} box={boxes[i]} ... />
{/each}
```

to:

```svelte
{#each visibleItems as { i, entry } (entryDomId(entry))}
  <!-- (header rendering, unchanged) -->
  {#if entry.kind === "placeholder"}
    <div
      class="placeholder-row"
      style="top:{boxes[i].y}px; height:{boxes[i].height}px;"
      role="button"
      tabindex="0"
      on:click={() => toggleSectionCollapse(entry.item.path)}
      on:keydown={(e) =>
        e.key === "Enter" && toggleSectionCollapse(entry.item.path)}
    >
      <span class="placeholder-icon">▸</span>
      <span class="placeholder-label">
        {entry.item.path
          .map((p) => formatGroupValue(p.dimension, p.value))
          .join(" / ")}
      </span>
      <span class="placeholder-count">
        {entry.item.count.toLocaleString()} items
      </span>
    </div>
  {:else}
    <Thumb item={resolvePhoto(entry)} box={boxes[i]} ... />
  {/if}
{/each}
```

(the `...` inside `<Thumb ...>` is every existing prop on that element, unchanged — only the `{#if}`/`{:else}` wrapper and the new placeholder branch are added)

Add to the `<style>` block:

```css
.placeholder-row {
  position: absolute;
  left: 0;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  box-sizing: border-box;
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
}
.placeholder-row:hover {
  background: #2a2a2a;
}
.placeholder-count {
  margin-left: auto;
  color: #888;
  font-size: 0.85em;
}
```

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass (this task's changes are Svelte-component-only, covered by the pure-function tests from Tasks 4–7; no new automated tests here, per this file's established no-test convention).

- [ ] **Step 9: Run the build**

Run: `npm run build`
Expected: Builds successfully with no import/syntax errors — this is the first point `TreeSidebar`/`TreeNode` are actually imported and exercised by the Vite module graph.

- [ ] **Step 10: Commit**

```bash
git add ui/src/App.svelte
git commit -m "feat: wire TreeSidebar into App.svelte, render in-place collapsed placeholders, remove topbar-chip mechanism"
```

---

### Task 10: Manual validation against real indexed data

**Files:** none (verification only).

**Interfaces:** none — this task consumes the finished feature end-to-end.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify the tree renders and lazily loads**

Open the app in a browser (or via Playwright/claude-in-chrome per this project's established manual-verification pattern). Confirm: the sidebar shows a "Library" root with a total count matching the real indexed archive's photo count (cross-check against `sqlite3 ~/.autogallery/index.db "SELECT COUNT(*) FROM photos WHERE stale=0;"`). Expand a top-level node — confirm exactly one new network request fires (`/api/tree?...`) and its children appear with their own counts, not a full-tree fetch.

- [ ] **Step 3: Verify collapse now folds in place**

Collapse a section from the tree (plain click). Confirm: the feed shows a folded placeholder row exactly where that section's header used to be (not a chip in the topbar — that mechanism is gone), with the correct count. Confirm clicking the placeholder row re-expands it and its photos reappear (both in the tree and the feed).

- [ ] **Step 4: Verify the two-tier fold**

Expand a folder in the tree, drill into one of its years (so the tree shows a nested year node expanded). Plain-click the folder's fold icon to collapse it — confirm the feed folds the whole folder (already true from collapse-exclusion), then re-expand the folder in the tree and confirm the year you'd drilled into is STILL expanded (state preserved). Repeat, but shift-click to collapse the folder this time — re-expand it and confirm the year now starts collapsed (state reset), per the two-tier fold design.

- [ ] **Step 5: Verify "reveal current location"**

Scroll the feed to some photo, select it, click the "Locate" button. Confirm the tree scrolls/expands to and highlights the exact folder/year/etc. containing that photo, without needing to manually drill in.

- [ ] **Step 6: Verify jump-to-section from the tree**

Click a tree node's label (not its fold icon) for a section far from the current scroll position. Confirm the feed jumps there and shows that section's photos, including correctly folding any ALSO-collapsed sections it scrolls past.

- [ ] **Step 7: Verify scaling behavior**

With a large collapsed section (a whole year with hundreds/thousands of photos, if available in the test archive), confirm via the browser's network tab that collapsing it does not trigger a fetch for its contents, and that scrolling past its placeholder costs nothing beyond the row itself — matching the same guarantee already validated for the previous branch's collapse-exclusion.

- [ ] **Step 8: Check for console errors and update the design doc if any planned detail needed adjustment during implementation**

If manual testing surfaces a real gap in `docs/superpowers/specs/2026-07-06-tree-sidebar-design.md` (e.g. a UX detail that didn't hold up), note it — this project's convention is to fix real bugs found this way immediately, following the same rigor as the previous branch's live-testing-driven fixes (see `.superpowers/sdd/progress.md`'s history for that branch).

- [ ] **Step 9: Stop the dev server**

No commit for this task — it's verification only. Any fixes it surfaces get their own commits under whichever task they belong to (or a follow-up fix task, matching this project's established subagent-driven-development pattern for emergent bugs).
