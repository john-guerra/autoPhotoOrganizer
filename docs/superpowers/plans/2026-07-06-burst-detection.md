# Burst Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, tested function `detectBursts(items, { gapMs })` that groups a folder's photos into bursts by chronological proximity, with a filename-based hard-link override for genuine Pixel burst-mode sequences, and picks a cover photo per burst.

**Architecture:** One new pure module (`ui/src/lib/bursts.js`), no DOM/Svelte dependency, following the same shape as the existing `justified.js`/`windowing.js` layout modules: plain data in, plain data out, unit-tested in isolation. This is Part 1 of GitHub issue #2 ("Burst stacks") — grid/UI integration is a separate, not-yet-designed follow-up and is explicitly out of scope here.

**Tech Stack:** Plain JS + JSDoc (no TypeScript), ESM, vitest.

## Global Constraints

- ESM everywhere (`"type": "module"`); no TypeScript — plain JS + JSDoc types.
- Tests: vitest, colocated as `*.test.js` next to the source file.
- No DOM/Svelte dependency in this module — pure function only.
- Commit after the task; do not batch with unrelated changes.
- Full spec: `docs/superpowers/specs/2026-07-06-burst-detection-design.md`.

---

### Task 1: `detectBursts` pure function

**Files:**
- Create: `ui/src/lib/bursts.js`
- Test: `ui/src/lib/bursts.test.js`

**Interfaces:**
- Produces: `detectBursts(items, { gapMs }) → Array<{ id: string, memberIds: Array<number|string>, coverId: number|string, count: number }>`, exported from `ui/src/lib/bursts.js`. `items` is `Array<{id, name, rating?, mtimeMs, takenAt?}>` — the same item shape already used throughout `ui/src/App.svelte`.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/bursts.test.js`:

```js
import { describe, it, expect } from "vitest";
import { detectBursts } from "./bursts.js";

describe("detectBursts", () => {
  it("groups consecutive photos within gapMs, and splits on a wider gap", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 500 },
      { id: 3, name: "c.jpg", mtimeMs: 900 },
      { id: 4, name: "d.jpg", mtimeMs: 10000 }, // far away, stays alone
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 2, 3]);
    expect(stacks[0].count).toBe(3);
  });

  it("keeps same-burst-filename photos grouped even if their gap exceeds gapMs", () => {
    const items = [
      { id: 1, name: "PXL_20240101_000000000.BURST-01.COVER.jpg", mtimeMs: 0 },
      { id: 2, name: "PXL_20240101_000000000.BURST-02.jpg", mtimeMs: 5000 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 2]);
  });

  it("picks the highest-rated member as cover, even over a filename COVER marker", () => {
    const items = [
      { id: 1, name: "PXL_1.BURST-01.COVER.jpg", mtimeMs: 0, rating: 0 },
      { id: 2, name: "PXL_1.BURST-02.jpg", mtimeMs: 200, rating: 4 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks[0].coverId).toBe(2);
  });

  it("picks the COVER-marked file when no member is rated", () => {
    const items = [
      { id: 1, name: "PXL_1.BURST-01.jpg", mtimeMs: 0 },
      { id: 2, name: "PXL_1.BURST-02.COVER.jpg", mtimeMs: 200 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks[0].coverId).toBe(2);
  });

  it("picks the chronologically-first member when neither rating nor COVER marker applies", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 200 },
      { id: 2, name: "b.jpg", mtimeMs: 0 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks[0].coverId).toBe(2); // mtimeMs 0 is chronologically first
  });

  it("prefers takenAt over mtimeMs for grouping when takenAt is present", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0, takenAt: 0 },
      // mtimeMs is far apart (file copied later), but takenAt (actual
      // capture time) is close — grouping must follow takenAt.
      { id: 2, name: "b.jpg", mtimeMs: 50000, takenAt: 200 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 2]);
  });

  it("falls back to mtimeMs when takenAt is missing", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 300 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(1);
    expect(stacks[0].memberIds).toEqual([1, 2]);
  });

  it("does not create a stack for a lone photo with no time-adjacent neighbor or burst partner", () => {
    const items = [
      { id: 1, name: "a.jpg", mtimeMs: 0 },
      { id: 2, name: "b.jpg", mtimeMs: 100000 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(0);
  });

  it("partitions a mixed folder into ungrouped photos, a time-gap cluster, and a filename cluster", () => {
    const items = [
      { id: 1, name: "solo.jpg", mtimeMs: 0 },
      { id: 2, name: "tg-a.jpg", mtimeMs: 100000 },
      { id: 3, name: "tg-b.jpg", mtimeMs: 100300 },
      { id: 4, name: "PXL_1.BURST-01.COVER.jpg", mtimeMs: 500000 },
      { id: 5, name: "PXL_1.BURST-02.jpg", mtimeMs: 500200 },
    ];
    const stacks = detectBursts(items, { gapMs: 1000 });
    expect(stacks).toHaveLength(2);
    const memberIdSets = stacks.map((s) => [...s.memberIds].sort());
    expect(memberIdSets).toContainEqual([2, 3]);
    expect(memberIdSets).toContainEqual([4, 5]);
    const allGrouped = stacks.flatMap((s) => s.memberIds);
    expect(allGrouped).not.toContain(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/lib/bursts.test.js`
Expected: FAIL — `bursts.js` does not exist / `detectBursts` is not exported.

- [ ] **Step 3: Write the implementation**

Create `ui/src/lib/bursts.js`:

```js
/**
 * Groups a folder's photos into bursts by chronological proximity, with a
 * filename-based hard-link override for genuine Pixel burst-mode
 * sequences, and picks a cover photo per burst.
 *
 * Pure — no DOM, no Svelte. See
 * docs/superpowers/specs/2026-07-06-burst-detection-design.md for the
 * full rationale (in particular: why time-gap grouping is the primary
 * mechanism and filename matching is a supporting signal, not a
 * competing gate).
 *
 * @param {Array<{id: number|string, name: string, rating?: number, mtimeMs: number, takenAt?: number}>} items
 * @param {{ gapMs: number }} opts
 * @returns {Array<{ id: string, memberIds: Array<number|string>, coverId: number|string, count: number }>}
 */
export function detectBursts(items, { gapMs }) {
  if (!items.length) return [];

  const withTime = items
    .map((item) => ({
      item,
      time: item.takenAt ?? item.mtimeMs,
      burstKey: burstFilenameKey(item.name),
    }))
    .sort((a, b) => a.time - b.time);

  // Walk consecutive photos (in chronological order), merging into a
  // running cluster whenever either the gap is within gapMs, or both
  // photos share the same Pixel burst-filename prefix (a hard-link
  // override for the rare case a genuine burst's timestamps land wider
  // apart than gapMs).
  const clusters = [];
  let current = [withTime[0]];
  for (let i = 1; i < withTime.length; i++) {
    const prev = current[current.length - 1];
    const cur = withTime[i];
    const withinGap = cur.time - prev.time <= gapMs;
    const sameBurst = prev.burstKey !== null && prev.burstKey === cur.burstKey;
    if (withinGap || sameBurst) {
      current.push(cur);
    } else {
      clusters.push(current);
      current = [cur];
    }
  }
  clusters.push(current);

  return clusters
    .filter((cluster) => cluster.length >= 2)
    .map((cluster) => {
      const coverId = pickCover(cluster);
      return {
        id: `burst-${coverId}`,
        memberIds: cluster.map((c) => c.item.id),
        coverId,
        count: cluster.length,
      };
    });
}

const BURST_FILENAME_RE = /^(.*)\.BURST-\d+(?:\.COVER)?\.[^.]+$/i;
const COVER_FILENAME_RE = /\.COVER\.[^.]+$/i;

/** Returns the shared prefix for same-burst files, or null if not a burst filename. */
function burstFilenameKey(name) {
  const m = BURST_FILENAME_RE.exec(name);
  return m ? m[1].toLowerCase() : null;
}

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/lib/bursts.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — all existing suites (`justified.test.js`, `windowing.test.js`, `safeResolve.test.js`, `api.test.js`, `ProcessingService.test.js`) plus the new `bursts.test.js` are green.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/bursts.js ui/src/lib/bursts.test.js
git commit -m "$(cat <<'EOF'
feat: add detectBursts pure function for burst-photo grouping

Groups photos by chronological proximity (the primary, broad mechanism
— covers manually-fired rapid shots, not just camera burst mode), with
a Pixel burst-filename hard-link override so genuine burst-mode
sequences stay grouped even if their timestamps land wider apart than
the gap threshold. Cover priority: highest-rated member, else the
filename-marked COVER file, else chronologically-first.

Part 1 of GitHub issue #2 (Burst stacks) — grid/UI integration
(cover tile, count badge, expand/compare, keyboard/rating, Loupe
navigation) is a separate, not-yet-designed follow-up.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** unified time-gap + filename-hard-link algorithm ✓;
  cover priority (rated → COVER-marked → chronological-first) ✓;
  `takenAt`-missing fallback to `mtimeMs` ✓; minimum cluster size 2 ✓;
  items referenced by id only (no item objects embedded in output) ✓;
  out-of-scope items (UI integration, `gapMs` default/persistence, quality
  scoring) untouched by this plan ✓.
- **No placeholders:** the step contains complete, runnable code and a
  full test suite covering every scenario listed in the spec's Testing
  section.
- **Type/name consistency:** `detectBursts(items, { gapMs })` signature
  matches the spec's interface contract exactly; output shape
  (`id`, `memberIds`, `coverId`, `count`) is used consistently across the
  implementation and every test assertion.
