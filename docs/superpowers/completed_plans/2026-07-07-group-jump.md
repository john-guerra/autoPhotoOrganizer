# Alt+Left/Right Group Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alt+Right/Left jumps to the next/previous section-header boundary (at any grouping depth) via a single indexed server-side query, working instantly regardless of how many photos sit between the current position and the boundary.

**Architecture:** A new `findGroupBoundary` function in `server/db/feed.js` reuses `getFeedPage`'s existing composite-ordering/exclusion machinery directly. A thin `GET /api/feed/boundary` route wraps it. The client calls it with the currently-selected photo's id, then reuses `onGroupByChange`'s existing "fetch before+after centered on a known focusId" pattern to load a window around the returned boundary and jump there.

**Tech Stack:** Node.js/Express, better-sqlite3, Svelte, vitest.

## Global Constraints

- ESM everywhere (`"type": "module"`), plain JS with JSDoc types — no TypeScript.
- Tests: vitest, colocated as `*.test.js` next to sources under `server/`.
- No automated tests for Svelte components (`App.svelte`'s `onKeydown`) — manual-only verification, per this project's established convention.
- "Boundary" means any depth of the current `groupBy`, in document (composite-sort) order — not just the outermost dimension.
- The new query must resolve in a single indexed pass, not by paging through intermediate rows — a real folder in this library holds 10,000+ photos.

---

### Task 1: Server — `findGroupBoundary`

**Files:**

- Modify: `server/db/feed.js`
- Modify: `server/db/feed.test.js`

**Interfaces:**

- Consumes: `resolveDimensions`, `seekCondition`, `exclusionClause`, `collapsedPathCondition` (all existing, module-private functions in this same file).
- Produces: `findGroupBoundary(db, {groupBy, collapsed, focusId, direction})` → `{id: number} | null`. Task 2's route consumes this.

- [ ] **Step 1: Write the failing tests**

Add to `server/db/feed.test.js`, after the existing `describe("getFeedPage — composite ordering", ...)` block (search for that exact string to find where it ends):

```js
import { findGroupBoundary } from "./feed.js";
```

Add this import alongside the existing `import { getFeedPage } from "./feed.js";` line (change it to a single combined import):

```js
import { getFeedPage, findGroupBoundary } from "./feed.js";
```

Then add:

```js
describe("findGroupBoundary", () => {
  it("finds the next boundary at the innermost dimension (next year, same folder)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const photos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
      { name: "2.jpg", size: 1, mtimeMs: 2, kind: "image" },
    ]);
    setTakenAt(db, photos[0].id, "2024-01-01");
    setTakenAt(db, photos[1].id, "2023-01-01");

    const result = findGroupBoundary(db, {
      groupBy: ["folder", "year"],
      focusId: photos[0].id,
      direction: "next",
    });
    expect(result).toEqual({ id: photos[1].id });
  });

  it("rolls up to the next outer dimension once the inner one is exhausted (next folder)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const aaaPhotos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const bbbPhotos = upsertScan(db, "/photos/bbb", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, aaaPhotos[0].id, "2024-01-01");
    setTakenAt(db, bbbPhotos[0].id, "2023-01-01");

    const result = findGroupBoundary(db, {
      groupBy: ["folder", "year"],
      focusId: aaaPhotos[0].id,
      direction: "next",
    });
    expect(result).toEqual({ id: bbbPhotos[0].id });
  });

  it("returns null at the true end of the library", () => {
    const db = getDb();
    seedVolume(db, 1);
    const photos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, photos[0].id, "2024-01-01");

    const result = findGroupBoundary(db, {
      groupBy: ["folder", "year"],
      focusId: photos[0].id,
      direction: "next",
    });
    expect(result).toBeNull();
  });

  it("returns null at the true start of the library (direction: prev)", () => {
    const db = getDb();
    seedVolume(db, 1);
    const photos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    setTakenAt(db, photos[0].id, "2024-01-01");

    const result = findGroupBoundary(db, {
      groupBy: ["folder", "year"],
      focusId: photos[0].id,
      direction: "prev",
    });
    expect(result).toBeNull();
  });

  it("skips an already-collapsed section between the focus and the next real boundary", () => {
    const db = getDb();
    seedVolume(db, 1);
    const aaaPhotos = upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    upsertScan(db, "/photos/bbb", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    const cccPhotos = upsertScan(db, "/photos/ccc", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);

    const result = findGroupBoundary(db, {
      groupBy: ["folder"],
      collapsed: [[{ dimension: "folder", value: "/photos/bbb" }]],
      focusId: aaaPhotos[0].id,
      direction: "next",
    });
    expect(result).toEqual({ id: cccPhotos[0].id });
  });

  it("throws for an unknown focusId", () => {
    const db = getDb();
    seedVolume(db, 1);
    upsertScan(db, "/photos/aaa", 1, [
      { name: "1.jpg", size: 1, mtimeMs: 1, kind: "image" },
    ]);
    expect(() =>
      findGroupBoundary(db, {
        groupBy: ["folder"],
        focusId: 999999,
        direction: "next",
      })
    ).toThrow(/999999/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/db/feed.test.js -t "findGroupBoundary"`
Expected: FAIL — `findGroupBoundary` is not exported yet.

- [ ] **Step 3: Implement `findGroupBoundary` in `server/db/feed.js`**

Add this function immediately after `getFeedPage` (at the end of the file):

```js
/**
 * Find the id of the first real row in the next/previous DIFFERENT group
 * after/before focusId's own position, at any dimension depth — e.g. the
 * next year within the same folder, or the next folder once the last
 * year in the current one is passed. A single indexed query, regardless
 * of how many rows sit between focusId and the boundary — the client-side
 * alternative (paging through every intermediate row) doesn't scale to a
 * 10,000-photo folder.
 * @param {import("better-sqlite3").Database} db
 * @param {{groupBy:string[], collapsed?:Array<Array<{dimension:string,value:string}>>, focusId:number, direction:"next"|"prev"}} opts
 * @returns {{id:number}|null}
 */
export function findGroupBoundary(
  db,
  { groupBy, collapsed = [], focusId, direction }
) {
  const dims = resolveDimensions(groupBy);
  const seekDims = [
    ...dims,
    { name: "__id", expr: "photos.id", direction: "ASC" },
  ];
  const wantAfter = direction === "next";
  const selectDimCols = dims.map((d, i) => `${d.expr} AS dim${i}`).join(", ");

  const focusRow = db
    .prepare(
      `SELECT photos.id, ${selectDimCols}
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.id = ?`
    )
    .get(focusId);
  if (!focusRow) throw new Error(`focusId ${focusId} not found`);
  const focusValues = dims
    .map((_, i) => focusRow[`dim${i}`])
    .concat(focusRow.id);

  const { sql: exclSql, params: exclParams } = exclusionClause(collapsed, dims);
  const { sql: seekSql, params: seekParams } = seekCondition(
    seekDims,
    focusValues,
    wantAfter
  );
  // "Not the focus row's own full group" — collapsedPathCondition already
  // builds exactly this NOT(...) shape for an arbitrary dimension/value
  // path; the focus row's own current groupBy values are just another
  // path to exclude, reused verbatim rather than duplicating the SQL.
  const currentGroupPath = groupBy.map((name, i) => ({
    dimension: name,
    value: focusRow[`dim${i}`],
  }));
  const { sql: notCurrentSql, params: notCurrentParams } =
    collapsedPathCondition(currentGroupPath, dims);

  const orderCols = seekDims
    .map((d, i) => {
      const col = i < dims.length ? `dim${i}` : "photos.id";
      const dir = wantAfter
        ? d.direction
        : d.direction === "ASC"
          ? "DESC"
          : "ASC";
      return `${col} ${dir}`;
    })
    .join(", ");

  const row = db
    .prepare(
      `SELECT photos.id, ${selectDimCols}
       FROM photos JOIN folders ON folders.id = photos.folder_id
       WHERE photos.stale = 0 AND (${exclSql}) AND (${seekSql}) AND (${notCurrentSql})
       ORDER BY ${orderCols}
       LIMIT 1`
    )
    .get(...exclParams, ...seekParams, ...notCurrentParams);
  return row ? { id: row.id } : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/db/feed.test.js -t "findGroupBoundary"`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full server test suite**

Run: `npx vitest run server/`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/db/feed.js server/db/feed.test.js
git commit -m "feat: add findGroupBoundary for jumping to the next/previous section at any depth"
```

---

### Task 2: Server — `GET /api/feed/boundary` route

**Files:**

- Modify: `server/api.js`
- Modify: `server/api.test.js`

**Interfaces:**

- Consumes: `findGroupBoundary` from Task 1.
- Produces: `GET /api/feed/boundary?groupBy=...&collapsed=...&focusId=...&direction=next|prev` → `200 {id: number|null}` / `400` (missing/invalid `groupBy`, invalid `direction`, invalid `collapsed` JSON) / `404` (unknown `focusId`). Task 3's client helper consumes this.

- [ ] **Step 1: Write the failing tests**

Add to `server/api.test.js`, immediately after the existing `describe("GET /api/feed", ...)` block (search for `describe("GET /api/feed"` to find it — there may be more than one `/api/feed`-related describe block; place this after the LAST one, right before the next unrelated describe):

```js
describe("GET /api/feed/boundary", () => {
  it("finds the next group boundary", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const firstId = scanBody.items[0].id;
    const res = await fetch(
      `${srv.base}/api/feed/boundary?groupBy=folder&focusId=${firstId}&direction=next`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id");
  });

  it("returns { id: null } at the true end of the library", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const lastId = scanBody.items[scanBody.items.length - 1].id;
    const res = await fetch(
      `${srv.base}/api/feed/boundary?groupBy=folder&focusId=${lastId}&direction=next`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: null });
  });

  it("400s for a missing groupBy", async () => {
    const res = await fetch(
      `${srv.base}/api/feed/boundary?focusId=1&direction=next`
    );
    expect(res.status).toBe(400);
  });

  it("400s for an invalid direction", async () => {
    const scanBody = await scan(srv.base, photosDir);
    const firstId = scanBody.items[0].id;
    const res = await fetch(
      `${srv.base}/api/feed/boundary?groupBy=folder&focusId=${firstId}&direction=sideways`
    );
    expect(res.status).toBe(400);
  });

  it("404s for an unknown focusId", async () => {
    const res = await fetch(
      `${srv.base}/api/feed/boundary?groupBy=folder&focusId=999999&direction=next`
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/api.test.js -t "GET /api/feed/boundary"`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement the route in `server/api.js`**

Change the existing import (find the line `import { getFeedPage, DIMENSIONS } from "./db/feed.js";`) to:

```js
import { getFeedPage, findGroupBoundary, DIMENSIONS } from "./db/feed.js";
```

Add this route immediately after the existing `GET /api/feed` route's closing `});` (search for the end of that route — it's the block starting `app.get("/api/feed", (req, res) => {`):

```js
app.get("/api/feed/boundary", (req, res) => {
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

  const direction = String(req.query.direction ?? "");
  if (direction !== "next" && direction !== "prev") {
    return res
      .status(400)
      .json({ error: `direction must be "next" or "prev"` });
  }

  let collapsed = [];
  if (req.query.collapsed) {
    try {
      collapsed = JSON.parse(String(req.query.collapsed));
    } catch {
      return res.status(400).json({ error: "collapsed must be JSON" });
    }
  }

  const focusId = Number(req.query.focusId);
  if (!Number.isInteger(focusId)) {
    return res.status(400).json({ error: "focusId is required" });
  }

  try {
    const db = getDb();
    const result = findGroupBoundary(db, {
      groupBy,
      collapsed,
      focusId,
      direction,
    });
    res.json(result ?? { id: null });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/api.test.js -t "GET /api/feed/boundary"`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full server test suite**

Run: `npx vitest run server/`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/api.js server/api.test.js
git commit -m "feat: add GET /api/feed/boundary route"
```

---

### Task 3: Client — `fetchGroupBoundary` in `api.js`

**Files:**

- Modify: `ui/src/lib/api.js`

**Interfaces:**

- Consumes: the route from Task 2.
- Produces: `fetchGroupBoundary({groupBy, collapsed, focusId, direction})` → `Promise<{id: number|null}>`. Task 4 consumes this.

No dedicated test file — matches this project's existing precedent for `ui/src/lib/api.js` (thin fetch wrappers, exercised via the server's own route tests and manual verification).

- [ ] **Step 1: Add `fetchGroupBoundary`**

In `ui/src/lib/api.js`, add this function immediately after `fetchFeed` (find it by searching for `export async function fetchFeed`, and add this right after its closing `}`):

```js
/**
 * @param {{groupBy: string[], collapsed?: Array<Array<{dimension:string,value:string}>>, focusId: number, direction: "next"|"prev"}} opts
 * @returns {Promise<{id: number|null}>}
 */
export async function fetchGroupBoundary({
  groupBy,
  collapsed = [],
  focusId,
  direction,
}) {
  const params = new URLSearchParams({
    groupBy: groupBy.join(","),
    focusId: String(focusId),
    direction,
  });
  if (collapsed.length) params.set("collapsed", JSON.stringify(collapsed));
  const res = await fetch(`/api/feed/boundary?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `feed boundary failed (${res.status})`);
  }
  return res.json();
}
```

- [ ] **Step 2: Run the full client test suite to confirm nothing broke**

Run: `npx vitest run ui/`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/api.js
git commit -m "feat: add fetchGroupBoundary client helper"
```

---

### Task 4: Client — Alt+Left/Right in `App.svelte`

**Files:**

- Modify: `ui/src/App.svelte`

**Interfaces:**

- Consumes: `fetchGroupBoundary` from Task 3; `onGroupByChange`'s existing "before+after centered on a known focusId" pattern (read, don't modify, that function — this task adds a new, separate handler alongside it, reusing the same shape of logic).
- Produces: no new exports — this is the finished feature.

No automated test for this task — matches this project's established convention (manual-only verification, a separate later task in this same plan).

- [ ] **Step 1: Read the current file first**

Read `ui/src/App.svelte` in full before editing (or at minimum the `onKeydown` function and `onGroupByChange` function) — this plan's code below is based on the file as it stood when this plan was written; confirm the surrounding code matches closely before applying (minor formatting differences are fine, structural differences are not — stop and ask if you find one you can't resolve confidently).

- [ ] **Step 2: Add the import**

Change the import line (find `import { fetchFeed, setRating as apiSetRating, setCover as apiSetCover, fetchMeta, fetchLibrary, scan as apiScan } from "./lib/api.js";` — read the actual current import block, since it may span multiple lines) to include `fetchGroupBoundary`:

```js
import {
  fetchFeed,
  fetchGroupBoundary,
  setRating as apiSetRating,
  setCover as apiSetCover,
  fetchMeta,
  fetchLibrary,
  scan as apiScan,
} from "./lib/api.js";
```

- [ ] **Step 3: Narrow the browser-shortcut guard**

In `onKeydown`, find the line:

```js
if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts
```

Change it to:

```js
if (
  e.metaKey ||
  e.ctrlKey ||
  (e.altKey && e.key !== "ArrowRight" && e.key !== "ArrowLeft")
)
  return; // browser shortcuts, except Alt+Left/Right for group navigation
```

- [ ] **Step 4: Add the Alt+Left/Right handler**

Immediately after the line `const key = e.key;` (right after the guard changed in Step 3) and before the existing "Grid zoom" block (`if (!loupeOpen && (key === "+" ...`), add:

```js
// Alt+Left/Right: jump to the previous/next section-header boundary,
// at any depth — e.g. the next year within a folder, rolling up to
// the next folder once the last year in the current one is passed.
// Resolved server-side (findGroupBoundary) rather than by paging
// through intermediate photos client-side — a folder in this
// library can hold 10,000+ photos between here and the boundary.
if (e.altKey && (key === "ArrowRight" || key === "ArrowLeft")) {
  e.preventDefault();
  const focusEntry = displayEntries[selected];
  const focusId = focusEntry ? resolvePhoto(focusEntry).id : null;
  if (focusId == null) return;
  const direction = key === "ArrowRight" ? "next" : "prev";
  let boundary;
  try {
    boundary = await fetchGroupBoundary({
      groupBy,
      collapsed: collapsedPaths,
      focusId,
      direction,
    });
  } catch (err) {
    error = err.message;
    return;
  }
  if (boundary.id == null) return; // already at the first/last group
  const targetId = boundary.id;
  error = "";
  status = "loading…";
  const epoch = ++feedEpoch;
  try {
    const { items: beforePage } = await fetchFeed({
      groupBy,
      collapsed: collapsedPaths,
      focusId: targetId,
      before: PAGE_SIZE / 2,
      after: 0,
    });
    const { items: afterPage, focusItem } = await fetchFeed({
      groupBy,
      collapsed: collapsedPaths,
      focusId: targetId,
      before: 0,
      after: PAGE_SIZE / 2,
    });
    if (epoch !== feedEpoch) return;
    items = [...beforePage, ...(focusItem ? [focusItem] : []), ...afterPage];
    hasMoreBefore = beforePage.length >= PAGE_SIZE / 2;
    hasMoreAfter = afterPage.length >= PAGE_SIZE / 2;
    await tick();
    const targetIndex = displayEntries.findIndex(
      (en) => resolvePhoto(en).id === targetId
    );
    const t =
      targetIndex !== -1
        ? nextSelectable(displayEntries, targetIndex, 1)
        : null;
    selected = t ?? nextSelectable(displayEntries, 0, 1) ?? 0;
    status = `${items.length} photo${items.length === 1 ? "" : "s"} loaded`;
    enrichMeta(items.map((i) => i.id));
    await tick();
    const targetHeader = layoutResult.headers.find((h) => h.index === selected);
    if (targetHeader) scrollToSection(targetHeader);
  } catch (err) {
    error = err.message;
    status = "";
  }
  return;
}
```

- [ ] **Step 5: Run the full test suite and build**

Run: `npx vitest run`
Expected: All tests pass (this task touches only Svelte component code, no pure-function logic covered by existing tests).

Run: `npm run build`
Expected: Builds successfully with no compile errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.svelte
git commit -m "feat: Alt+Left/Right jumps to the next/previous section boundary"
```

---

### Task 5: Manual validation against real indexed data

**Files:** none (verification only).

**Interfaces:** none — this task consumes the finished feature end-to-end.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify the exact case that broke the earlier client-only attempt**

Navigate to the start of the real `fotos_bk` folder (per `docs/TEST_FOLDERS.local.md`, ~10,172 photos, mostly one year) — the first photo in the library by default. Press Alt+Right. Confirm it jumps to the correct next boundary (likely the next folder or year) near-instantly (no visible delay, no intermediate page-loading spinner beyond the one normal fetch), with no console errors.

- [ ] **Step 3: Verify Alt+Left returns correctly**

From the new position, press Alt+Left and confirm it returns to (at or near) the original boundary.

- [ ] **Step 4: Verify in Loupe mode**

Open Loupe (Enter on a selected photo), press Alt+Right/Left, confirm the same jump behavior works while Loupe is open (matching how rating/cover-toggle already work identically in both modes).

- [ ] **Step 5: Verify with an active collapsed section**

Collapse a section between the current position and the next boundary (via the existing section-header collapse toggle), then Alt+Right past it, confirming it's skipped over correctly (lands on the boundary after the collapsed one, not inside it).

- [ ] **Step 6: Verify at the edges**

Navigate to the very first photo in the whole library (grouped by folder) and press Alt+Left — confirm it's a no-op (no error, no visible change). Navigate to the very last photo and press Alt+Right — same check.

- [ ] **Step 7: Check for console errors**

Confirm no unexpected console errors during the above.

- [ ] **Step 8: Stop the dev server**

No commit for this task — it's verification only.
