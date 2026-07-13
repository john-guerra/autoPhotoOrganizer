# Filter Panel + camera/kind grouping (Slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a rating-threshold + orientation filter to the grid, and camera/kind as grouping dimensions, threaded consistently through every feed/boundary/tree query.

**Architecture:** A pure `buildFilter(spec) → {sql, params}` compiler is the single definition of "what's included." Every set-reasoning DB query (`getFeedPage` rows + placeholder counts, `findGroupBoundary`, `getTreeNode`, `getFlatTree`) ANDs the compiled SQL into its existing WHERE. The client sends a validated `filter` JSON query param; a Svelte `FilterPanel` drives it and a filter change resets the feed window the same way a `groupBy` change does.

**Tech Stack:** Node.js + better-sqlite3, Express, Svelte + Vite, vitest.

## Global Constraints

- **ESM everywhere** (`"type": "module"`); plain JS + JSDoc, no TypeScript.
- **Tests: vitest**, colocated as `*.test.js` next to sources.
- **No injection**: orientation names index a hardcoded SQL-fragment table; rating is a bound param. User strings are never interpolated into SQL.
- **Filter spec shape** (canonical): `{ minRating: number 0..5, orientations: string[] ⊆ ["landscape","portrait","square"] }`. `minRating: 0` = off. `orientations` of length 0 or 3 = off (show all); length 1–2 = constrain.
- **Prettier** for formatting; run `npm run format` before final commit if touched files need it.
- Commit after every green task (frequent checkpoints per CLAUDE.md).

---

### Task 1: Filter compiler (`server/db/filters.js`)

**Files:**

- Create: `server/db/filters.js`
- Test: `server/db/filters.test.js`

**Interfaces:**

- Produces: `buildFilter(spec?) → { sql: string, params: any[] }`. Empty/no-op spec returns `{ sql: "1=1", params: [] }`. Also exports `ALLOWED_ORIENTATIONS: string[]`.

- [ ] **Step 1: Write the failing test**

```js
// server/db/filters.test.js
import { describe, it, expect } from "vitest";
import { buildFilter, ALLOWED_ORIENTATIONS } from "./filters.js";

describe("buildFilter", () => {
  it("returns a no-op for an empty spec", () => {
    expect(buildFilter({})).toEqual({ sql: "1=1", params: [] });
    expect(buildFilter()).toEqual({ sql: "1=1", params: [] });
  });

  it("minRating 0 is a no-op; N>0 emits a bound rating clause", () => {
    expect(buildFilter({ minRating: 0 })).toEqual({ sql: "1=1", params: [] });
    const f = buildFilter({ minRating: 4 });
    expect(f.sql).toBe("photos.rating >= ?");
    expect(f.params).toEqual([4]);
  });

  it("all three (or zero) orientations is a no-op", () => {
    expect(buildFilter({ orientations: ALLOWED_ORIENTATIONS })).toEqual({
      sql: "1=1",
      params: [],
    });
    expect(buildFilter({ orientations: [] })).toEqual({
      sql: "1=1",
      params: [],
    });
  });

  it("a strict orientation subset emits a non-null-guarded OR", () => {
    const f = buildFilter({ orientations: ["landscape", "portrait"] });
    expect(f.sql).toBe(
      "photos.width IS NOT NULL AND photos.height IS NOT NULL AND (photos.width > photos.height OR photos.height > photos.width)"
    );
    expect(f.params).toEqual([]);
  });

  it("single orientation: portrait", () => {
    const f = buildFilter({ orientations: ["portrait"] });
    expect(f.sql).toBe(
      "photos.width IS NOT NULL AND photos.height IS NOT NULL AND (photos.height > photos.width)"
    );
  });

  it("combines rating and orientation with AND, rating first", () => {
    const f = buildFilter({ minRating: 5, orientations: ["square"] });
    expect(f.sql).toBe(
      "photos.rating >= ? AND photos.width IS NOT NULL AND photos.height IS NOT NULL AND (photos.width = photos.height)"
    );
    expect(f.params).toEqual([5]);
  });

  it("ignores unknown orientation names", () => {
    const f = buildFilter({ orientations: ["portrait", "bogus"] });
    expect(f.sql).toBe(
      "photos.width IS NOT NULL AND photos.height IS NOT NULL AND (photos.height > photos.width)"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/filters.test.js`
Expected: FAIL — cannot resolve `./filters.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// server/db/filters.js
/**
 * Compiles a filter spec into a SQL fragment + bound params, ANDed into the
 * WHERE of every set-reasoning feed/tree query. The single definition of
 * "what's included," so counts/seeks/grid never disagree. Returns a "1=1"
 * no-op when the spec constrains nothing, so callers can unconditionally
 * splice `AND (${filter.sql})`.
 *
 * Injection-safe: orientation names index a hardcoded fragment table; the
 * rating threshold is a bound param. User-supplied strings never reach SQL.
 *
 * @param {{minRating?: number, orientations?: string[]}} [spec]
 * @returns {{sql: string, params: any[]}}
 */
export function buildFilter(spec = {}) {
  const clauses = [];
  const params = [];

  const minRating = Number(spec?.minRating) || 0;
  if (minRating > 0) {
    clauses.push("photos.rating >= ?");
    params.push(minRating);
  }

  const orientations = Array.isArray(spec?.orientations)
    ? spec.orientations.filter((o) => ORIENTATION_FRAGMENTS[o])
    : [];
  // A strict, non-empty subset constrains; all three (or none) shows all.
  if (
    orientations.length > 0 &&
    orientations.length < ALLOWED_ORIENTATIONS.length
  ) {
    const ors = orientations.map((o) => ORIENTATION_FRAGMENTS[o]).join(" OR ");
    clauses.push(
      `photos.width IS NOT NULL AND photos.height IS NOT NULL AND (${ors})`
    );
  }

  if (!clauses.length) return { sql: "1=1", params: [] };
  return { sql: clauses.join(" AND "), params };
}

const ORIENTATION_FRAGMENTS = {
  landscape: "photos.width > photos.height",
  portrait: "photos.height > photos.width",
  square: "photos.width = photos.height",
};

export const ALLOWED_ORIENTATIONS = ["landscape", "portrait", "square"];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/filters.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/db/filters.js server/db/filters.test.js
git commit -m "feat: filter compiler (rating threshold + orientation)"
```

---

### Task 2: camera + kind grouping dimensions (`server/db/feed.js`)

**Files:**

- Modify: `server/db/feed.js` (the `DIMENSIONS` object, ~lines 11–25)
- Test: `server/db/feed.test.js` (add cases)

**Interfaces:**

- Produces: `DIMENSIONS.camera`, `DIMENSIONS.kind` usable anywhere a groupBy dimension is accepted.

- [ ] **Step 1: Write the failing test**

Add to `server/db/feed.test.js`:

```js
describe("getFeedPage — camera/kind dimensions", () => {
  it("groups by camera, Unknown ('') last under ASC", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b] = upsertScan(db, "/photos/trip", 1, [
      { name: "canon.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "nocam.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET camera = ? WHERE id = ?`).run(
      "Canon R6",
      a.id
    );
    // nocam.jpg keeps camera = NULL → COALESCE '' sorts last in ASC.
    const { items } = getFeedPage(db, { groupBy: ["camera"], after: 10 });
    expect(items.map((i) => i.groupValues.camera)).toEqual(["Canon R6", ""]);
  });

  it("groups by kind", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.mp4", size: 1, mtimeMs: 1, kind: "video" },
    ]);
    const { items } = getFeedPage(db, { groupBy: ["kind"], after: 10 });
    expect(items.map((i) => i.groupValues.kind)).toEqual(["image", "video"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/feed.test.js -t "camera/kind"`
Expected: FAIL — `unknown dimension: camera`.

- [ ] **Step 3: Add the dimensions**

In `server/db/feed.js`, add to the `DIMENSIONS` object (after `day`):

```js
  camera: { expr: "COALESCE(photos.camera, '')", direction: "ASC" },
  kind: { expr: "photos.kind", direction: "ASC" },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/feed.test.js -t "camera/kind"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/db/feed.js server/db/feed.test.js
git commit -m "feat: camera and kind grouping dimensions"
```

---

### Task 3: thread filter into `getFeedPage` (`server/db/feed.js`)

**Files:**

- Modify: `server/db/feed.js` — import `buildFilter`; `countCollapsedPath`, `selectPlaceholders`, `getFeedPage`.
- Test: `server/db/feed.test.js`

**Interfaces:**

- Consumes: `buildFilter` from Task 1.
- Produces: `getFeedPage(db, { ..., filter })` where `filter` is a spec object (default `{}`). Filtered-out rows never appear; placeholder counts reflect the filter.

- [ ] **Step 1: Write the failing test**

Add to `server/db/feed.test.js`:

```js
describe("getFeedPage — filter", () => {
  it("excludes rows below the rating threshold", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b, c] = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(a.id);
    db.prepare(`UPDATE photos SET rating = 3 WHERE id = ?`).run(b.id);
    // c stays rating 0
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      after: 10,
      filter: { minRating: 4 },
    });
    expect(items.map((i) => i.name)).toEqual(["a.jpg"]);
  });

  it("excludes rows by orientation (portrait only)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [land, port] = upsertScan(db, "/photos/trip", 1, [
      { name: "land.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "port.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET width = 400, height = 300 WHERE id = ?`).run(
      land.id
    );
    db.prepare(`UPDATE photos SET width = 300, height = 400 WHERE id = ?`).run(
      port.id
    );
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      after: 10,
      filter: { orientations: ["portrait"] },
    });
    expect(items.map((i) => i.name)).toEqual(["port.jpg"]);
  });

  it("collapsed-placeholder counts reflect the filter", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b] = upsertScan(db, "/photos/aaa", 1, [
      { name: "hi.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "lo.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/bbb", 1, [
      { name: "z.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(a.id);
    // collapse folder /photos/aaa; its placeholder count must be 1 (only hi.jpg), not 2
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      after: 10,
      filter: { minRating: 4 },
      collapsed: [[{ dimension: "folder", value: "/photos/aaa" }]],
    });
    const ph = items.find((i) => i.collapsed);
    expect(ph.count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/feed.test.js -t "getFeedPage — filter"`
Expected: FAIL — filter ignored (all rows returned / count 2).

- [ ] **Step 3: Thread the filter**

In `server/db/feed.js`:

1. Add import at top:

```js
import { buildFilter } from "./filters.js";
```

2. `countCollapsedPath` — add a `filter` param and AND it in:

```js
function countCollapsedPath(db, path, dims, filter) {
  const { sql, params } = collapsedPathCondition(path, dims);
  const positiveSql = sql.replace(/^NOT /, "");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0 AND (${filter.sql}) AND ${positiveSql}`
    )
    .get(...filter.params, ...params);
  return row.count;
}
```

3. `selectPlaceholders` — add `filter` param to its signature (after `limit`) and forward to `countCollapsedPath`:

```js
function selectPlaceholders(
  db,
  collapsed,
  dims,
  focusValues,
  wantAfter,
  realRows,
  limit,
  filter
) {
```

and in its `.map`:

```js
      count: countCollapsedPath(db, path, dims, filter),
```

4. `getFeedPage` — accept `filter` in the options (default `{}`), compile once, splice into `fetchRealRows`, and pass to both `selectPlaceholders` calls:

```js
export function getFeedPage(
  db,
  {
    groupBy,
    collapsed = [],
    focusId = null,
    startPath = null,
    before = 0,
    after = 50,
    filter: filterSpec = {},
  }
) {
  const filter = buildFilter(filterSpec);
```

In `fetchRealRows`, change the query's WHERE and params (the focus-row lookup above stays UNfiltered — it only reads group values to seek from):

```js
         WHERE photos.stale = 0 AND (${filter.sql}) AND (${exclSql}) AND (${seekSql})
         ORDER BY ${orderCols}
         LIMIT ?`
      )
      .all(...filter.params, ...exclParams, ...seekParams, limit);
```

Update the two `selectPlaceholders(...)` calls to pass `filter` as the final arg:

```js
const beforePlaceholders = selectPlaceholders(
  db,
  collapsed,
  dims,
  focusValues,
  false,
  beforeReal,
  before,
  filter
);
const afterPlaceholders = selectPlaceholders(
  db,
  collapsed,
  dims,
  focusValues,
  true,
  afterReal,
  after,
  filter
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/feed.test.js`
Expected: PASS (all existing + 3 new filter tests; default `filter:{}` keeps old tests green).

- [ ] **Step 5: Commit**

```bash
git add server/db/feed.js server/db/feed.test.js
git commit -m "feat: thread filter through getFeedPage rows and placeholder counts"
```

---

### Task 4: thread filter into `findGroupBoundary` (`server/db/feed.js`)

**Files:**

- Modify: `server/db/feed.js` — `findGroupBoundary`.
- Test: `server/db/feed.test.js`

**Interfaces:**

- Produces: `findGroupBoundary(db, { ..., filter })`. Group jumps skip groups with no matching photos.

- [ ] **Step 1: Write the failing test**

```js
describe("findGroupBoundary — filter", () => {
  it("skips a next group that has no photos matching the filter", () => {
    const db = getDb();
    seedVolume(db, 1);
    // three folders; only aaa and ccc have a 5-star photo, bbb has none
    const [a1] = upsertScan(db, "/photos/aaa", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/bbb", 1, [
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const [c1] = upsertScan(db, "/photos/ccc", 1, [
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id IN (?, ?)`).run(
      a1.id,
      c1.id
    );
    const res = findGroupBoundary(db, {
      groupBy: ["folder"],
      focusId: a1.id,
      direction: "next",
      filter: { minRating: 4 },
    });
    // without the filter this would be bbb's b.jpg; with it, ccc's c.jpg
    expect(res.id).toBe(c1.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/feed.test.js -t "findGroupBoundary — filter"`
Expected: FAIL — lands on `b.jpg` (filter ignored).

- [ ] **Step 3: Thread the filter**

In `findGroupBoundary`, accept `filter: filterSpec = {}`, compile, and AND into BOTH queries (the main seek and the `prev` re-seek `firstRow` query). The focus-row lookup stays UNfiltered.

```js
export function findGroupBoundary(
  db,
  { groupBy, collapsed = [], focusId, direction, filter: filterSpec = {} }
) {
  const filter = buildFilter(filterSpec);
```

Main query WHERE + params:

```js
       WHERE photos.stale = 0 AND (${filter.sql}) AND (${exclSql}) AND (${seekSql}) AND (${notCurrentSql})
       ORDER BY ${orderCols}
       LIMIT 1`
    )
    .get(...filter.params, ...exclParams, ...seekParams, ...notCurrentParams);
```

`firstRow` re-seek WHERE + params:

```js
       WHERE photos.stale = 0 AND (${filter.sql}) AND (${matchSql})
       ORDER BY ${forwardOrderCols}
       LIMIT 1`
    )
    .get(...filter.params, ...exclParams, ...matchParams);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/feed.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/db/feed.js server/db/feed.test.js
git commit -m "feat: thread filter through findGroupBoundary"
```

---

### Task 5: thread filter into the tree (`server/db/tree.js`)

**Files:**

- Modify: `server/db/tree.js` — import `buildFilter`; `getTreeNode`, `getFlatTree`.
- Test: `server/db/tree.test.js` (create if absent, else append)

**Interfaces:**

- Produces: `getTreeNode(db, { ..., filter })` and `getFlatTree(db, { ..., filter })`. `total` reflects the filter; groups with zero matching photos are naturally omitted (the WHERE runs before GROUP BY, so empty groups never appear — no explicit hiding needed).

- [ ] **Step 1: Write the failing test**

Create/append `server/db/tree.test.js` (mirror feed.test.js's setup harness — copy the `beforeEach`/`afterEach`/`seedVolume` block):

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getTreeNode, getFlatTree } from "./tree.js";

let cacheDir;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-tree-"));
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

describe("getTreeNode/getFlatTree — filter", () => {
  it("omits groups with no photos matching the filter and filters total", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a1] = upsertScan(db, "/photos/aaa", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/bbb", 1, [
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    db.prepare(`UPDATE photos SET rating = 5 WHERE id = ?`).run(a1.id);

    const node = getTreeNode(db, {
      groupBy: ["folder"],
      filter: { minRating: 4 },
    });
    expect(node.total).toBe(1);
    expect(node.nodes.map((n) => n.value)).toEqual(["/photos/aaa"]);

    const flat = getFlatTree(db, {
      groupBy: ["folder"],
      filter: { minRating: 4 },
    });
    expect(flat.total).toBe(1);
    expect(flat.leaves.map((l) => l.values.folder)).toEqual(["/photos/aaa"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/tree.test.js`
Expected: FAIL — `total` is 2 and both folders appear (filter ignored).

- [ ] **Step 3: Thread the filter**

In `server/db/tree.js`:

1. Change the import line to also import `buildFilter`:

```js
import { resolveDimensions } from "./feed.js";
import { buildFilter } from "./filters.js";
```

2. `getTreeNode(db, { groupBy, path = [], filter: filterSpec = {} })` — compile, then:

- total query:

```js
const filter = buildFilter(filterSpec);
const total = db
  .prepare(
    `SELECT COUNT(*) AS count FROM photos WHERE stale = 0 AND (${filter.sql})`
  )
  .get(...filter.params).count;
```

- nodes query WHERE + params (filter goes first so its params bind first):

```js
const whereSql = ["photos.stale = 0", `(${filter.sql})`, ...prefixClauses].join(
  " AND "
);
const rows = db
  .prepare(
    `SELECT ${nextDim.expr} AS value, COUNT(*) AS count
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE ${whereSql}
       GROUP BY ${nextDim.expr}
       ORDER BY ${nextDim.expr} ${nextDim.direction}`
  )
  .all(...filter.params, ...prefixParams);
```

3. `getFlatTree(db, { groupBy, filter: filterSpec = {} })` — compile, then:

- total query (same pattern as above).
- rows query WHERE + params:

```js
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0 AND (${filter.sql})
       GROUP BY ${groupByCols}
       ORDER BY ${orderByCols}`
    )
    .all(...filter.params);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/tree.test.js server/db/feed.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/db/tree.js server/db/tree.test.js
git commit -m "feat: thread filter through tree node + flat-tree counts"
```

---

### Task 6: API layer — parse/validate `filter` on 4 endpoints (`server/api.js`)

**Files:**

- Modify: `server/api.js` — add `parseFilterParam` helper; use it in `/api/feed`, `/api/feed/boundary`, `/api/tree`, `/api/tree/flat`.
- Test: `server/api.test.js`

**Interfaces:**

- Consumes: `buildFilter`'s spec shape; `ALLOWED_ORIENTATIONS` from `filters.js`.
- Produces: each endpoint accepts `?filter=<JSON>` and forwards a validated spec to the DB layer; returns 400 on malformed filter.

- [ ] **Step 1: Write the failing test**

Look at the top of `server/api.test.js` for how it boots the app (`createApp`/`supertest` or `fetch` against a started server) and mirror that pattern. Add:

```js
describe("/api/feed filter param", () => {
  it("400s on non-JSON filter", async () => {
    // ...GET /api/feed?groupBy=folder&filter=not-json → expect 400
  });
  it("400s on out-of-range minRating", async () => {
    // ...filter={"minRating":9} → expect 400
  });
  it("400s on unknown orientation", async () => {
    // ...filter={"orientations":["diagonal"]} → expect 400
  });
  it("applies a valid rating filter", async () => {
    // seed two photos, one rated 5; GET with filter={"minRating":4}
    // → body.items has only the rated one
  });
});
```

Fill the `// ...` lines using the same request mechanism the existing api tests use (copy an existing `/api/feed` test in this file and adapt). Seed via the same helper existing tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/api.test.js -t "filter param"`
Expected: FAIL — filter currently ignored (200 instead of 400; unfiltered items).

- [ ] **Step 3: Implement the helper + wire 4 endpoints**

Add near the top of `server/api.js` (after imports). Import `ALLOWED_ORIENTATIONS`:

```js
import { ALLOWED_ORIENTATIONS } from "./db/filters.js";

/**
 * Parses + validates the optional `filter` query param into a filter spec.
 * @returns {{spec: object, error?: string}} `error` set ⇒ respond 400.
 */
function parseFilterParam(req) {
  if (!req.query.filter) return { spec: {} };
  let raw;
  try {
    raw = JSON.parse(String(req.query.filter));
  } catch {
    return { spec: {}, error: "filter must be JSON" };
  }
  const spec = {};
  if (raw.minRating !== undefined) {
    const r = Number(raw.minRating);
    if (!Number.isInteger(r) || r < 0 || r > 5) {
      return { spec: {}, error: "minRating must be an integer 0-5" };
    }
    spec.minRating = r;
  }
  if (raw.orientations !== undefined) {
    if (
      !Array.isArray(raw.orientations) ||
      !raw.orientations.every((o) => ALLOWED_ORIENTATIONS.includes(o))
    ) {
      return {
        spec: {},
        error:
          "orientations must be a subset of " + ALLOWED_ORIENTATIONS.join("/"),
      };
    }
    spec.orientations = raw.orientations;
  }
  return { spec };
}
```

In each of the 4 endpoints, right after the existing `groupBy` validation, add:

```js
const { spec: filter, error: filterError } = parseFilterParam(req);
if (filterError) return res.status(400).json({ error: filterError });
```

and pass `filter` into the DB call:

- `/api/feed`: `getFeedPage(db, { groupBy, collapsed, focusId, startPath, before, after, filter })`
- `/api/feed/boundary`: `findGroupBoundary(db, { groupBy, collapsed, focusId, direction, filter })`
- `/api/tree`: `getTreeNode(db, { groupBy, path, filter })`
- `/api/tree/flat`: `getFlatTree(db, { groupBy, filter })`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/api.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/api.js server/api.test.js
git commit -m "feat: accept and validate filter param on feed/boundary/tree endpoints"
```

---

### Task 7: client filter-spec helpers (`ui/src/lib/filterSpec.js`)

**Files:**

- Create: `ui/src/lib/filterSpec.js`
- Test: `ui/src/lib/filterSpec.test.js`

**Interfaces:**

- Produces: `DEFAULT_FILTER`, `isActive(spec) → boolean`, `toQueryParam(spec) → string|null`, `ORIENTATIONS: string[]`.

- [ ] **Step 1: Write the failing test**

```js
// ui/src/lib/filterSpec.js.test — colocated
import { describe, it, expect } from "vitest";
import {
  DEFAULT_FILTER,
  isActive,
  toQueryParam,
  ORIENTATIONS,
} from "./filterSpec.js";

describe("filterSpec", () => {
  it("the default is inactive", () => {
    expect(isActive(DEFAULT_FILTER)).toBe(false);
    expect(toQueryParam(DEFAULT_FILTER)).toBe(null);
  });
  it("rating threshold activates", () => {
    const s = { minRating: 3, orientations: ORIENTATIONS };
    expect(isActive(s)).toBe(true);
    expect(JSON.parse(toQueryParam(s))).toEqual({ minRating: 3 });
  });
  it("a strict orientation subset activates; full set does not", () => {
    expect(isActive({ minRating: 0, orientations: ["portrait"] })).toBe(true);
    expect(isActive({ minRating: 0, orientations: ORIENTATIONS })).toBe(false);
    expect(isActive({ minRating: 0, orientations: [] })).toBe(false);
    expect(
      JSON.parse(toQueryParam({ minRating: 0, orientations: ["portrait"] }))
    ).toEqual({
      orientations: ["portrait"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/lib/filterSpec.test.js`
Expected: FAIL — cannot resolve `./filterSpec.js`.

- [ ] **Step 3: Implement**

```js
// ui/src/lib/filterSpec.js
/** Client-side filter-spec helpers. Mirrors server/db/filters.js semantics:
 * minRating 0 = off; orientations of length 0 or 3 = off. Pure + DOM-free. */

export const ORIENTATIONS = ["landscape", "portrait", "square"];

export const DEFAULT_FILTER = { minRating: 0, orientations: [...ORIENTATIONS] };

/** @param {{minRating?:number, orientations?:string[]}} spec */
export function isActive(spec) {
  const minRating = spec?.minRating ?? 0;
  const o = spec?.orientations ?? [];
  return minRating > 0 || (o.length > 0 && o.length < ORIENTATIONS.length);
}

/** The `filter` query-param JSON string, or null when nothing is constrained.
 * @param {{minRating?:number, orientations?:string[]}} spec */
export function toQueryParam(spec) {
  if (!isActive(spec)) return null;
  const out = {};
  if ((spec.minRating ?? 0) > 0) out.minRating = spec.minRating;
  const o = spec?.orientations ?? [];
  if (o.length > 0 && o.length < ORIENTATIONS.length) out.orientations = o;
  return JSON.stringify(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/lib/filterSpec.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/filterSpec.js ui/src/lib/filterSpec.test.js
git commit -m "feat: client filter-spec helpers (isActive/toQueryParam)"
```

---

### Task 8: thread `filter` into client fetch helpers (`ui/src/lib/api.js`)

**Files:**

- Modify: `ui/src/lib/api.js` — `fetchFeed`, `fetchGroupBoundary`, `fetchTreeNode`, `fetchFlatTree`.

**Interfaces:**

- Consumes: `toQueryParam` from Task 7.
- Produces: each helper accepts an optional `filter` (a spec object); appends `filter=<json>` only when active.

- [ ] **Step 1: Add the import and thread the param**

At the top of `ui/src/lib/api.js`:

```js
import { toQueryParam } from "./filterSpec.js";
```

In each of the four helpers, add `filter = null` to the destructured options and, after the existing `params` are built (before the `fetch`), add:

```js
const fp = filter ? toQueryParam(filter) : null;
if (fp) params.set("filter", fp);
```

For `fetchFlatTree(groupBy)` (positional arg), change its signature to `fetchFlatTree(groupBy, filter = null)` and apply the same two lines.

- [ ] **Step 2: Verify nothing is broken**

Run: `npx vitest run ui/src/lib`
Expected: PASS (existing ui lib tests unaffected — new param is optional).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/api.js
git commit -m "feat: pass active filter to feed/boundary/tree fetch helpers"
```

---

### Task 9: FilterPanel component (`ui/src/lib/FilterPanel.svelte`)

**Files:**

- Create: `ui/src/lib/FilterPanel.svelte`

**Interfaces:**

- Consumes: `DEFAULT_FILTER`, `ORIENTATIONS`, `isActive` from `filterSpec.js`.
- Produces: a component with `export let filter` and a `change` event (`detail: newSpec`). A `Filter ▾` button opens a popover with a rating segmented control (`Any · ≥1..≥5`) and three orientation toggle chips + Clear. Shows an active dot when `isActive(filter)`.

- [ ] **Step 1: Implement the component**

```svelte
<script>
  import { createEventDispatcher } from "svelte";
  import { DEFAULT_FILTER, ORIENTATIONS, isActive } from "./filterSpec.js";

  export let filter = { ...DEFAULT_FILTER };
  const dispatch = createEventDispatcher();
  let open = false;

  const RATINGS = [0, 1, 2, 3, 4, 5];
  const ORIENTATION_LABELS = {
    landscape: "Landscape",
    portrait: "Portrait",
    square: "Square",
  };

  $: active = isActive(filter);

  function emit(next) {
    filter = next;
    dispatch("change", next);
  }
  function setRating(r) {
    emit({ ...filter, minRating: r });
  }
  function toggleOrientation(o) {
    const set = new Set(filter.orientations ?? []);
    set.has(o) ? set.delete(o) : set.add(o);
    emit({ ...filter, orientations: ORIENTATIONS.filter((x) => set.has(x)) });
  }
  function clearAll() {
    emit({ ...DEFAULT_FILTER });
  }
  const has = (o) => (filter.orientations ?? []).includes(o);
</script>

<div class="filter">
  <button
    class="filter-toggle"
    class:active
    on:click={() => (open = !open)}
    title="Filter photos"
  >
    Filter{#if active}<span class="dot" aria-label="filter active"></span>{/if} ▾
  </button>
  {#if open}
    <div class="filter-panel">
      <div class="row">
        <span class="label">Rating</span>
        <div class="segmented" role="group" aria-label="Minimum rating">
          {#each RATINGS as r}
            <button
              class="seg"
              class:on={(filter.minRating ?? 0) === r}
              on:click={() => setRating(r)}>{r === 0 ? "Any" : `≥${r}`}</button
            >
          {/each}
        </div>
      </div>
      <div class="row">
        <span class="label">Orientation</span>
        <div class="chips">
          {#each ORIENTATIONS as o}
            <button
              class="chip"
              class:on={has(o)}
              on:click={() => toggleOrientation(o)}
            >
              {ORIENTATION_LABELS[o]}
            </button>
          {/each}
        </div>
      </div>
      <div class="row end">
        <button class="clear" on:click={clearAll} disabled={!active}
          >Clear</button
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .filter {
    position: relative;
    display: inline-block;
  }
  .filter-toggle {
    background: #101010;
    border: 1px solid #333;
    color: #cfcfcf;
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .filter-toggle.active {
    border-color: #4c9aff;
    color: #fff;
  }
  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin: 0 4px;
    background: #4c9aff;
    border-radius: 50%;
    vertical-align: middle;
  }
  .filter-panel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 50;
    background: #0d0d0d;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 12px;
    min-width: 260px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row.end {
    align-items: flex-end;
  }
  .label {
    font-size: 0.72rem;
    color: #8a8a8a;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .segmented {
    display: flex;
    gap: 2px;
    background: #101010;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px;
  }
  .seg {
    flex: 1;
    border: none;
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 0.78rem;
    cursor: pointer;
    background: transparent;
    color: #9a9a9a;
  }
  .seg.on {
    background: #4c9aff;
    color: #06121f;
    font-weight: 600;
  }
  .chips {
    display: flex;
    gap: 6px;
  }
  .chip {
    border: 1px solid #333;
    border-radius: 999px;
    padding: 4px 12px;
    font-size: 0.78rem;
    cursor: pointer;
    background: transparent;
    color: #9a9a9a;
  }
  .chip.on {
    background: #4c9aff;
    color: #06121f;
    border-color: #4c9aff;
    font-weight: 600;
  }
  .clear {
    background: transparent;
    border: 1px solid #444;
    color: #cfcfcf;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .clear:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Vite build succeeds (component compiles).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/FilterPanel.svelte
git commit -m "feat: FilterPanel component (rating + orientation popover)"
```

---

### Task 10: wire filter into App.svelte

**Files:**

- Modify: `ui/src/App.svelte`

**Interfaces:**

- Consumes: `FilterPanel`, `DEFAULT_FILTER`, `isActive` from Tasks 7/9; the `filter`-aware fetch helpers from Task 8.

**Read first:** before editing, read `ui/src/App.svelte` around the `groupBy` state (lines ~95–115), `onGroupByChange` and the feed-reset/reload it triggers (~270–360), and every fetch call site (`grep -n "fetchFeed\|fetchGroupBoundary\|fetchTreeNode\|fetchFlatTree" ui/src/App.svelte`). The filter must ride along on **every** one of those calls, exactly like `groupBy` does.

- [ ] **Step 1: Add state + persistence + dimensions**

Near the `groupBy` block:

```js
import FilterPanel from "./lib/FilterPanel.svelte";
import {
  DEFAULT_FILTER,
  isActive as filterIsActive,
} from "./lib/filterSpec.js";

const LS_FILTER = "autogallery.filter";
let filter = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(LS_FILTER) ?? "null");
    if (stored && typeof stored === "object")
      return { ...DEFAULT_FILTER, ...stored };
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_FILTER };
})();
$: localStorage.setItem(LS_FILTER, JSON.stringify(filter));
```

And extend `ALL_DIMENSIONS`:

```js
const ALL_DIMENSIONS = ["folder", "year", "month", "day", "camera", "kind"];
```

- [ ] **Step 2: Thread `filter` into every fetch call**

At each `fetchFeed({...})`, `fetchGroupBoundary({...})`, `fetchTreeNode({...})` call, add `filter` to the options object. At each `fetchFlatTree(groupBy)` call, change to `fetchFlatTree(groupBy, filter)`. (Use the grep from "Read first" to find them all — there are several across loadInitialFeed, loadMore, jumpGroupBoundary, loadHeaderCounts, and the fisheye/tree data load.)

- [ ] **Step 3: Add the change handler (reset the feed like a groupBy change)**

Mirror whatever `onGroupByChange` does to reset the window and reload from the current focus. Add:

```js
function onFilterChange(next) {
  filter = next;
  // If the currently-selected photo still passes the filter, keep it as the
  // reload focus; otherwise reload from the top of the current hierarchy.
  const focusId = filterIsActive(filter)
    ? currentFocusIdIfStillMatching()
    : selectedPhotoId();
  reloadFeed(focusId); // ← use the same reset/reload path onGroupByChange uses
}
```

Concretely: match `onGroupByChange`'s body — reset `items`, bump `feedEpoch`/`countsEpoch`, clear `headerCounts`/`fetchedParents`, and call the initial-feed loader. The simplest correct behavior for v1: **reload from the top of the current hierarchy** (do not attempt focus preservation) — pass no `focusId`. Preserving focus is a nice-to-have; if `onGroupByChange` already preserves focus, reuse that; otherwise top-reload is acceptable and honest. Do NOT hand-roll a new `fetchingBefore/fetchingAfter/feedEpoch` guard block — route through the existing loader (CLAUDE.md rule).

- [ ] **Step 4: Mount the panel in the topbar**

In the `<header class="topbar">`, next to the `group-by` selector:

```svelte
<FilterPanel {filter} on:change={(e) => onFilterChange(e.detail)} />
```

- [ ] **Step 5: Verify build + unit tests**

Run: `npm run build && npm test`
Expected: build succeeds; all vitest suites pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.svelte
git commit -m "feat: wire filter panel + camera/kind dims into the grid"
```

---

### Task 11: Live browser verification

**Files:** none (verification only). Required by CLAUDE.md — this touches feed-window ordering/state, so a passing suite is not sufficient.

- [ ] **Step 1: Start the app**

Run: `npm run dev` (Express :4321 + Vite :5173).

- [ ] **Step 2: Verify orientation classification on real photos**

Scan a real test folder (see `docs/TEST_FOLDERS.local.md`). Set Orientation → Portrait only. Confirm only portrait-shaped photos remain, using a folder known to contain rotated-portrait shots (Canon/Pixel). **This is the metaCache-normalization check from the spec** — if landscape photos leak into a portrait filter, stop and investigate width/height normalization before proceeding.

- [ ] **Step 3: Verify rating threshold + counts consistency**

Rate a handful of photos, set Rating → ≥4. Confirm: the grid shows only ≥4 photos; section-header counts match the visible count per group; the tree sidebar hides groups with no ≥4 photos.

- [ ] **Step 4: Verify group-jump under filter**

With a filter active, Option+←/→ to jump groups. Confirm jumps land on real matching photos and never on an empty/filtered-out section.

- [ ] **Step 5: Verify camera/kind grouping**

Add `camera` then `kind` as grouping levels via the group-by picker. Confirm sections form per camera/kind and counts are correct. Combine with a filter and confirm consistency.

- [ ] **Step 6: Verify persistence**

Reload the page. Confirm the filter and grouping survive (localStorage).

- [ ] **Step 7: Record result**

If all pass, note it in the PR/commit. If anything fails, use superpowers:systematic-debugging (check the raw `/api/feed?...&filter=...` response before any client-side theory — CLAUDE.md debugging discipline).

---

## Self-Review notes

- **Spec coverage**: filter compiler (T1), camera/kind dims (T2), threading feed rows+counts (T3), boundary (T4), tree+hide-empty (T5), API validate (T6), client spec (T7), client api (T8), UI panel (T9), wiring+persistence+reset (T10), live verify incl. orientation-normalization + zero-count checks (T11). All spec sections mapped.
- **Empty-group hiding** is automatic: the filter WHERE runs before GROUP BY, so tree queries never emit zero-count groups (no explicit hiding code — noted in T5).
- **Injection**: orientation → hardcoded fragments, rating → bound param, API validates shape (T1/T6).
- **No duplicated guard pattern**: T10 Step 3 explicitly routes reload through the existing loader, not a new `fetchingBefore/After/feedEpoch` copy.
