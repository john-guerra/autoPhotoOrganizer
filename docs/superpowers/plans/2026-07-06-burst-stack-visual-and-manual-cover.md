# Burst Stack Visual & Manual Cover Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user manually pick which photo in a burst stack is the cover (persisted, overriding the automatic priority), and redesign a collapsed stack's tile to look like a physical pile of photos — cover in front, every other member peeking out from behind, split left and right.

**Architecture:** Manual cover selection is a small vertical slice mirroring the existing ratings feature exactly (per-path persistence file, POST endpoint, client wrapper, new top-priority tier in `pickCover`), plus a keyboard trigger and a visual-feedback marker. The stacked-photos visual adds a `peekItems` field to `displayEntries.js`'s stack entries (resolving the stack's other members to item objects, same responsibility that module already has) and new rendering in `Thumb.svelte` (extra `<img>` layers, offset via CSS transform, with an explicit z-index scheme so the existing rating/count/marker badges keep painting on top).

**Tech Stack:** Svelte 4 (no runes), Express, vitest, plain JS + JSDoc (no TypeScript).

## Global Constraints

- ESM everywhere (`"type": "module"`); no TypeScript — plain JS + JSDoc types.
- Svelte 4 (no runes) — `$:` reactive statements throughout `App.svelte`.
- Tests: vitest, colocated as `*.test.js` next to the source file (client modules); server persistence mirrors `server/ratings.js`'s lack of a dedicated unit-test file, exercised instead via `server/api.test.js` integration tests.
- Do **not** run automated browser/Playwright verification — John verifies visually himself at `localhost:5173`. Run unit tests, then stop and report tersely (working agreement in `docs/ROADMAP.md`).
- Commit after each task; do not batch multiple tasks into one commit.
- Full spec: `docs/superpowers/specs/2026-07-06-burst-stack-visual-and-manual-cover-design.md`.

---

### Task 1: Manual cover choice persistence + API

**Files:**
- Modify: `server/lib/cachePaths.js`
- Create: `server/coverChoices.js`
- Modify: `server/api.js`
- Modify: `server/api.test.js`
- Modify: `ui/src/lib/api.js`

**Interfaces:**
- Produces: `getAllCoverChoices() → Record<string, true>`, `setCoverChoice(absPath: string, isCover: boolean) → void`, `flushNow()`, `_resetForTest()` from `server/coverChoices.js`. `POST /api/cover` (body `{id, isCover}`) → `{id, preferredCover}`. `/api/scan`'s response items gain a `preferredCover: boolean` field. `setCover(id, isCover) → Promise<{id, preferredCover}>` from `ui/src/lib/api.js`.

- [ ] **Step 1: Add `coverChoicesFile()` to `server/lib/cachePaths.js`**

Add this function to `server/lib/cachePaths.js`, right after the existing `ratingsFile()`:

```js
/** @returns {string} Absolute path to the manual cover-choices JSON file. */
export function coverChoicesFile() {
  mkdirSync(cacheRoot(), { recursive: true });
  return join(cacheRoot(), "coverChoices.json");
}
```

- [ ] **Step 2: Create `server/coverChoices.js`**

```js
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { coverChoicesFile } from "./lib/cachePaths.js";

/**
 * Manual burst-cover-choice persistence.
 *
 * Keyed by ABSOLUTE file path (not scan id) so a choice survives rescans
 * and re-orderings, same reasoning as ratings.js. Stored as a single JSON
 * object at ~/.autogallery/coverChoices.json — only paths the user has
 * explicitly marked appear in the map (there is no "false" entry;
 * unmarking deletes the key). Writes are atomic (temp file + rename) and
 * debounced.
 */

/** @type {Record<string, true> | null} */
let cache = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
const DEBOUNCE_MS = 150;

/** Load the cover-choices map from disk (cached in memory). */
function load() {
  if (cache) return cache;
  const file = coverChoicesFile();
  if (existsSync(file)) {
    try {
      cache = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      cache = {};
    }
  } else {
    cache = {};
  }
  return cache;
}

/** Atomically write the in-memory map to disk (temp + rename). */
function flush() {
  flushTimer = null;
  const file = coverChoicesFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache ?? {}, null, 2));
  renameSync(tmp, file);
}

/** Schedule a debounced flush. */
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

/** @returns {Record<string, true>} A copy of all manual cover choices keyed by absolute path. */
export function getAllCoverChoices() {
  return { ...load() };
}

/**
 * Set (or clear) the manual cover choice for an absolute path.
 * @param {string} absPath
 * @param {boolean} isCover
 */
export function setCoverChoice(absPath, isCover) {
  const map = load();
  if (isCover) map[absPath] = true;
  else delete map[absPath];
  scheduleFlush();
}

/**
 * Force a synchronous flush of any pending debounced write.
 * Useful for tests and graceful shutdown.
 */
export function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flush();
  }
}

/** Reset in-memory cache (tests only). */
export function _resetForTest() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  cache = null;
}
```

- [ ] **Step 3: Wire into `server/api.js`**

Add the import, right after the existing `import { getAllRatings, setRating } from "./ratings.js";` (currently line 7):

```js
import { getAllCoverChoices, setCoverChoice } from "./coverChoices.js";
```

Replace the `/api/scan` handler's item-mapping block (currently lines 68-75):

```js
    const ratings = getAllRatings();
    const items = session.items.map((it) => ({
      id: it.id,
      name: it.name,
      size: it.size,
      mtimeMs: it.mtimeMs,
      rating: ratings[it.path] ?? 0,
    }));
```

with:

```js
    const ratings = getAllRatings();
    const coverChoices = getAllCoverChoices();
    const items = session.items.map((it) => ({
      id: it.id,
      name: it.name,
      size: it.size,
      mtimeMs: it.mtimeMs,
      rating: ratings[it.path] ?? 0,
      preferredCover: coverChoices[it.path] === true,
    }));
```

Add a new route right after the existing `/api/rating` route (currently ends at line 202, just before the closing `}` of `registerApi`):

```js
  app.post("/api/cover", (req, res) => {
    const { id, isCover } = req.body ?? {};
    const it = itemById(Number(id));
    if (!it) return res.status(404).json({ error: "unknown id" });
    if (typeof isCover !== "boolean") {
      return res.status(400).json({ error: "isCover must be a boolean" });
    }
    setCoverChoice(it.path, isCover);
    res.json({ id: it.id, preferredCover: isCover });
  });
```

- [ ] **Step 4: Add integration tests to `server/api.test.js`**

Add the import, alongside the existing `import { _resetForTest } from "./ratings.js";` (currently line 8):

```js
import { _resetForTest as _resetCoverChoicesForTest } from "./coverChoices.js";
```

In `beforeAll`, right after the existing `_resetForTest();` call (currently line 32):

```js
  _resetCoverChoicesForTest();
```

Add a new `describe` block at the end of the file, after the existing `describe("ratings round-trip", ...)` block:

```js
describe("manual cover choice round-trip", () => {
  it("persists a manual cover choice keyed by absolute path across a rescan", async () => {
    // Establish a session first so id 1 resolves to a real path.
    await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: photosDir }),
    });

    const set = await fetch(`${srv.base}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, isCover: true }),
    });
    expect(set.status).toBe(200);

    // Rescan (new session) — the choice must reattach by path.
    const rescan = await fetch(`${srv.base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: photosDir }),
    });
    const body = await rescan.json();
    expect(body.items[1].preferredCover).toBe(true);
    expect(body.items[0].preferredCover).toBe(false);

    // Clearing removes it.
    await fetch(`${srv.base}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, isCover: false }),
    });
    const after = await (
      await fetch(`${srv.base}/api/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: photosDir }),
      })
    ).json();
    expect(after.items[1].preferredCover).toBe(false);
  });

  it("rejects a non-boolean isCover", async () => {
    const res = await fetch(`${srv.base}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 0, isCover: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 5: Add the client wrapper to `ui/src/lib/api.js`**

Add this function right after the existing `setRating` function:

```js
/**
 * @param {number} id
 * @param {boolean} isCover
 */
export async function setCover(id, isCover) {
  const res = await fetch("/api/cover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, isCover }),
  });
  if (!res.ok) throw new Error(`cover failed (${res.status})`);
  return res.json();
}
```

Update `scan()`'s JSDoc return type (currently line 8) to include the new field:

```js
 * @returns {Promise<{root:string, count:number, elapsedMs:number, items:Array<{id:number,name:string,size:number,mtimeMs:number,rating:number,preferredCover:boolean}>}>}
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS — all existing suites plus the two new tests in `server/api.test.js` are green.

- [ ] **Step 7: Commit**

```bash
git add server/lib/cachePaths.js server/coverChoices.js server/api.js server/api.test.js ui/src/lib/api.js
git commit -m "$(cat <<'EOF'
feat: add manual burst-cover-choice persistence and API

Mirrors ratings.js exactly: per-absolute-path persistence in
~/.autogallery/coverChoices.json (atomic debounced writes), a new
POST /api/cover endpoint, and a preferredCover field added to /api/scan's
response items. Client gets a matching setCover(id, isCover) wrapper.
Part of the burst-stack manual cover selection feature — this task is
persistence/API only; the priority-tier logic and UI trigger are
separate tasks.
EOF
)"
```

---

### Task 2: Manual-override priority tier in `pickCover`

**Files:**
- Modify: `ui/src/lib/bursts.js`
- Modify: `ui/src/lib/bursts.test.js`

**Interfaces:**
- Consumes: `item.preferredCover?: boolean` (populated by Task 1's `/api/scan` response, flowing into `items` the same way `item.rating` already does).
- Produces: `detectBursts`'s `coverId` now reflects the new top-priority tier; `id` (already stable per the earlier whole-branch-review fix) is unaffected by this new tier, same as it's unaffected by rating changes.

- [ ] **Step 1: Write the failing tests**

Add these tests to `ui/src/lib/bursts.test.js`, after the existing `"keeps a stack's id stable when a rating changes which member is the cover"` test:

```js
  it("prefers a manually-chosen cover over a higher-rated or COVER-marked member", () => {
    const items = [
      { id: 1, name: "PXL_1.BURST-01.COVER.jpg", mtimeMs: 0, rating: 0 },
      { id: 2, name: "PXL_1.BURST-02.jpg", mtimeMs: 200, rating: 4 },
      {
        id: 3,
        name: "PXL_1.BURST-03.jpg",
        mtimeMs: 400,
        rating: 0,
        preferredCover: true,
      },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks[0].coverId).toBe(3);
  });

  it("keeps a stack's id stable when a manual cover choice is set", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 200 },
      { id: 3, name: "c.jpg", mtimeMs: 400 },
    ];
    const before = detectBursts(items, { gapMs: 1000 });
    const stackIdBefore = before[0].id;
    expect(before[0].coverId).toBe(1);

    items[2].preferredCover = true; // item id 3
    const after = detectBursts(items, { gapMs: 1000 });
    expect(after[0].coverId).toBe(3);
    expect(after[0].id).toBe(stackIdBefore);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/lib/bursts.test.js`
Expected: FAIL — `preferredCover` isn't consulted yet, so both new tests fail (the first because `coverId` resolves to the rated member instead of 3; the second because `coverId` never becomes 3).

- [ ] **Step 3: Implement the priority tier**

Replace the existing `pickCover` function in `ui/src/lib/bursts.js`:

```js
/**
 * Cover priority: highest-rated member, else the file marked `.COVER.`,
 * else the chronologically-first member. `cluster` is already sorted
 * chronologically (it's a run from the outer time-sorted walk), so
 * cluster[0] is the chronologically-first member.
 */
function pickCover(cluster) {
  let bestRated = null;
  for (const c of cluster) {
    if (
      c.item.rating > 0 &&
      (bestRated === null || c.item.rating > bestRated.item.rating)
    ) {
      bestRated = c;
    }
  }
  if (bestRated) return bestRated.item.id;

  const coverMarked = cluster.find((c) => COVER_FILENAME_RE.test(c.item.name));
  if (coverMarked) return coverMarked.item.id;

  return cluster[0].item.id;
}
```

with:

```js
/**
 * Cover priority: a manually-chosen member (item.preferredCover === true),
 * else the highest-rated member, else the file marked `.COVER.`, else the
 * chronologically-first member. `cluster` is already sorted chronologically
 * (it's a run from the outer time-sorted walk), so cluster[0] is the
 * chronologically-first member. If more than one member somehow carries
 * `preferredCover`, the first in cluster order wins — the app's own UI
 * never lets that happen (see
 * docs/superpowers/specs/2026-07-06-burst-stack-visual-and-manual-cover-design.md),
 * this is just a deterministic fallback.
 */
function pickCover(cluster) {
  const manual = cluster.find((c) => c.item.preferredCover === true);
  if (manual) return manual.item.id;

  let bestRated = null;
  for (const c of cluster) {
    if (
      c.item.rating > 0 &&
      (bestRated === null || c.item.rating > bestRated.item.rating)
    ) {
      bestRated = c;
    }
  }
  if (bestRated) return bestRated.item.id;

  const coverMarked = cluster.find((c) => COVER_FILENAME_RE.test(c.item.name));
  if (coverMarked) return coverMarked.item.id;

  return cluster[0].item.id;
}
```

Update `detectBursts`'s JSDoc `@param` (currently line 12) to include the new field:

```js
 * @param {Array<{id: number|string, name: string, rating?: number, preferredCover?: boolean, mtimeMs: number, takenAt?: string|number|null}>} items
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/bursts.test.js`
Expected: PASS (13 tests: 11 existing + 2 new).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — no existing suite regresses.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/bursts.js ui/src/lib/bursts.test.js
git commit -m "$(cat <<'EOF'
feat: add manual-override as the top cover-priority tier

pickCover now checks item.preferredCover first, above rating and the
.COVER. filename marker. stack.id remains anchored to the
chronologically-first member (fixed in the earlier whole-branch
review specifically to survive coverId changes), so this new tier
can't reintroduce the earlier id-instability bug — verified by a
regression test mirroring the existing rating-stability test.
EOF
)"
```

---

### Task 3: Manual cover keyboard trigger and visual feedback

**Files:**
- Modify: `ui/src/App.svelte`
- Modify: `ui/src/lib/Thumb.svelte`

**Interfaces:**
- Consumes: `setCover` from `ui/src/lib/api.js` (Task 1); `stacks`/`displayEntries`/`resolvePhoto` already in scope in `App.svelte`.
- Produces: `Thumb.svelte` gains `isCurrentCover` (boolean, default `false`) — later tasks don't depend on this, it's UI-terminal for this feature.

- [ ] **Step 1: Import `setCover` in `App.svelte`**

Change the existing import block (currently lines 11-15):

```js
  import {
    scan as apiScan,
    setRating as apiSetRating,
    fetchMeta,
  } from "./lib/api.js";
```

to:

```js
  import {
    scan as apiScan,
    setRating as apiSetRating,
    setCover as apiSetCover,
    fetchMeta,
  } from "./lib/api.js";
```

- [ ] **Step 2: Add `toggleCover`**

Add this function right after the existing `rate` function:

```js
  /**
   * Toggle the manual cover choice for the given display entry: if it's
   * already the stack's manual pick, clear it (revert to automatic
   * selection); otherwise make it the pick, clearing any other member of
   * the same stack that was previously manually chosen. At most one
   * manual pick per stack is enforced here, in the UI — pickCover's own
   * fallback (first-in-cluster-order) only matters if that invariant is
   * ever violated some other way.
   */
  function toggleCover(entry) {
    if (entry?.kind !== "photo" || !entry.stackId) return;
    const stack = stacks.find((s) => s.id === entry.stackId);
    if (!stack) return;

    const target = entry.item;
    const makingManual = !target.preferredCover;

    for (const id of stack.memberIds) {
      const it = items.find((i) => i.id === id);
      if (!it) continue;
      const shouldBeCover = makingManual && id === target.id;
      if (it.preferredCover !== shouldBeCover) {
        it.preferredCover = shouldBeCover;
        apiSetCover(it.id, shouldBeCover).catch((e) => (error = e.message));
      }
    }
    items = items; // trigger reactivity
  }
```

- [ ] **Step 3: Add the `C` key handler to `onKeydown`**

In `onKeydown`, add this new block right after the existing star-rating block (`if (/^[0-5]$/.test(key)) { ... }`) and before the `if (loupeOpen) { ... }` block:

```js
    // Manual cover choice: 'C' toggles whether the selected photo is its
    // stack's manually-chosen cover. Only meaningful for a member of a
    // currently expanded stack; a no-op otherwise. Works in both grid and
    // loupe, since both share the same selected index into displayEntries.
    if (key.toLowerCase() === "c") {
      const entry = displayEntries[selected];
      if (entry?.stackId) {
        e.preventDefault();
        toggleCover(entry);
      }
      return;
    }
```

- [ ] **Step 4: Add `isCurrentCover` to `Thumb.svelte`**

Add this prop right after the existing `export let inExpandedStack = false;`:

```js
  export let isCurrentCover = false; // true when this expanded member currently resolves as its stack's cover
```

Replace the existing marker markup:

```svelte
  {#if inExpandedStack}
    <span class="stack-marker" title="Part of a burst — press Escape to collapse">⚏</span>
  {/if}
```

with:

```svelte
  {#if inExpandedStack}
    <span
      class="stack-marker"
      class:is-cover={isCurrentCover}
      title={isCurrentCover
        ? "Current cover for this stack — press C to unset, Escape to collapse"
        : "Part of a burst — press C to make this the cover, Escape to collapse"}>⚏</span
    >
  {/if}
```

Add this CSS rule right after the existing `.stack-marker { ... }` rule:

```css
  .stack-marker.is-cover {
    background: rgba(255, 196, 0, 0.85);
  }
```

- [ ] **Step 5: Wire `isCurrentCover` from `App.svelte`'s template**

In the `<Thumb ...>` invocation inside the `{#each visibleItems as { i, entry } (entryDomId(entry))}` block, add a new prop alongside the existing `inExpandedStack`:

```svelte
            inExpandedStack={entry.kind === "photo" && entry.stackId !== null}
            isCurrentCover={entry.kind === "photo" &&
              entry.stackId !== null &&
              stacks.find((s) => s.id === entry.stackId)?.coverId === entry.item.id}
```

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS — no existing suite regresses. This task adds no new automated tests (`App.svelte`/`Thumb.svelte` have no component test harness, consistent with the rest of the codebase).

- [ ] **Step 7: Commit**

```bash
git add ui/src/App.svelte ui/src/lib/Thumb.svelte
git commit -m "$(cat <<'EOF'
feat: add C key to manually set/unset a burst's cover photo

toggleCover() enforces at most one manual pick per stack (clearing any
prior pick on the same stack before setting a new one), persisted via
the Task 1 API, picked up by pickCover's new top-priority tier (Task
2) on the next reactive recompute. Works identically in the grid and
the Loupe, since both share the same selected index into
displayEntries. Thumb's existing "part of a burst" marker gains a
highlighted variant for whichever expanded member currently resolves
as the cover, giving live feedback as you browse and press C.
EOF
)"
```

- [ ] **Step 8: Stop for manual verification**

Per the working agreement in `docs/ROADMAP.md`, do **not** run automated browser/Playwright verification. Report tersely that unit tests pass, and ask John to verify at `localhost:5173`: expand a burst, press `C` on a non-first member, confirm its marker highlights and the stack's cover changes when collapsed; press `C` again to unset it; rescan the same folder and confirm the choice persisted.

---

### Task 4: `peekItems` in `displayEntries.js`

**Files:**
- Modify: `ui/src/lib/displayEntries.js`
- Modify: `ui/src/lib/displayEntries.test.js`

**Interfaces:**
- Produces: a collapsed `kind: 'stack'` entry now also carries `peekItems: object[]` — the stack's other members (excluding the cover), resolved to item objects, in their original `memberIds` order.

- [ ] **Step 1: Update the existing test that asserts the full stack-entry shape**

The existing test `"collapses a stack to one entry, at its first member's position, using the cover photo"` in `ui/src/lib/displayEntries.test.js` currently reads:

```js
  it("collapses a stack to one entry, at its first member's position, using the cover photo", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    expect(entries).toHaveLength(2); // solo + one collapsed stack entry
    expect(entries[0].item.id).toBe(1); // solo stays first
    expect(entries[1]).toEqual({
      kind: "stack",
      stack,
      coverItem: items[2], // id 3, the cover
    });
  });
```

Change the `toEqual` block to include the new field (the fixture's `stack.memberIds` is `[2, 3, 4]` with `coverId: 3`, so `peekItems` is `items` ids 2 and 4, in that order):

```js
  it("collapses a stack to one entry, at its first member's position, using the cover photo", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    expect(entries).toHaveLength(2); // solo + one collapsed stack entry
    expect(entries[0].item.id).toBe(1); // solo stays first
    expect(entries[1]).toEqual({
      kind: "stack",
      stack,
      coverItem: items[2], // id 3, the cover
      peekItems: [items[1], items[3]], // ids 2 and 4, excluding the cover
    });
  });
```

- [ ] **Step 2: Add a dedicated `peekItems` test**

Add this new test, after the existing `"does not duplicate a collapsed stack's later members"` test:

```js
  it("computes peekItems as the stack's other members, excluding the cover, in memberIds order", () => {
    const entries = buildDisplayEntries(items, [stack], new Set());
    const stackEntry = entries.find((e) => e.kind === "stack");
    expect(stackEntry.peekItems).toEqual([items[1], items[3]]); // ids 2, 4 — not 3 (the cover)
  });
```

- [ ] **Step 3: Run the tests to verify the updated/new tests fail**

Run: `npx vitest run ui/src/lib/displayEntries.test.js`
Expected: FAIL — `peekItems` doesn't exist on the stack entry yet, so both the updated `toEqual` assertion and the new test fail.

- [ ] **Step 4: Implement `peekItems`**

Replace the `buildDisplayEntries` function body's stack-entry branch (currently the `else if (!emittedStackIds.has(stack.id))` branch):

```js
    } else if (!emittedStackIds.has(stack.id)) {
      emittedStackIds.add(stack.id);
      entries.push({ kind: "stack", stack, coverItem: byId.get(stack.coverId) });
    }
```

with:

```js
    } else if (!emittedStackIds.has(stack.id)) {
      emittedStackIds.add(stack.id);
      const peekItems = stack.memberIds
        .filter((id) => id !== stack.coverId)
        .map((id) => byId.get(id))
        .filter(Boolean);
      entries.push({
        kind: "stack",
        stack,
        coverItem: byId.get(stack.coverId),
        peekItems,
      });
    }
```

Update the function's JSDoc `@returns` (currently lines 17-20):

```js
 * @returns {Array<
 *   | { kind: 'photo', item: object, stackId: string|null }
 *   | { kind: 'stack', stack: object, coverItem: object }
 * >}
```

to:

```js
 * @returns {Array<
 *   | { kind: 'photo', item: object, stackId: string|null }
 *   | { kind: 'stack', stack: object, coverItem: object, peekItems: object[] }
 * >}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/displayEntries.test.js`
Expected: PASS (9 tests: 8 existing, one updated, plus 1 new — net 9).

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — no existing suite regresses.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/displayEntries.js ui/src/lib/displayEntries.test.js
git commit -m "$(cat <<'EOF'
feat: add peekItems to collapsed stack display entries

Resolves a stack's other members (excluding the cover) to item
objects, in their original memberIds order, using the same byId map
buildDisplayEntries already builds internally. Feeds the stacked-
photos visual (next task) — Thumb.svelte will render these as peeking
layers behind the cover.
EOF
)"
```

---

### Task 5: Stacked-photos peek rendering

**Files:**
- Modify: `ui/src/lib/Thumb.svelte`
- Modify: `ui/src/App.svelte`

**Interfaces:**
- Consumes: `entry.peekItems` from Task 4's `displayEntries.js`.

This task adds no new automated tests (`Thumb.svelte`/`App.svelte` have no component test harness, consistent with the rest of the codebase, and with Task 3 in this same plan).

- [ ] **Step 1: Add `stackPeekItems` prop and the peek-split reactive statements to `Thumb.svelte`**

Add this constant near the top of the `<script>` block (after the imports):

```js
  const PEEK_STEP_PX = 2; // px offset per peeking layer, alternating left/right
```

Add this prop right after the existing `export let isCurrentCover = false;` (added in Task 3):

```js
  export let stackPeekItems = []; // this stack's other members (excludes the cover), for the peeking-photos visual
```

Add these reactive statements right after the existing `$: if (src) loaded = false;` line:

```js
  // Split alternately: chronologically-nearer non-cover members peek out
  // closer to the cover (right first, then left, then right again, ...).
  $: rightPeekItems = stackPeekItems.filter((_, i) => i % 2 === 0);
  $: leftPeekItems = stackPeekItems.filter((_, i) => i % 2 === 1);
```

- [ ] **Step 2: Replace the image markup**

Replace the existing `{#if src}` block:

```svelte
  {#if src}
    <img
      {src}
      alt={item.name}
      loading="lazy"
      class:loaded
      on:load={() => (loaded = true)}
    />
  {/if}
```

with:

```svelte
  {#if src}
    {#each rightPeekItems as peekItem, i (peekItem.id)}
      <img
        src={thumbUrl(peekItem.id, size, peekItem.mtimeMs)}
        alt=""
        loading="lazy"
        class="stack-peek"
        style={`transform: translateX(${(i + 1) * PEEK_STEP_PX}px); z-index: ${rightPeekItems.length - i};`}
      />
    {/each}
    {#each leftPeekItems as peekItem, i (peekItem.id)}
      <img
        src={thumbUrl(peekItem.id, size, peekItem.mtimeMs)}
        alt=""
        loading="lazy"
        class="stack-peek"
        style={`transform: translateX(-${(i + 1) * PEEK_STEP_PX}px); z-index: ${leftPeekItems.length - i};`}
      />
    {/each}
    <img
      {src}
      alt={item.name}
      loading="lazy"
      class="cover"
      class:loaded
      on:load={() => (loaded = true)}
    />
  {/if}
```

- [ ] **Step 3: Update the CSS**

Replace the existing generic image rules:

```css
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  img.loaded {
    opacity: 1;
  }
```

with:

```css
  img.cover,
  .stack-peek {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    border-radius: inherit;
  }
  img.cover {
    z-index: 50;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  img.cover.loaded {
    opacity: 1;
  }
  .stack-peek {
    filter: brightness(0.75);
    pointer-events: none;
  }
```

**Required z-index bump on the existing badges/marker** — without this, they'd render *behind* the newly z-indexed cover/peek images instead of on top, since CSS treats `z-index: auto` as effectively `0` once any sibling has an explicit z-index. Add this new rule right after the existing `.stack-marker.is-cover { ... }` rule (added in Task 3):

```css
  .badge,
  .stack-badge,
  .stack-marker {
    z-index: 100;
  }
```

- [ ] **Step 4: Wire `stackPeekItems` from `App.svelte`'s template**

In the `<Thumb ...>` invocation, add this prop alongside the existing `stackCount`:

```svelte
            stackCount={entry.kind === "stack" ? entry.stack.count : undefined}
            stackPeekItems={entry.kind === "stack" ? entry.peekItems : []}
```

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS — no existing suite regresses.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/Thumb.svelte ui/src/App.svelte
git commit -m "$(cat <<'EOF'
feat: render collapsed stacks as a pile of peeking photos

A collapsed stack's tile now shows every other member's real
thumbnail peeking out from behind the cover, split alternately left
and right (uncapped — scales to the stack's actual size), each offset
2px further than the last via CSS transform, darkened slightly
(brightness 0.75) to read as receded behind the sharp cover in front.
Bumps the rating/count/marker badges to an explicit z-index so they
keep painting on top of the new image layers (z-index: auto is
treated as 0 once any sibling has an explicit z-index — without this
bump the badges would silently render behind the cover/peeks).
EOF
)"
```

- [ ] **Step 7: Stop for manual verification**

Per the working agreement in `docs/ROADMAP.md`, do **not** run automated browser/Playwright verification. Report tersely that unit tests pass, and ask John to verify at `localhost:5173` against the 10,172-photo Pixel folder (4 real burst groups of 3) — confirm the peeking-photos visual looks reasonable, the count badge/rating badge/expanded-marker all still render on top of it, and that peek slivers don't visibly bleed into a neighboring tile at the smallest zoom level (where tiles are most cramped).

---

## Self-Review Notes

- **Spec coverage:** manual cover persistence + API (Task 1) ✓; priority tier + `stack.id` stability under the new tier (Task 2) ✓; keyboard trigger, single-manual-pick-per-stack enforcement, current-cover visual feedback (Task 3) ✓; `peekItems` data (Task 4) ✓; uncapped left/right peek rendering, z-index scheme (Task 5) ✓; out-of-scope items (automatic quality scoring, `detectBursts` clustering changes) untouched ✓.
- **No placeholders:** every step contains complete, runnable code.
- **Type/name consistency:** `preferredCover` used identically across `server/api.js`, `ui/src/lib/api.js`, `ui/src/lib/bursts.js`, and `App.svelte`; `peekItems` field name matches between Task 4's `displayEntries.js` producer and Task 5's `App.svelte` consumer (`entry.peekItems`) and `Thumb.svelte`'s `stackPeekItems` prop; `setCover`/`apiSetCover` naming mirrors the existing `setRating`/`apiSetRating` convention exactly.
