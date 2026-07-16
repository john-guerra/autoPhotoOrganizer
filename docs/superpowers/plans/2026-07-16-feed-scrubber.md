# Feed Sort-Aware Scrubber Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-edge scrubber rail that shows the whole library's shape for the
current sort/grouping, tracks the viewport, and jumps on click — plus a follow-on
skeleton-in-reserve that fills fast-fling voids (issue #132).

**Architecture:** One shared landmark manifest (reuse `GET /api/tree/flat` /
`getFlatTree`), a pure `scale.js` math module (count & value axes), a thin
`Scrubber.svelte` renderer, and navigation exclusively through the existing guarded
`jumpToPath`/`jumpGroupBoundary`. No new server jump machinery; density for date
sorts reuses `/api/times`.

**Tech Stack:** Svelte 5 runes, d3 (KDE/scales already in-repo), vitest, Playwright,
Express (existing endpoints only for stages 1–4).

Spec: `docs/superpowers/specs/2026-07-16-feed-scrubber-and-skeleton-design.md`.

## Global Constraints

- **ESM** everywhere; **no TypeScript** — plain JS with JSDoc types.
- New components are **Svelte 5 runes** (`$state`/`$derived`/`$props`/`$bindable`);
  a component is all-runes or all-legacy, never half.
- **vitest** tests colocated as `*.test.js`; **Playwright** e2e in `e2e/` with
  `trackPageErrors(page)` in every spec; selectors live in `e2e/helpers.js`.
- **Prettier** must pass (`npm run format:check`).
- **Every change bumps `package.json` version (patch) + a `CHANGELOG.md` line** in
  the same commit; newest first; user-facing wording.
- **Every new/changed keyboard shortcut is documented in
  `ui/src/lib/ShortcutsOverlay.svelte` in the same commit.**
- The scrubber **navigates only** via `jumpToPath`/`recenterFeedOnId`/
  `jumpGroupBoundary`; it never mutates `items`/`feedEpoch` or hand-rolls a fetch
  guard (issues #35/#36/#39/#42).
- Commit at every green checkpoint.
- A fixed bug gets a test at the tier that would have caught it; revert-check new
  tests go red before committing.

---

## File structure

- Create `ui/src/lib/scrubber/scale.js` — pure manifest + axis math (no DOM, no Svelte).
- Create `ui/src/lib/scrubber/scale.test.js` — colocated vitest.
- Create `ui/src/lib/Scrubber.svelte` — the rail renderer (runes).
- Modify `ui/src/lib/api.js` — reuse existing `fetchFlatTree`; add `fetchTimes` is
  already there. (No new client fn unless noted.)
- Modify `ui/src/App.svelte` — manifest fetch/cache state, `scrubberAxis` state,
  mount `<Scrubber>`, wire click/drag/keys, reserve rail width.
- Modify `ui/src/lib/SettingsPanel.svelte` — the axis control.
- Modify `ui/src/lib/ShortcutsOverlay.svelte` — `[` / `]` rows.
- Create `e2e/scrubber.spec.js` + add selectors to `e2e/helpers.js`.

Stage 5 (skeleton-in-reserve) is planned at outline level here and gets a detailed
TDD pass of its own once stages 1–4 land and the manifest is live (its exact layout
shape depends on measuring the real manifest against the justified layout).

---

## Task 1: Pure scale module — manifest + count axis

**Files:**

- Create: `ui/src/lib/scrubber/scale.js`
- Test: `ui/src/lib/scrubber/scale.test.js`

**Interfaces:**

- Consumes: the `/api/tree/flat` response shape
  `{ total, leaves: [{ values: Record<string,string>, count }] }`.
- Produces:
  - `buildManifest(flat, { groupBy })` → `{ total, landmarks, cumStart }` where
    `landmarks: [{ key, label, value, startCount, count, path }]` (one per distinct
    value of the **coarsest** dim, `path` = `[{ dimension, value }]`), and
    `cumStart: number[]` is the prefix-sum of leaf counts (length = leaves.length+1).
  - `countToY(n, total, railH)` → `number`; `yToCount(y, total, railH)` → `number`.
  - `landmarkAtCount(manifest, n)` → the landmark whose `[startCount, startCount+count)`
    contains `n` (or the last one).

- [ ] **Step 1: Write the failing test**

```js
// ui/src/lib/scrubber/scale.test.js
import { describe, it, expect } from "vitest";
import { buildManifest, countToY, yToCount, landmarkAtCount } from "./scale.js";

const flat = {
  total: 10,
  leaves: [
    { values: { year: "2009", month: "01" }, count: 3 },
    { values: { year: "2009", month: "02" }, count: 5 },
    { values: { year: "2010", month: "01" }, count: 2 },
  ],
};

describe("buildManifest", () => {
  it("collapses leaves to coarsest-dim landmarks with cumulative starts", () => {
    const m = buildManifest(flat, { groupBy: ["year", "month"] });
    expect(m.total).toBe(10);
    expect(m.landmarks.map((l) => [l.value, l.startCount, l.count])).toEqual([
      ["2009", 0, 8],
      ["2010", 8, 2],
    ]);
    // path is what jumpToPath consumes: [{ dimension, value }]
    expect(m.landmarks[0].path).toEqual([{ dimension: "year", value: "2009" }]);
    // prefix sums over the leaves (length n+1)
    expect(m.cumStart).toEqual([0, 3, 8, 10]);
  });
});

describe("countToY / yToCount", () => {
  it("maps cumulative count to rail y and back", () => {
    expect(countToY(0, 10, 200)).toBe(0);
    expect(countToY(5, 10, 200)).toBe(100);
    expect(countToY(10, 10, 200)).toBe(200);
    expect(yToCount(100, 10, 200)).toBe(5);
  });

  it("is safe when total is 0 (empty feed)", () => {
    expect(countToY(0, 0, 200)).toBe(0);
    expect(yToCount(50, 0, 200)).toBe(0);
  });
});

describe("landmarkAtCount", () => {
  it("finds the landmark whose count range contains n", () => {
    const m = buildManifest(flat, { groupBy: ["year", "month"] });
    expect(landmarkAtCount(m, 0).value).toBe("2009");
    expect(landmarkAtCount(m, 7).value).toBe("2009");
    expect(landmarkAtCount(m, 8).value).toBe("2010");
    expect(landmarkAtCount(m, 999).value).toBe("2010"); // clamps to last
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/lib/scrubber/scale.test.js`
Expected: FAIL — `buildManifest is not a function` (module absent).

- [ ] **Step 3: Write minimal implementation**

```js
// ui/src/lib/scrubber/scale.js
/**
 * Pure math for the feed scrubber. No DOM, no Svelte. Turns the /api/tree/flat
 * response into coarse landmarks + cumulative counts and maps between cumulative
 * count and rail pixels (the count axis). See the design spec.
 */

/**
 * @param {{ total:number, leaves:Array<{values:Record<string,string>,count:number}> }} flat
 * @param {{ groupBy: string[] }} opts  ordered grouping dims (coarsest first)
 * @returns {{ total:number, landmarks:Array<{key:string,label:string,value:string,startCount:number,count:number,path:Array<{dimension:string,value:string}>}>, cumStart:number[] }}
 */
export function buildManifest(flat, { groupBy }) {
  const coarse = groupBy?.[0];
  const leaves = flat.leaves ?? [];
  const cumStart = [0];
  for (let i = 0; i < leaves.length; i++)
    cumStart.push(cumStart[i] + leaves[i].count);

  const landmarks = [];
  let running = 0;
  let current = null;
  for (const leaf of leaves) {
    const value = coarse ? (leaf.values[coarse] ?? "") : "";
    if (!current || current.value !== value) {
      current = {
        key: value,
        label: value,
        value,
        startCount: running,
        count: 0,
        path: coarse ? [{ dimension: coarse, value }] : [],
      };
      landmarks.push(current);
    }
    current.count += leaf.count;
    running += leaf.count;
  }
  return { total: flat.total ?? running, landmarks, cumStart };
}

/** Cumulative count → rail pixel y. */
export function countToY(n, total, railH) {
  if (!(total > 0)) return 0;
  return (n / total) * railH;
}

/** Rail pixel y → cumulative count. */
export function yToCount(y, total, railH) {
  if (!(total > 0) || !(railH > 0)) return 0;
  return (y / railH) * total;
}

/** The landmark whose [startCount, startCount+count) contains n (clamped to last). */
export function landmarkAtCount(manifest, n) {
  const ls = manifest.landmarks;
  if (!ls.length) return null;
  for (let i = ls.length - 1; i >= 0; i--)
    if (n >= ls[i].startCount) return ls[i];
  return ls[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/lib/scrubber/scale.test.js`
Expected: PASS (all describes green).

- [ ] **Step 5: Commit** (no version bump — pure module, no user-visible change yet; fold into Task 3's bump, OR bump now if committing standalone)

```bash
git add ui/src/lib/scrubber/scale.js ui/src/lib/scrubber/scale.test.js
git commit -m "feat(scrubber): pure manifest + count-axis scale module"
```

---

## Task 2: Value axis + landmark thinning + labels

**Files:**

- Modify: `ui/src/lib/scrubber/scale.js`
- Modify: `ui/src/lib/scrubber/scale.test.js`

**Interfaces:**

- Consumes: `buildManifest` output from Task 1; sort descriptor `{ by, dir }`.
- Produces:
  - `axisScale(axis, manifest, railH, { valueOf })` → `{ toY(landmark), fromY(y) }`.
    `axis` is `"count"` or `"value"`. For `"value"`, positions use
    `valueOf(landmark)` linearly between min/max; when `valueOf` returns non-finite
    for any landmark (categorical/folder) it **falls back to the count axis**.
  - `thinLabels(landmarks, railH, minGapPx, axisToY)` → subset of landmarks whose
    label should render (greedy, keeps first, drops any closer than `minGapPx`).
  - `landmarkLabel(landmark, { groupBy, sort })` → display string (year "2010",
    month "Mar 2010", folder leaf name, camera/kind value).

- [ ] **Step 1: Write the failing test**

```js
// append to scale.test.js
import { axisScale, thinLabels, landmarkLabel } from "./scale.js";

describe("axisScale value axis", () => {
  const m = {
    total: 10,
    landmarks: [
      { value: "2009", startCount: 0, count: 8 },
      { value: "2010", startCount: 8, count: 2 },
    ],
  };
  it("positions by value when valueOf is finite", () => {
    const s = axisScale("value", m, 200, { valueOf: (l) => Number(l.value) });
    expect(s.toY(m.landmarks[0])).toBe(0); // 2009 -> min -> top
    expect(s.toY(m.landmarks[1])).toBe(200); // 2010 -> max -> bottom
  });
  it("falls back to count axis when valueOf is non-finite (categorical)", () => {
    const s = axisScale("value", m, 200, { valueOf: () => NaN });
    // count axis: 2010 starts at 8/10 -> 160
    expect(s.toY(m.landmarks[1])).toBe(160);
  });
});

describe("thinLabels", () => {
  it("drops labels closer than the min gap", () => {
    const ls = [
      { value: "a", startCount: 0 },
      { value: "b", startCount: 1 },
      { value: "c", startCount: 50 },
    ];
    const toY = (l) => l.startCount; // 1px per count for the test
    const kept = thinLabels(ls, 100, 10, toY).map((l) => l.value);
    expect(kept).toEqual(["a", "c"]); // b at y=1 is within 10px of a at y=0
  });
});

describe("landmarkLabel", () => {
  it("formats by dimension type", () => {
    expect(
      landmarkLabel(
        { path: [{ dimension: "year", value: "2010" }], value: "2010" },
        { groupBy: ["year"], sort: { by: "date_taken" } }
      )
    ).toBe("2010");
    expect(
      landmarkLabel(
        {
          path: [{ dimension: "folder", value: "/a/b/Trip" }],
          value: "/a/b/Trip",
        },
        { groupBy: ["folder"], sort: { by: "date_taken" } }
      )
    ).toBe("Trip");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run ui/src/lib/scrubber/scale.test.js`
Expected: FAIL — `axisScale is not a function`.

- [ ] **Step 3: Implement**

```js
// append to scale.js

/** @returns {{toY:(l:any)=>number, fromY:(y:number)=>number}} */
export function axisScale(axis, manifest, railH, { valueOf } = {}) {
  const total = manifest.total;
  const countToYLocal = (l) => countToY(l.startCount, total, railH);
  if (axis !== "value" || !valueOf) {
    return { toY: countToYLocal, fromY: (y) => yToCount(y, total, railH) };
  }
  const vals = manifest.landmarks.map((l) => valueOf(l));
  const finite = vals.every((v) => Number.isFinite(v));
  if (!finite) {
    // categorical/folder — no metric to space by; fall back to count.
    return { toY: countToYLocal, fromY: (y) => yToCount(y, total, railH) };
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  return {
    toY: (l) => ((valueOf(l) - min) / span) * railH,
    fromY: (y) => min + (y / railH) * span,
  };
}

/** Greedy label thinning: keep the first, drop any whose y is within minGapPx. */
export function thinLabels(landmarks, railH, minGapPx, toY) {
  const kept = [];
  let lastY = -Infinity;
  for (const l of landmarks) {
    const y = toY(l);
    if (y - lastY >= minGapPx) {
      kept.push(l);
      lastY = y;
    }
  }
  return kept;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Display label for a landmark, by its coarsest dimension. */
export function landmarkLabel(landmark, { groupBy }) {
  const dim = groupBy?.[0];
  const v = landmark.value;
  if (dim === "folder" || dim === "folderName") {
    const parts = String(v).split("/").filter(Boolean);
    return parts[parts.length - 1] || v;
  }
  if (dim === "month") {
    const idx = Number(v) - 1;
    return MONTHS[idx] ?? v;
  }
  return String(v); // year, camera, kind, day
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run ui/src/lib/scrubber/scale.test.js`
Expected: PASS.

- [ ] **Step 5: Revert-check + commit**

Temporarily change `axisScale`'s fallback to always position by value; run the
categorical test and watch it go red; restore. Then:

```bash
git add ui/src/lib/scrubber/scale.js ui/src/lib/scrubber/scale.test.js
git commit -m "feat(scrubber): value axis, label thinning, type-aware labels"
```

---

## Task 3: Scrubber component (render only) + manifest wiring + version bump

**Files:**

- Create: `ui/src/lib/Scrubber.svelte`
- Modify: `ui/src/App.svelte` (manifest state, mount the rail, reserve width)
- Modify: `package.json`, `CHANGELOG.md`

**Interfaces:**

- Consumes: `buildManifest`, `axisScale`, `thinLabels`, `landmarkLabel` (Tasks 1–2);
  `fetchFlatTree(groupBy, filter, sort)` (`ui/src/lib/api.js:785`).
- Produces: `<Scrubber manifest axis sort groupBy topCount viewportCount railH
onjump onscrubto />` — a presentational rail. `onjump(path)` and
  `onscrubto(count)` are callbacks App wires to the feed.

- [ ] **Step 1: Manifest state in App.svelte.** Add runes state and an effect that
      fetches `/api/tree/flat` keyed on `(groupBy, sort, filter)` and builds the
      manifest, keeping the previous one painted until the new arrives (morph-don't-blank).

```svelte
<!-- App.svelte, near other feed state -->
<script>
  import { buildManifest } from "./lib/scrubber/scale.js";
  import { fetchFlatTree } from "./lib/api.js";
  import Scrubber from "./lib/Scrubber.svelte";

  let scrubberManifest = $state(null);
  let scrubberSig = "";

  $effect(() => {
    const sig = JSON.stringify({ groupBy, sort, filter: displayFilter });
    if (sig === scrubberSig) return;
    scrubberSig = sig;
    const mine = sig;
    fetchFlatTree(groupBy, displayFilter, sort)
      .then((flat) => {
        if (mine !== scrubberSig) return; // a newer request won
        scrubberManifest = buildManifest(flat, { groupBy });
      })
      .catch(() => {}); // rail is non-critical; never break the feed
  });
</script>
```

- [ ] **Step 2: Write `Scrubber.svelte`** — a runes component that draws the density
      track, thinned landmark labels, and the viewport thumb. Positions come only from
      `scale.js`. (Full component; ~120 lines. Density: for date sorts draw the KDE from
      a `times` prop, else manifest bars — the KDE prop is added in Task 4; Task 3 draws
      manifest bars only.)

```svelte
<!-- ui/src/lib/Scrubber.svelte -->
<script>
  import { axisScale, thinLabels, landmarkLabel } from "./scrubber/scale.js";

  let {
    manifest,
    axis = "count",
    groupBy = [],
    sort = { by: "date_taken", dir: "asc" },
    topCount = 0,
    viewportCount = 0,
    onjump,
    onscrubto,
  } = $props();

  let railEl = $state(null);
  let railH = $state(0);

  // Value getter for the value-axis (finite only for date/numeric coarse dims).
  const valueOf = (l) => {
    const n = Number(l.value);
    return Number.isFinite(n) ? n : NaN;
  };
  const scale = $derived(
    manifest ? axisScale(axis, manifest, railH, { valueOf }) : null
  );
  const labels = $derived(
    manifest && scale
      ? thinLabels(manifest.landmarks, railH, 22, scale.toY)
      : []
  );
  const thumbTop = $derived(
    manifest && scale
      ? manifest.total
        ? (topCount / manifest.total) * railH
        : 0
      : 0
  );
  const thumbH = $derived(
    manifest && manifest.total
      ? Math.max(18, (viewportCount / manifest.total) * railH)
      : 0
  );
</script>

<div
  class="scrubber"
  bind:this={railEl}
  bind:clientHeight={railH}
  role="scrollbar"
  aria-label="Feed scrubber"
  aria-controls="feed-grid"
  aria-valuenow={Math.round(thumbTop)}
>
  {#if manifest}
    <!-- density: one bar per landmark, length by count -->
    <div class="track">
      {#each manifest.landmarks as l (l.key)}
        <div
          class="bar"
          style="top:{scale.toY(l)}px; height:{Math.max(
            1,
            (l.count / manifest.total) * railH
          )}px;"
        ></div>
      {/each}
    </div>
    <!-- labels -->
    {#each labels as l (l.key)}
      <button
        class="label"
        style="top:{scale.toY(l)}px;"
        onclick={() => onjump?.(l.path)}
        title={`${landmarkLabel(l, { groupBy, sort })} · ${l.count}`}
      >
        {landmarkLabel(l, { groupBy, sort })}
      </button>
    {/each}
    <!-- viewport thumb -->
    <div class="thumb" style="top:{thumbTop}px; height:{thumbH}px;"></div>
  {/if}
</div>

<style>
  .scrubber {
    position: relative;
    width: 100%;
    height: 100%;
    user-select: none;
  }
  .track {
    position: absolute;
    inset: 0;
  }
  .bar {
    position: absolute;
    right: 0;
    width: 6px;
    background: #3a4a63;
    border-radius: 2px;
  }
  .label {
    position: absolute;
    right: 10px;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: #9fb3d1;
    font-size: 10px;
    white-space: nowrap;
    cursor: pointer;
    padding: 0 2px;
  }
  .label:hover {
    color: #cfe0ff;
  }
  .thumb {
    position: absolute;
    right: 0;
    width: 10px;
    background: rgba(138, 180, 255, 0.35);
    border: 1px solid #8ab4ff;
    border-radius: 5px;
    pointer-events: none;
  }
</style>
```

- [ ] **Step 3: Mount `<Scrubber>` in App.svelte** in a fixed right-edge column and
      give the grid area room for it (reserve ~40px on the right of the feed column).
      Pass `topCount` derived from the top-visible group's `startCount`
      (`deriveCurrentPath(renderStart, …)` → find landmark → startCount) and
      `viewportCount` estimated from the on-screen entry count.

```svelte
<Scrubber
  manifest={scrubberManifest}
  axis={scrubberAxis}
  {groupBy}
  {sort}
  topCount={scrubberTopCount}
  viewportCount={scrubberViewportCount}
  onjump={(path) => jumpToPath(path)}
  onscrubto={(count) => scrubToCount(count)}
/>
```

where `scrubberTopCount` is `$derived` from the current top group path mapped
through the manifest, and `scrubToCount`/drag wiring lands in Task 5.

- [ ] **Step 4: Verify build + tests + live render.** Run `npm test` (all green),
      reload the app, confirm the rail shows landmarks (years/folders) and a thumb that
      moves as you scroll. No console errors (`read_console_messages`).

- [ ] **Step 5: Bump + commit.** `package.json` → next patch (e.g. `2.16.8`);
      `CHANGELOG.md` `## 2.16.8` line ("A scrubber rail on the right edge shows where you
      are in the library and lets you click a year/folder to jump there").

```bash
git add ui/src/lib/Scrubber.svelte ui/src/App.svelte package.json CHANGELOG.md
git commit -m "feat(scrubber): right-edge rail with landmarks + viewport thumb (2.16.8)"
```

---

## Task 4: KDE density for date sorts + axis Settings toggle

**Files:**

- Modify: `ui/src/lib/Scrubber.svelte` (KDE track for date sorts)
- Modify: `ui/src/App.svelte` (`scrubberAxis` state + persistence; pass `times`)
- Modify: `ui/src/lib/SettingsPanel.svelte` (axis control)
- Modify: `package.json`, `CHANGELOG.md`

**Interfaces:**

- Consumes: `fetchTimes(filter)` (`ui/src/lib/api.js:592`) → `{ times, total, min, max }`;
  `loadSetting`/`saveSetting` (`ui/src/lib/settings.js`); d3 (`d3` dependency).
- Produces: `scrubberAxis` bindable state on App; `<Scrubber times={…}>` prop.

- [ ] **Step 1: `scrubberAxis` state + persistence in App.svelte** (mirror
      `prefetchPreset`):

```svelte
<script>
  import { loadSetting, saveSetting } from "./lib/settings.js";
  let scrubberAxis = $state(loadSetting("scrubberAxis", "count"));
  $effect(() => saveSetting("scrubberAxis", scrubberAxis));
</script>
```

- [ ] **Step 2: Fetch `/api/times` for date sorts** and pass to `<Scrubber>` as
      `times`. Gate on `isDateSort(sort.by)` client-side (mirror the server list
      `date_taken`/`date_created`/`date_modified`), keyed on `(sort, filter)`; leave
      `times = null` for non-date sorts.

- [ ] **Step 3: Add the axis control to `SettingsPanel.svelte`** — a new "Scrubber"
      section with a `<select>` bound to `scrubberAxis` (`bindable` prop), options
      "By photo count (tracks scroll)" / "By sort value (date & numeric)", plus the
      fallback hint. Follow the existing section markup.

- [ ] **Step 4: KDE track in `Scrubber.svelte`.** When `times` is present, compute a
      d3 kernel-density estimate over the down-sampled timestamps and draw it as an area
      path positioned by the active axis (value axis → time directly; count axis →
      re-place samples by cumulative rank). Fall back to the manifest bars when `times`
      is null. Unit-test the KDE binning helper if extracted to `scale.js`
      (`densityBins(times, min, max, bins)` → number[]), revert-check it.

- [ ] **Step 5: Live-verify + bump + commit.** Toggle the axis in Settings; confirm
      the rail re-renders live (count ↔ value) and dates show the smooth scent. Bump
      patch; CHANGELOG ("Scrubber density now shows a date 'scent' and you can switch it
      between tracking scroll and tracking the date, in Settings").

```bash
git add ui/src/lib/Scrubber.svelte ui/src/App.svelte ui/src/lib/SettingsPanel.svelte package.json CHANGELOG.md
git commit -m "feat(scrubber): KDE date density + count/value axis Settings toggle (2.16.9)"
```

---

## Task 5: Interaction — drag-scrub, keyboard, hover fisheye

**Files:**

- Modify: `ui/src/lib/Scrubber.svelte` (pointer drag, hover magnify)
- Modify: `ui/src/App.svelte` (`scrubToCount`, `[`/`]` handlers)
- Modify: `ui/src/lib/ShortcutsOverlay.svelte` (`[` / `]` rows)
- Create: `e2e/scrubber.spec.js`; Modify: `e2e/helpers.js`
- Modify: `package.json`, `CHANGELOG.md`

**Interfaces:**

- Consumes: `yToCount`/`landmarkAtCount` (Task 1); `jumpToPath` and
  `jumpGroupBoundary` (`App.svelte:1999`, `:4610`); `@john-guerra/fisheye-nav`.
- Produces: `scrubToCount(count)` on App (maps count → nearest landmark → jumpToPath,
  one in-flight jump).

- [ ] **Step 1: `scrubToCount` in App.svelte** — pure-ish handler that maps a
      cumulative count to the containing landmark and calls `jumpToPath(landmark.path)`,
      guarded so only one scrub jump is in flight (reuse a boolean gate; never touch
      `items`/`feedEpoch`).

- [ ] **Step 2: Drag in `Scrubber.svelte`** — pointerdown on the rail/thumb →
      pointermove maps y through `scale.fromY` to a count → `onscrubto(count)` throttled
      to one in-flight; show a floating preview label (`landmarkAtCount`); pointerup
      commits. Capture the pointer; clean up listeners on up/cancel.

- [ ] **Step 3: `[` / `]` in App.svelte's `onKeydown`** — hop to prev/next coarse
      landmark via `jumpGroupBoundary(direction)`; guard against inputs/overlays like the
      other shortcuts. Add the two rows to `ShortcutsOverlay.svelte` (Navigation group):
      `{ keys: "[", label: "Jump to the previous landmark (scrubber)" }` and `]` next.

- [ ] **Step 4: Hover fisheye** — on pointermove over the rail (not dragging),
      magnify nearby labels using `@john-guerra/fisheye-nav` so a dense rail stays
      scannable; reset on leave.

- [ ] **Step 5: e2e spec** (`e2e/scrubber.spec.js`, `trackPageErrors`): load a
      grouped feed; assert the thumb sits at the top-visible group's position; click a
      landmark and assert the feed re-anchors to it (top group label matches); press `]`
      and assert the top group advanced. Selectors (`scrubber`, `scrubberLabel`,
      `scrubberThumb`) go in `e2e/helpers.js`.

- [ ] **Step 6: Run e2e + revert-check + bump + commit.**

```bash
npx playwright test e2e/scrubber.spec.js
git add ui/src/lib/Scrubber.svelte ui/src/App.svelte ui/src/lib/ShortcutsOverlay.svelte e2e/scrubber.spec.js e2e/helpers.js package.json CHANGELOG.md
git commit -m "feat(scrubber): drag-scrub, [ ] landmark keys, hover fisheye (2.16.10)"
```

---

## Task 6 (outline): Skeleton-in-reserve

Detailed TDD pass deferred until Tasks 1–5 land and the manifest is measured live
against the justified layout. Shape:

- Use `manifest.total` + loaded-window density to compute a real whole-library
  content height, replacing `BOTTOM_RESERVE_PX`.
- Below the loaded frontier, emit lightweight placeholder boxes (diagonal-stripe, no
  fetch) laid out by a simplified justified pass over manifest counts, plus coarse
  group headers positioned from the manifest.
- Live-verify against issue #132's fling repro (mounted set never voids; a fast fling
  lands on skeleton structure). Then retire the reserve hack from 2.16.6/2.16.7.
- Bump + CHANGELOG + close #132.

---

## Self-review notes

- **Spec coverage:** manifest (T1), count+value axes (T1/T2), labels by type (T2),
  Settings toggle (T4), KDE date density (T4), thumb (T3), click/drag/keys/fisheye
  (T5), morph-don't-blank (T3 effect), skeleton (T6). Flat-feed landmarks are spec'd
  as out-of-v1 and intentionally absent.
- **Guards:** every navigation path routes through `jumpToPath`/`jumpGroupBoundary`;
  the manifest effect never touches `items`/`feedEpoch`.
- **Naming consistency:** `buildManifest`/`axisScale`/`thinLabels`/`landmarkLabel`/
  `landmarkAtCount`/`countToY`/`yToCount` used identically across tasks.
