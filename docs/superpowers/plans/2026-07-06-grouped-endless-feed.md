# Grouped Endless Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-folder grid with a continuous, cross-folder,
groupable feed backed by composite keyset pagination against the SQLite
index, with collapsible section headers and collapse-aware fetching.

**Architecture:** New `server/db/feed.js` maps an ordered grouping
hierarchy (`folder`/`year`/`month`/`day`) onto SQL expressions, builds a
composite `ORDER BY`, excludes collapsed sections from the query, and
implements keyset pagination (before/after a focus photo id) using the
standard multi-column "seek" expansion. A new `GET /api/feed` endpoint
exposes this. The frontend gets a pure `ui/src/lib/feed.js` (window
merging + section-boundary derivation, same shape as the existing
`displayEntries.js`/`bursts.js`), and `App.svelte` swaps its
"one big scan response" model for a growing/sliding fetched window,
adding a drag-orderable hierarchy selector (`multi-auto-select` +
`sortablejs`) and collapsible sticky section headers.

**Tech Stack:** Node.js (ESM), Express, better-sqlite3, Svelte, vitest,
`multi-auto-select` + `sortablejs` (new frontend deps).

## Global Constraints

- ESM everywhere (`"type": "module"`) — no TypeScript.
- No comments explaining _what_ code does; only non-obvious _why_.
- Every test is colocated as `*.test.js` next to its source, vitest.
- Real photo folders (`docs/TEST_FOLDERS.local.md`) are strictly
  read-only — tests use synthetic temp fixtures only; only the final
  manual-validation task touches real (already-indexed) data, read-only.
- `photos.taken_at` is nullable, stored as epoch **milliseconds**.
- `node >=22`.

---

## Task 1: Composite ordering, collapse-exclusion, and keyset pagination

**Files:**

- Create: `server/db/feed.js`
- Test: `server/db/feed.test.js`

**Interfaces:**

- Produces: `DIMENSIONS: Record<string, {expr: string, direction: 'ASC'|'DESC'}>`,
  `getFeedPage(db, {groupBy: string[], collapsed?: Array<Array<{dimension:string, value:string}>>, focusId?: number|null, before?: number, after?: number}): {items: Array<{id, name, size, mtimeMs, rating, preferredCover, width, height, takenAt, groupValues: Record<string,string>}>}`
  — consumed by Task 2 (adds `sections`) and Task 3 (the API endpoint).

- [ ] **Step 1: Write the failing tests**

Create `server/db/feed.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, _resetDbForTest } from "./connection.js";
import { upsertScan } from "./photos.js";
import { getFeedPage } from "./feed.js";

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

describe("getFeedPage — composite ordering", () => {
  it("orders by folder ascending when groupBy is ['folder']", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "y.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, { groupBy: ["folder"], after: 10 });
    expect(items.map((i) => i.groupValues.folder)).toEqual([
      "/photos/a-folder",
      "/photos/b-folder",
    ]);
  });

  it("orders by year descending (newest first) within groupBy ['year']", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [a, b] = upsertScan(db, "/photos/trip", 1, [
      { name: "old.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "new.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, a.id, "2020-01-01T00:00:00.000Z");
    setTakenAt(db, b.id, "2024-01-01T00:00:00.000Z");
    const { items } = getFeedPage(db, { groupBy: ["year"], after: 10 });
    expect(items.map((i) => i.groupValues.year)).toEqual(["2024", "2020"]);
  });

  it("sorts photos with no taken_at into an Unknown bucket, last", () => {
    const db = getDb();
    seedVolume(db, 1);
    const [known, unknown] = upsertScan(db, "/photos/trip", 1, [
      { name: "known.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "unknown.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, known.id, "2020-01-01T00:00:00.000Z");
    // unknown.jpg keeps taken_at = NULL.
    const { items } = getFeedPage(db, { groupBy: ["year"], after: 10 });
    expect(items.map((i) => i.name)).toEqual(["known.jpg", "unknown.jpg"]);
    expect(items[1].groupValues.year).toBe("");
  });

  it("applies multiple levels outermost-first, mixed directions", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rowsA = upsertScan(db, "/photos/b-folder", 1, [
      { name: "x.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const rowsB = upsertScan(db, "/photos/a-folder", 1, [
      { name: "y.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, rowsA[0].id, "2020-01-01T00:00:00.000Z");
    setTakenAt(db, rowsB[0].id, "2024-01-01T00:00:00.000Z");
    // year DESC first (2024 before 2020), folder ASC within a tied year
    // never applies here since years differ — this proves level ORDER
    // (year outranks folder), not a tie-break.
    const { items } = getFeedPage(db, {
      groupBy: ["year", "folder"],
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["y.jpg", "x.jpg"]);
  });
});

describe("getFeedPage — collapse-exclusion", () => {
  it("excludes photos whose prefix matches a collapsed path", () => {
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
    expect(items.map((i) => i.name)).toEqual(["b1.jpg"]);
  });
});

describe("getFeedPage — keyset pagination", () => {
  it("fetches the first N rows when no focusId is given", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { items } = getFeedPage(db, { groupBy: ["folder"], after: 2 });
    expect(items.map((i) => i.name)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("fetches rows after a focusId, in order", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const focus = rows.find((r) => r.name === "a.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      focusId: focus.id,
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["b.jpg", "c.jpg"]);
  });

  it("fetches rows before a focusId, in order (not reversed)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const focus = rows.find((r) => r.name === "c.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      focusId: focus.id,
      before: 10,
      after: 0,
    });
    expect(items.map((i) => i.name)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("fetches both before and after a focusId in one call", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "b.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "c.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "d.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const focus = rows.find((r) => r.name === "b.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["folder"],
      focusId: focus.id,
      before: 1,
      after: 10,
    });
    expect(items.map((i) => i.name)).toEqual(["a.jpg", "c.jpg", "d.jpg"]);
  });

  it("respects mixed-direction ordering when seeking (year DESC)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const rows = upsertScan(db, "/photos/trip", 1, [
      { name: "y2024.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "y2022.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "y2020.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, rows[0].id, "2024-01-01T00:00:00.000Z");
    setTakenAt(db, rows[1].id, "2022-01-01T00:00:00.000Z");
    setTakenAt(db, rows[2].id, "2020-01-01T00:00:00.000Z");
    const middleFocus = rows.find((r) => r.name === "y2022.jpg");
    const { items } = getFeedPage(db, {
      groupBy: ["year"],
      focusId: middleFocus.id,
      after: 10,
    });
    // "after" in year-DESC order means an EARLIER year.
    expect(items.map((i) => i.name)).toEqual(["y2020.jpg"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/db/feed.test.js`
Expected: FAIL with "Cannot find module './feed.js'".

- [ ] **Step 3: Write the implementation**

Create `server/db/feed.js`:

```js
/**
 * Grouping dimensions available to the feed. Each maps to a plain SQL
 * expression over `photos`/`folders` — no new columns. Date dimensions
 * fall back to an empty string (not a real value) for NULL `taken_at`,
 * because an empty string sorts before every real value in both ASC and
 * DESC comparisons for the string data these expressions produce — the
 * cheapest way to force "unknown date" to the end of a DESC-ordered feed
 * without a separate null-flag sort key. `formatGroupValue` (frontend,
 * Task 4) turns "" back into the "Unknown" label for display.
 */
export const DIMENSIONS = {
  folder: { expr: "folders.abs_path", direction: "ASC" },
  year: {
    expr: "COALESCE(strftime('%Y', photos.taken_at / 1000, 'unixepoch'), '')",
    direction: "DESC",
  },
  month: {
    expr: "COALESCE(strftime('%Y-%m', photos.taken_at / 1000, 'unixepoch'), '')",
    direction: "DESC",
  },
  day: {
    expr: "COALESCE(strftime('%Y-%m-%d', photos.taken_at / 1000, 'unixepoch'), '')",
    direction: "DESC",
  },
};

/** @param {string[]} groupBy @returns {Array<{name:string, expr:string, direction:string}>} */
function resolveDimensions(groupBy) {
  return groupBy.map((name) => {
    const dim = DIMENSIONS[name];
    if (!dim) throw new Error(`unknown dimension: ${name}`);
    return { name, ...dim };
  });
}

/**
 * @param {Array<{dimension:string, value:string}>} path
 * @param {Array<{name:string, expr:string}>} dims
 * @returns {{sql:string, params:any[]}}
 */
function collapsedPathCondition(path, dims) {
  const clauses = [];
  const params = [];
  for (const { dimension, value } of path) {
    const dim = dims.find((d) => d.name === dimension);
    if (!dim) {
      throw new Error(
        `collapsed path references unknown dimension: ${dimension}`
      );
    }
    clauses.push(`${dim.expr} = ?`);
    params.push(value);
  }
  return { sql: `NOT (${clauses.join(" AND ")})`, params };
}

/**
 * @param {Array<Array<{dimension:string, value:string}>>} collapsedPaths
 * @param {Array<{name:string, expr:string}>} dims
 * @returns {{sql:string, params:any[]}}
 */
function exclusionClause(collapsedPaths, dims) {
  if (!collapsedPaths.length) return { sql: "1=1", params: [] };
  const parts = [];
  const params = [];
  for (const path of collapsedPaths) {
    const { sql, params: p } = collapsedPathCondition(path, dims);
    parts.push(sql);
    params.push(...p);
  }
  return { sql: parts.join(" AND "), params };
}

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

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string, value:string}>>, focusId?: number|null, before?: number, after?: number}} opts
 */
export function getFeedPage(
  db,
  { groupBy, collapsed = [], focusId = null, before = 0, after = 50 }
) {
  const dims = resolveDimensions(groupBy);
  const seekDims = [
    ...dims,
    { name: "__id", expr: "photos.id", direction: "ASC" },
  ];
  const selectDimCols = dims.map((d, i) => `${d.expr} AS dim${i}`).join(", ");
  const { sql: exclSql, params: exclParams } = exclusionClause(collapsed, dims);

  let focusValues = null;
  if (focusId != null) {
    const focusRow = db
      .prepare(
        `SELECT ${selectDimCols}, photos.id
         FROM photos JOIN folders ON folders.id = photos.folder_id
         WHERE photos.id = ?`
      )
      .get(focusId);
    if (!focusRow) throw new Error(`focusId ${focusId} not found`);
    focusValues = dims.map((_, i) => focusRow[`dim${i}`]).concat(focusRow.id);
  }

  function fetchDirection(wantAfter, limit) {
    if (!limit) return [];
    let seekSql = "1=1";
    let seekParams = [];
    if (focusValues) {
      const seek = seekCondition(seekDims, focusValues, wantAfter);
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

  const beforeItems = fetchDirection(false, before);
  const afterItems = fetchDirection(true, after);
  return { items: [...beforeItems, ...afterItems] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/feed.test.js`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add server/db/feed.js server/db/feed.test.js
git commit -m "feat: add composite grouping, collapse-exclusion, and keyset pagination for the feed"
```

---

## Task 2: Collapsed-section summary counts

**Files:**

- Modify: `server/db/feed.js`
- Test: `server/db/feed.test.js`

**Interfaces:**

- Consumes: `DIMENSIONS`, `resolveDimensions` (module-private, Task 1 — this
  task adds a new module-level function in the same file, so it can reuse
  the private helper directly).
- Produces: `getFeedPage` now also returns `sections: Array<{path: Array<{dimension:string, value:string}>, count: number}>` — consumed by Task 3 (API endpoint) and Task 4 (frontend rendering).

- [ ] **Step 1: Write the failing test**

Add to `server/db/feed.test.js` (new `describe` block, after the existing
"keyset pagination" block):

```js
describe("getFeedPage — collapsed section summaries", () => {
  it("returns a count for each collapsed path", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/a-folder", 1, [
      { name: "a1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "a2.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/b-folder", 1, [
      { name: "b1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { sections } = getFeedPage(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/a-folder" }]],
      after: 10,
    });
    expect(sections).toEqual([
      {
        path: [{ dimension: "folder", value: "/photos/a-folder" }],
        count: 2,
      },
    ]);
  });

  it("returns an empty sections array when nothing is collapsed", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/trip", 1, [
      { name: "a.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const { sections } = getFeedPage(db, { groupBy: ["folder"], after: 10 });
    expect(sections).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/feed.test.js`
Expected: FAIL — `sections` is `undefined`.

- [ ] **Step 3: Add the implementation**

In `server/db/feed.js`, add this function (place it after `exclusionClause`,
before `cmpOp`):

```js
/**
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy: string[], collapsed: Array<Array<{dimension:string, value:string}>>}} opts
 * @returns {Array<{path: Array<{dimension:string, value:string}>, count: number}>}
 */
function getCollapsedSummaries(db, { groupBy, collapsed }) {
  const dims = resolveDimensions(groupBy);
  return collapsed.map((path) => {
    const { sql, params } = collapsedPathCondition(path, dims);
    const positiveSql = sql.replace(/^NOT /, "");
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM photos JOIN folders ON folders.id = photos.folder_id
         WHERE photos.stale = 0 AND ${positiveSql}`
      )
      .get(...params);
    return { path, count: row.count };
  });
}
```

Then update `getFeedPage`'s return statement (the last line of the
function) from:

```js
return { items: [...beforeItems, ...afterItems] };
```

to:

```js
const sections = getCollapsedSummaries(db, { groupBy, collapsed });
return { items: [...beforeItems, ...afterItems], sections };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/db/feed.test.js`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add server/db/feed.js server/db/feed.test.js
git commit -m "feat: add collapsed-section count summaries to the feed query"
```

---

## Task 3: `GET /api/feed` endpoint

**Files:**

- Modify: `server/api.js`
- Modify: `server/api.test.js`

**Interfaces:**

- Consumes: `getFeedPage` (Task 2), `getDb` (already imported in `api.js`).
- Produces: `GET /api/feed` HTTP contract — consumed by Task 5
  (`ui/src/lib/api.js`'s `fetchFeed`).

- [ ] **Step 1: Write the failing tests**

Add to `server/api.test.js` (new `describe` block; place it after the
existing `describe("GET /api/library", ...)` block, at the end of the
file):

```js
describe("GET /api/feed", () => {
  it("returns items grouped by folder by default order, with group values", async () => {
    await scan(srv.base, photosDir);
    const res = await fetch(`${srv.base}/api/feed?groupBy=folder&after=50`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toHaveProperty("groupValues.folder");
    expect(body.sections).toEqual([]);
  });

  it("supports focusId + before/after keyset pagination", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const ids = scanBody.items.map((i) => i.id).sort((a, b) => a - b);
    const midId = ids[Math.floor(ids.length / 2)];
    const res = await fetch(
      `${srv.base}/api/feed?groupBy=folder&focusId=${midId}&before=1&after=1`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.id !== midId)).toBe(true);
  });

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

  it("400s on an unknown groupBy dimension", async () => {
    const res = await fetch(`${srv.base}/api/feed?groupBy=bogus&after=10`);
    expect(res.status).toBe(400);
  });

  it("400s when groupBy is missing", async () => {
    const res = await fetch(`${srv.base}/api/feed`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/api.test.js`
Expected: FAIL — `GET /api/feed` 404s (route doesn't exist yet).

- [ ] **Step 3: Add the endpoint**

In `server/api.js`, add this import alongside the existing ones:

```js
import { getFeedPage, DIMENSIONS } from "./db/feed.js";
```

Then add this route inside `registerApi(app)`, after the `GET /api/library`
route (the last route in the function, right before the function's closing
`}`):

```js
// --- Grouped endless feed --------------------------------------------------
app.get("/api/feed", (req, res) => {
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

  let collapsed = [];
  if (req.query.collapsed) {
    try {
      collapsed = JSON.parse(String(req.query.collapsed));
    } catch {
      return res.status(400).json({ error: "collapsed must be JSON" });
    }
  }

  const focusIdParam = req.query.focusId;
  const focusId =
    focusIdParam !== undefined && focusIdParam !== ""
      ? Number(focusIdParam)
      : null;
  const before = Math.max(0, Number(req.query.before) || 0);
  const after = Math.max(0, Number(req.query.after) || 50);

  const db = getDb();
  try {
    const { items, sections } = getFeedPage(db, {
      groupBy,
      collapsed,
      focusId,
      before,
      after,
    });
    res.json({ items, sections });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/api.test.js`
Expected: All tests pass (existing ones + 5 new `GET /api/feed` tests).

- [ ] **Step 5: Commit**

```bash
git add server/api.js server/api.test.js
git commit -m "feat: add GET /api/feed endpoint"
```

---

## Task 4: Frontend feed window logic (pure functions)

**Files:**

- Create: `ui/src/lib/feed.js`
- Test: `ui/src/lib/feed.test.js`

**Interfaces:**

- Produces: `formatGroupValue(dimension: string, value: string): string`,
  `mergeFeedPage(window: FeedWindow, page: {items: object[]}, direction: 'before'|'after'): FeedWindow`,
  `deriveSectionHeaders(items: object[], groupBy: string[]): Array<{index: number, depth: number, dimension: string, value: string, label: string}>`
  where `FeedWindow = {items: object[], hasMoreBefore: boolean, hasMoreAfter: boolean}`
  — consumed by Task 6 (`App.svelte` integration).

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/feed.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  formatGroupValue,
  mergeFeedPage,
  deriveSectionHeaders,
} from "./feed.js";

describe("formatGroupValue", () => {
  it("maps the empty-string sentinel to 'Unknown'", () => {
    expect(formatGroupValue("year", "")).toBe("Unknown");
  });

  it("passes through a real value unchanged", () => {
    expect(formatGroupValue("year", "2024")).toBe("2024");
    expect(formatGroupValue("folder", "/photos/trip")).toBe("/photos/trip");
  });
});

describe("mergeFeedPage", () => {
  const EMPTY = { items: [], hasMoreBefore: true, hasMoreAfter: true };

  it("appends an 'after' page and flags exhaustion when it's short", () => {
    const win = mergeFeedPage(
      { items: [{ id: 1 }], hasMoreBefore: false, hasMoreAfter: true },
      { items: [{ id: 2 }, { id: 3 }] },
      "after",
      2 // requested count
    );
    expect(win.items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(win.hasMoreAfter).toBe(true); // got exactly what was requested
  });

  it("flags hasMoreAfter false when a page returns fewer than requested", () => {
    const win = mergeFeedPage(EMPTY, { items: [{ id: 1 }] }, "after", 5);
    expect(win.hasMoreAfter).toBe(false);
  });

  it("prepends a 'before' page and flags exhaustion when it's short", () => {
    const win = mergeFeedPage(
      { items: [{ id: 3 }], hasMoreBefore: true, hasMoreAfter: false },
      { items: [{ id: 1 }, { id: 2 }] },
      "before",
      5
    );
    expect(win.items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(win.hasMoreBefore).toBe(false); // 2 < requested 5
  });

  it("never introduces a duplicate id across merges", () => {
    const win = mergeFeedPage(
      {
        items: [{ id: 1 }, { id: 2 }],
        hasMoreBefore: false,
        hasMoreAfter: true,
      },
      { items: [{ id: 2 }, { id: 3 }] }, // id 2 overlaps
      "after",
      2
    );
    expect(win.items.map((i) => i.id)).toEqual([1, 2, 3]);
  });
});

describe("deriveSectionHeaders", () => {
  const ITEMS = [
    { id: 1, groupValues: { year: "2024", folder: "/a" } },
    { id: 2, groupValues: { year: "2024", folder: "/a" } },
    { id: 3, groupValues: { year: "2024", folder: "/b" } },
    { id: 4, groupValues: { year: "2020", folder: "/a" } },
  ];

  it("emits a header at every level boundary, outermost first", () => {
    const headers = deriveSectionHeaders(ITEMS, ["year", "folder"]);
    expect(headers).toEqual([
      { index: 0, depth: 0, dimension: "year", value: "2024", label: "2024" },
      { index: 0, depth: 1, dimension: "folder", value: "/a", label: "/a" },
      { index: 2, depth: 1, dimension: "folder", value: "/b", label: "/b" },
      { index: 3, depth: 0, dimension: "year", value: "2020", label: "2020" },
      { index: 3, depth: 1, dimension: "folder", value: "/a", label: "/a" },
    ]);
  });

  it("returns an empty array for an empty item list", () => {
    expect(deriveSectionHeaders([], ["folder"])).toEqual([]);
  });

  it("uses formatGroupValue for the label (Unknown bucket)", () => {
    const headers = deriveSectionHeaders(
      [{ id: 1, groupValues: { year: "" } }],
      ["year"]
    );
    expect(headers[0].label).toBe("Unknown");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run ui/src/lib/feed.test.js`
Expected: FAIL with "Cannot find module './feed.js'".

- [ ] **Step 3: Write the implementation**

Create `ui/src/lib/feed.js`:

```js
/**
 * Pure feed-window logic: no DOM, no Svelte, no fetch. Same shape as
 * displayEntries.js/bursts.js — App.svelte composes these.
 */

/** @param {string} dimension @param {string} value @returns {string} */
export function formatGroupValue(_dimension, value) {
  return value === "" ? "Unknown" : value;
}

/**
 * @typedef {{items: object[], hasMoreBefore: boolean, hasMoreAfter: boolean}} FeedWindow
 */

/**
 * @param {FeedWindow} window
 * @param {{items: object[]}} page
 * @param {'before'|'after'} direction
 * @param {number} requestedCount how many were asked for in this direction
 * @returns {FeedWindow}
 */
export function mergeFeedPage(window, page, direction, requestedCount) {
  const existingIds = new Set(window.items.map((i) => i.id));
  const fresh = page.items.filter((i) => !existingIds.has(i.id));
  const items =
    direction === "after"
      ? [...window.items, ...fresh]
      : [...fresh, ...window.items];
  const gotFullPage = page.items.length >= requestedCount;
  return {
    items,
    hasMoreBefore: direction === "before" ? gotFullPage : window.hasMoreBefore,
    hasMoreAfter: direction === "after" ? gotFullPage : window.hasMoreAfter,
  };
}

/**
 * Walks the loaded, already-ordered item array and emits one header per
 * grouping-level boundary, outermost dimension first — mirroring how a
 * change at an outer level always implies every inner level "restarts"
 * (matches server/db/feed.js's ORDER BY: outer dimensions partition the
 * whole array into contiguous runs, inner dimensions partition within).
 * @param {Array<{groupValues: Record<string,string>}>} items
 * @param {string[]} groupBy
 * @returns {Array<{index:number, depth:number, dimension:string, value:string, label:string}>}
 */
export function deriveSectionHeaders(items, groupBy) {
  const headers = [];
  const lastSeen = new Array(groupBy.length).fill(undefined);
  items.forEach((item, index) => {
    let changedAbove = false;
    groupBy.forEach((dimension, depth) => {
      const value = item.groupValues[dimension];
      if (changedAbove || value !== lastSeen[depth]) {
        lastSeen[depth] = value;
        changedAbove = true;
        headers.push({
          index,
          depth,
          dimension,
          value,
          label: formatGroupValue(dimension, value),
        });
      }
    });
  });
  return headers;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ui/src/lib/feed.test.js`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/feed.js ui/src/lib/feed.test.js
git commit -m "feat: add pure feed-window merge and section-header derivation logic"
```

---

## Task 5: Frontend `fetchFeed` API client

**Files:**

- Modify: `ui/src/lib/api.js`

**Interfaces:**

- Consumes: `GET /api/feed` (Task 3).
- Produces: `fetchFeed({groupBy: string[], collapsed?: Array, focusId?: number|null, before?: number, after?: number}): Promise<{items: object[], sections: object[]}>`
  — consumed by Task 6 (`App.svelte`).

- [ ] **Step 1: Add the function**

In `ui/src/lib/api.js`, add this function at the end of the file (after
`fetchLibrary`):

```js
/**
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string,value:string}>>, focusId?: number|null, before?: number, after?: number}} opts
 * @returns {Promise<{items: object[], sections: Array<{path: Array<{dimension:string,value:string}>, count: number}>}>}
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

- [ ] **Step 2: Manually verify it's wired correctly**

There's no dedicated test file for `api.js` (it's a thin fetch wrapper,
matching the existing untested `scan`/`fetchMeta`/`setRating`/etc. in the
same file — covered indirectly through `server/api.test.js`'s HTTP
contract tests and, once Task 6 lands, through actual UI usage). Run:

```bash
npx vitest run
```

Expected: no regressions (existing suite still green — this step only
adds a new exported function, nothing consumes it yet).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/api.js
git commit -m "feat: add fetchFeed API client function"
```

---

## Task 6: `App.svelte` feed-window integration (default folder grouping)

This is the integration task that replaces the scan-driven single-array
model with the fetched, growing/sliding window — **without** the hierarchy
selector yet (Task 7 adds that). `groupBy` is hardcoded to `["folder"]`
here, which reproduces today's default view via the new mechanism, so this
task's own deliverable is independently verifiable: the app should still
show photos, scroll, rate, cover, stack, and open the loupe exactly as
before, just fetched from `/api/feed` instead of `/api/scan` + in-memory
array.

**Files:**

- Modify: `ui/src/App.svelte`
- Test: manual verification only (this file has no existing test — see
  `docs/ROADMAP.md`'s working agreement: John verifies visually at
  `localhost:5173`; this task adds no automated UI test, matching that
  established pattern. The pure logic it calls into — `feed.js`,
  `displayEntries.js`, `bursts.js` — is already tested.)

**Interfaces:**

- Consumes: `fetchFeed` (Task 5), `mergeFeedPage`/`deriveSectionHeaders`
  (Task 4, though `deriveSectionHeaders`'s actual header _rendering_ is
  Task 7 — this task only needs `mergeFeedPage` for the window itself).
- Produces: no new exports — internal `App.svelte` state only.

- [ ] **Step 1: Replace the scan-driven state and load flow**

In `ui/src/App.svelte`, replace the imports block (lines 1-19) with:

```svelte
<script>
  import { onMount, tick } from "svelte";
  import { justifiedLayout, layoutHeight } from "./lib/layouts/justified.js";
  import { visibleRange } from "./lib/layouts/windowing.js";
  import { detectBursts } from "./lib/bursts.js";
  import {
    buildDisplayEntries,
    entryDomId,
    resolvePhoto,
  } from "./lib/displayEntries.js";
  import { mergeFeedPage } from "./lib/feed.js";
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
```

(`apiScan` stays imported — the "add a folder to the index" action still
exists, per the design's "Frontend integration" section; this task doesn't
remove it, just stops it from being the thing that populates `items`.)

- [ ] **Step 2: Replace scan-session state with feed-window state**

Replace these lines (the `dir`/`items`/scan-related state block, currently
right after the `THUMB_BUCKETS`/`thumbSize` block):

```js
let dir = localStorage.getItem(LS_KEY) || "";
let items = [];
let status = "";
let error = "";
let scanning = false;
let scanEpoch = 0; // invalidates in-flight meta fetches on rescan
let library = [];
let libraryOpen = false;
```

with:

```js
let dir = localStorage.getItem(LS_KEY) || "";
const groupBy = ["folder"]; // hardcoded here; Task 7 makes this user-configurable
let items = []; // the currently-loaded feed window, ordered
let hasMoreBefore = false;
let hasMoreAfter = true;
let fetchingBefore = false;
let fetchingAfter = false;
const PAGE_SIZE = 60;
const FETCH_THRESHOLD = 20; // start fetching more when within this many items of an edge
let status = "";
let error = "";
let scanning = false;
let feedEpoch = 0; // invalidates in-flight meta fetches when the window resets
let library = [];
let libraryOpen = false;
```

- [ ] **Step 3: Replace `doScan`/`enrichMeta` with feed-loading functions**

Replace the entire `doScan` function and the `enrichMeta` function
(currently two separate functions) with:

```js
onMount(() => {
  refreshLibrary();
  loadInitialFeed();
});

async function loadInitialFeed() {
  error = "";
  status = "loading…";
  const epoch = ++feedEpoch;
  try {
    const { items: page } = await fetchFeed({ groupBy, after: PAGE_SIZE });
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
    // Matches the original doScan's reset — a fresh/reset feed load
    // always re-focuses the first item and closes any open loupe,
    // rather than leaving `selected` pointing at whatever index the
    // user had scrolled to in a now-discarded window.
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

async function loadMore(direction) {
  if (direction === "after") {
    if (fetchingAfter || !hasMoreAfter || !items.length) return;
    fetchingAfter = true;
  } else {
    if (fetchingBefore || !hasMoreBefore || !items.length) return;
    fetchingBefore = true;
  }
  const epoch = feedEpoch;
  const focusId =
    direction === "after" ? items[items.length - 1].id : items[0].id;
  // Preserve scroll position when prepending: content inserted above
  // the fold shifts everything below it down by the same amount, so
  // without this the browser's fixed scrollTop would visually jump
  // (the user would suddenly be looking at different content).
  const gridHeightBefore = gridEl ? gridEl.getBoundingClientRect().height : 0;
  try {
    const { items: page } = await fetchFeed({
      groupBy,
      focusId,
      before: direction === "before" ? PAGE_SIZE : 0,
      after: direction === "after" ? PAGE_SIZE : 0,
    });
    if (epoch !== feedEpoch) return;
    const merged = mergeFeedPage(
      { items, hasMoreBefore, hasMoreAfter },
      { items: page },
      direction,
      PAGE_SIZE
    );
    items = merged.items;
    hasMoreBefore = merged.hasMoreBefore;
    hasMoreAfter = merged.hasMoreAfter;
    enrichMeta(page.map((i) => i.id));
    if (direction === "before" && page.length) {
      await tick();
      const gridHeightAfter = gridEl
        ? gridEl.getBoundingClientRect().height
        : 0;
      window.scrollBy(0, gridHeightAfter - gridHeightBefore);
    }
  } catch (e) {
    error = e.message;
  } finally {
    if (direction === "after") fetchingAfter = false;
    else fetchingBefore = false;
  }
}

// Progressively fetch dimensions for a batch of newly-loaded ids; the
// justified layout refines itself as each batch lands (grid appears
// immediately with placeholders). Unlike the old per-folder-scan
// version, a feed page is already a bounded batch (PAGE_SIZE), so no
// further chunking is needed here.
async function enrichMeta(ids) {
  const epoch = feedEpoch;
  const need = ids.filter((id) => {
    const it = items.find((i) => i.id === id);
    return it && it.width == null;
  });
  if (!need.length) return;
  try {
    const metas = await fetchMeta(need);
    if (epoch !== feedEpoch) return;
    for (const m of metas) {
      const it = items.find((i) => i.id === m.id);
      if (it && m.width && m.height) {
        it.width = m.width;
        it.height = m.height;
        it.takenAt = m.takenAt;
      }
    }
    items = items; // re-layout with real aspect ratios
  } catch {
    return; // metadata is an enhancement; the grid still works without it
  }
}

async function refreshLibrary() {
  library = await fetchLibrary().catch(() => library);
}

async function doScan() {
  if (!dir.trim()) return;
  error = "";
  scanning = true;
  status = "scanning…";
  try {
    await apiScan(dir.trim());
    localStorage.setItem(LS_KEY, dir.trim());
    refreshLibrary();
    // The scanned folder is now indexed — reload the feed from the
    // start so the newly-scanned photos appear (they may sort anywhere
    // in the current grouping, not necessarily at the loaded window's
    // edge, so a full reset is simpler and correct here).
    await loadInitialFeed();
  } catch (e) {
    error = e.message;
    status = "";
  } finally {
    scanning = false;
  }
}

function selectFromLibrary(entry) {
  if (!entry.mounted) return;
  dir = entry.path;
  libraryOpen = false;
  doScan();
}

async function chooseFolder() {
  const path = await window.autogallery?.pickFolder();
  if (path) {
    dir = path;
    doScan();
  }
}
```

- [ ] **Step 4: Wire fetch-more into the existing scroll-driven recompute**

Modify `updateVisibleRange` (find the existing function definition) —
replace it with:

```js
/** Recompute [renderStart, renderEnd] from the grid's current position,
 * and trigger a fetch-more in either direction when the render window
 * is near a loaded edge. */
function updateVisibleRange() {
  if (!gridEl || !boxes) {
    renderStart = 0;
    renderEnd = -1;
    return;
  }
  const rect = gridEl.getBoundingClientRect();
  const range = visibleRange(boxes, {
    scrollTop: -rect.top,
    viewportHeight: window.innerHeight,
  });
  renderStart = range.start;
  renderEnd = range.end;

  if (renderEnd >= displayEntries.length - FETCH_THRESHOLD) {
    loadMore("after");
  }
  if (renderStart <= FETCH_THRESHOLD) {
    loadMore("before");
  }
}
```

- [ ] **Step 5: Remove the now-dead `LS_KEY` scan-epoch reference and update the empty-state condition**

The template's `{#if items.length}` / `{:else if !scanning}` block still
works unchanged (scanning now only reflects the explicit "add a folder"
action, not the initial load) — but the initial load has its own loading
state. Find this line in the template:

```svelte
  {:else if !scanning}
    <div class="empty">Enter a folder path and press Scan.</div>
  {/if}
```

Replace it with:

```svelte
  {:else if !scanning && status !== "loading…"}
    <div class="empty">Nothing indexed yet — scan a folder to get started.</div>
  {/if}
```

- [ ] **Step 6: Manual verification**

Run: `npm run dev`

Open `http://localhost:5173`. Expected:

- The feed loads automatically on page load (no folder path needed first)
  if anything is already indexed (it is — see
  `docs/superpowers/plans/2026-07-06-persistent-multi-drive-index.md`'s
  Task 9 validation, which left 134,760 rows in `~/.autogallery/index.db`).
- Scrolling down loads more photos automatically as you approach the
  bottom of what's loaded (status bar / network tab shows `/api/feed`
  calls firing).
- Scrolling up from a mid-scroll position (after having scrolled down a
  good distance) loads earlier photos and does **not** visually jump.
- Rating (press 1-5), manual cover choice (`C` on an expanded stack
  member), burst-stack expand/collapse (Enter on a stack), and the loupe
  (Enter on a photo, arrow keys, Escape) all still work exactly as before.
- The folder-path input + Scan button still works to add a new folder to
  the index (the feed reloads from the start afterward).

Report back what you observed — this is the task's actual "test," per the
project's established manual-verification convention for `App.svelte`.

- [ ] **Step 7: Commit**

```bash
git add ui/src/App.svelte
git commit -m "feat: replace scan-driven single-folder grid with a fetched feed window"
```

---

## Task 7: Hierarchy selector + collapsible section headers

**Files:**

- Modify: `package.json` (add `multi-auto-select` + `sortablejs` dependencies)
- Modify: `ui/src/App.svelte`

**Interfaces:**

- Consumes: `deriveSectionHeaders` (Task 4), `fetchFeed` (Task 5, already
  wired in Task 6 — this task changes what `groupBy`/`collapsed` values
  get passed to it).
- Produces: no new exports — internal `App.svelte` state only.

- [ ] **Step 1: Add the dependencies**

Run: `npm install multi-auto-select@^0.0.11 sortablejs@^1.15.7`
Expected: `package.json`/`package-lock.json` updated, install completes
(both packages are plain npm packages with no native build step).

- [ ] **Step 2: Add hierarchy + collapsed state**

In `ui/src/App.svelte`, replace this line (added in Task 6, Step 2):

```js
const groupBy = ["folder"]; // hardcoded here; Task 7 makes this user-configurable
```

with:

```js
const LS_GROUP_BY = "autogallery.groupBy";
const ALL_DIMENSIONS = ["folder", "year", "month", "day"];
let groupBy = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(LS_GROUP_BY) ?? "null");
    if (
      Array.isArray(stored) &&
      stored.every((d) => ALL_DIMENSIONS.includes(d))
    ) {
      return stored;
    }
  } catch {
    /* fall through to default */
  }
  return ["folder"];
})();
$: localStorage.setItem(LS_GROUP_BY, JSON.stringify(groupBy));
let collapsedPaths = []; // Array<Array<{dimension,value}>>, reset on hierarchy change
```

- [ ] **Step 3: Add the hierarchy-change handler (re-center on the focused photo)**

Add this function near `loadInitialFeed` (Task 6):

```js
/** Rebuild the feed for a new grouping order, re-centering on whatever
 * photo is currently selected so the user doesn't lose their place —
 * falls back to the start of the feed if nothing resolves. */
async function onGroupByChange(newGroupBy) {
  groupBy = newGroupBy;
  collapsedPaths = [];
  const focusEntry = displayEntries[selected];
  const focusId = focusEntry ? resolvePhoto(focusEntry).id : null;
  error = "";
  status = "loading…";
  const epoch = ++feedEpoch;
  try {
    const { items: beforePage } = focusId
      ? await fetchFeed({ groupBy, focusId, before: PAGE_SIZE / 2, after: 0 })
      : { items: [] };
    const { items: afterPage } = await fetchFeed({
      groupBy,
      focusId,
      before: 0,
      after: focusId ? PAGE_SIZE / 2 : PAGE_SIZE,
    });
    if (epoch !== feedEpoch) return;
    const combined = focusId
      ? [...beforePage, ...(await getFocusRow(focusId)), ...afterPage]
      : afterPage;
    items = combined;
    hasMoreBefore = focusId ? beforePage.length >= PAGE_SIZE / 2 : false;
    hasMoreAfter = afterPage.length >= (focusId ? PAGE_SIZE / 2 : PAGE_SIZE);
    selected = focusId ? beforePage.length : 0;
    status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
    enrichMeta(items.map((i) => i.id));
  } catch (e) {
    error = e.message;
    status = "";
  }
}

/** The focus photo itself isn't returned by either before/after fetch
 * (both are strictly-after/strictly-before), so fetch it directly by
 * id via /api/meta's sibling lookup — reuse fetchFeed with before=1,
 * after=0 centered one id past it is overkill; simplest is: it's
 * already in `items` from before the hierarchy change, so just find it. */
async function getFocusRow(focusId) {
  const existing = items.find((i) => i.id === focusId);
  return existing ? [existing] : [];
}
```

- [ ] **Step 4: Add collapse/expand handlers**

Add these functions near `onGroupByChange`:

```js
function pathKey(path) {
  return path.map((p) => `${p.dimension}=${p.value}`).join(">");
}

/** Toggle whether the section identified by `path` (an ordered prefix of
 * `groupBy`) is collapsed. Collapsing removes its photos from `items`
 * (they were fetched already) and refetches — a subsequent scroll won't
 * re-request them, since the server excludes the collapsed path. */
async function toggleSectionCollapse(path) {
  const key = pathKey(path);
  const already = collapsedPaths.some((p) => pathKey(p) === key);
  collapsedPaths = already
    ? collapsedPaths.filter((p) => pathKey(p) !== key)
    : [...collapsedPaths, path];
  await loadInitialFeed();
}
```

- [ ] **Step 5: Replace `loadInitialFeed`/`loadMore` calls to include `collapsedPaths`**

In `loadInitialFeed` (Task 6, Step 3), change the `fetchFeed` call from:

```js
const { items: page } = await fetchFeed({ groupBy, after: PAGE_SIZE });
```

to:

```js
const { items: page } = await fetchFeed({
  groupBy,
  collapsed: collapsedPaths,
  after: PAGE_SIZE,
});
```

In `loadMore` (Task 6, Step 3), change the `fetchFeed` call from:

```js
const { items: page } = await fetchFeed({
  groupBy,
  focusId,
  before: direction === "before" ? PAGE_SIZE : 0,
  after: direction === "after" ? PAGE_SIZE : 0,
});
```

to:

```js
const { items: page } = await fetchFeed({
  groupBy,
  collapsed: collapsedPaths,
  focusId,
  before: direction === "before" ? PAGE_SIZE : 0,
  after: direction === "after" ? PAGE_SIZE : 0,
});
```

- [ ] **Step 6: Derive and render section headers**

Add this reactive statement near the existing `$: displayEntries = ...`
line:

```js
$: sectionHeaders = deriveSectionHeaders(items, groupBy);
$: sectionHeadersByIndex = (() => {
  const map = new Map();
  for (const h of sectionHeaders) {
    if (!map.has(h.index)) map.set(h.index, []);
    map.get(h.index).push(h);
  }
  return map;
})();
```

Add the import at the top of the `<script>` block (alongside the existing
`feed.js` import from Task 6):

```js
import { mergeFeedPage, deriveSectionHeaders } from "./lib/feed.js";
```

(replacing the Task-6 single-name import line
`import { mergeFeedPage } from "./lib/feed.js";`)

In the template, inside the `{#each visibleItems as { i, entry } (entryDomId(entry))}`
block (find it in the `.grid` div), add section-header rendering right
before the `<Thumb ...>` element:

```svelte
{#each visibleItems as { i, entry } (entryDomId(entry))}
  {#if sectionHeadersByIndex.has(i)}
    {#each sectionHeadersByIndex.get(i) as header (header.dimension + header.value)}
      <div
        class="section-header"
        style="top:{header.depth * 32}px; z-index:{15 - header.depth};"
      >
        <button
          class="section-toggle"
          on:click={() =>
            toggleSectionCollapse(
              groupBy.slice(0, header.depth + 1).map((d) => ({
                dimension: d,
                value: resolvePhoto(entry).groupValues[d],
              }))
            )}
        >
          ▾ {header.label}
        </button>
      </div>
    {/each}
  {/if}
  <Thumb
    item={resolvePhoto(entry)}
    box={boxes[i]}
    pad={PAD}
    size={thumbSize}
    selected={i === selected}
    stackCount={entry.kind === "stack" ? entry.stack.count : undefined}
    stackPeekItems={entry.kind === "stack" ? entry.peekItems : []}
    stackMarginPx={stackMarginPx(entry)}
    inExpandedStack={entry.kind === "photo" && entry.stackId !== null}
    isCurrentCover={entry.kind === "photo" &&
      entry.stackId !== null &&
      stacks.find((s) => s.id === entry.stackId)?.coverId === entry.item.id}
    on:click={() =>
      entry.kind === "stack" ? toggleExpand(entry.stack) : openLoupe(i)}
    on:attempt={handleThumbAttempt}
    on:settled={handleThumbSettled}
  />
{/each}
```

Add this CSS to the `<style>` block (near `.grid`):

```css
.section-header {
  position: sticky;
  z-index: 15;
  padding: 4px 8px;
}
.section-toggle {
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.section-toggle:hover {
  background: #2a2a2a;
}
```

(Rendering collapsed-section summary rows — e.g. "▸ 2015 (1,234 photos)"
in place of a fetched header — is left as a follow-up UI nicety: the
`sections` array returned by `/api/feed`, Task 3, is not yet consumed by
`App.svelte`. Collapsing correctly stops fetching per the server-side
exclusion, which is this task's actual requirement; showing the count
inline is cosmetic polish, not required for the collapse mechanism to
work.)

- [ ] **Step 7: Add the ordered multi-select widget for choosing the hierarchy**

Add this Svelte action near the top of the `<script>` block (after the
constants, before the state declarations):

```js
import MultiAutoSelect from "multi-auto-select";

/** Svelte action: mounts the real MultiAutoSelect DOM widget into the
 * node, keeps it in sync with `groupBy` via the `value` param, and
 * calls `onGroupByChange` when the user reorders/adds/removes a pill. */
function groupBySelector(node, initialValue) {
  const widget = MultiAutoSelect(ALL_DIMENSIONS, {
    value: initialValue,
    placeholder: "Add a grouping level…",
    sortable: true,
  });
  widget.addEventListener("input", () => onGroupByChange(widget.value));
  node.appendChild(widget);
  return {
    destroy() {
      widget.remove();
    },
  };
}
```

Add this to the template, inside `<header class="topbar">`, right after
the `<h1>AutoGallery</h1>` line:

```svelte
<div class="group-by" use:groupBySelector={groupBy}></div>
```

Add this CSS to the `<style>` block:

```css
.group-by :global(.multi-auto-select) {
  color: inherit;
}
.group-by :global(.pill) {
  background: #2a2a2a !important;
  color: #eee !important;
  border-color: #444 !important;
}
```

- [ ] **Step 8: Manual verification**

Run: `npm run dev`

Open `http://localhost:5173`. Expected:

- The "Add a grouping level…" widget appears in the topbar, pre-populated
  with "folder" (from `localStorage`, or the default).
- Adding "year" and reordering (drag) to `["year", "folder"]` reloads the
  feed grouped that way, and the previously-focused photo is still
  selected/visible (context preserved across the hierarchy change).
- Section headers render at the correct nesting depth, sticky while
  scrolling.
- Clicking a section header's ▾ collapses it — its photos disappear from
  the grid, and scrolling past where it was doesn't trigger new
  `/api/thumb` requests for anything that was in it (check the Network
  tab).
- Reloading the page resets `collapsedPaths` to empty (nothing stays
  collapsed across a reload) but keeps the last-chosen `groupBy`.

Report back what you observed.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json ui/src/App.svelte
git commit -m "feat: add ordered grouping hierarchy selector and collapsible section headers"
```

---

## Task 8: Manual validation against real indexed data

This task is manual verification, not new code.

**Files:** none (read-only verification).

- [ ] **Step 1: Run the dev server**

Run: `npm run dev`

- [ ] **Step 2: Confirm the feed loads the real, already-indexed archive**

Open `http://localhost:5173`. Per
`docs/superpowers/plans/2026-07-06-persistent-multi-drive-index.md`'s own
Task 9 validation, `~/.autogallery/index.db` already holds 134,760 real
rows (John's `fotos_peq` archive + Canon SD card scan + migrated
ratings/metadata). Confirm the feed loads photos immediately on page load
without any folder path being entered.

- [ ] **Step 3: Exercise cross-folder scrolling at real scale**

Scroll continuously for at least a few thousand photos' worth of
scrolling (folder-grouped default). Report: does scrolling stay smooth
(DOM node count should stay roughly flat, per the existing virtualization
— check via browser dev tools' element count), and do `/api/feed`
requests fire at a reasonable cadence (not on every scroll-tick)?

- [ ] **Step 4: Exercise the Year/Month hierarchy at real scale**

Switch grouping to `["year", "month"]`. Confirm section headers show real
years/months from the archive (2002–2018 per
`docs/TEST_FOLDERS.local.md`), and that collapsing a whole year (some
years have 10K+ photos in this archive) is fast and doesn't stall the UI.

- [ ] **Step 5: Report results**

Summarize: initial load time, scroll smoothness at scale, whether
collapse-then-scroll-past genuinely avoided new network requests (Network
tab evidence), and any rough edges observed. No commit for this task — it's
a verification report back to John.

---

## Plan self-review notes

- **Spec coverage:** grouping dimensions as SQL expressions (Task 1),
  collapse-aware exclusion + summaries (Tasks 1-2), composite keyset
  pagination (Task 1), `GET /api/feed` contract (Task 3), pure
  window-merge/section-derivation (Task 4), API client (Task 5), feed
  replacing the scan-driven model while preserving burst/rating/cover/
  loupe/keyboard-nav behavior (Task 6), ordered hierarchy selector via
  `multi-auto-select` + collapsible headers + hierarchy-change re-centering
  (Task 7), real-data validation (Task 8). "Out of scope" items from the
  spec (album/tag dimensions, folder-scoped quick-view shortcut,
  persisting collapsed state, changes to burst/rating/cover/loupe logic
  itself) are correctly absent.
- **Type consistency:** `groupValues` (server: `Record<string,string>`,
  keyed by dimension name) is used identically in `feed.js` (Task 1),
  `deriveSectionHeaders` (Task 4), and the `App.svelte` header-rendering
  code (Task 7). `FeedWindow`'s `hasMoreBefore`/`hasMoreAfter` field names
  are consistent between `mergeFeedPage` (Task 4) and `App.svelte`'s state
  (Task 6).
- **No placeholders**: every step has complete, runnable code.
