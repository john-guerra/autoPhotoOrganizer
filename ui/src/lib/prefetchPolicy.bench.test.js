import { describe, it, expect } from "vitest";
import {
  planPrefetch,
  PREFETCH_PRESETS,
  PREFETCH_CONFIG,
} from "./prefetchPolicy.js";

/**
 * Reproducible benchmark for scrolling under load — the prefetch policy AND the
 * loadMore page size, which turn out to be different problems.
 *
 * Two symptoms were reported on 2.16.4: (1) scrolling "feels slower", (2) "I
 * reach the end of the feed before it loads more" at small thumbs. A unit test
 * can't see a browser connection pool or a server threadpool, so we SIMULATE the
 * pipeline deterministically and score strategies. Costs are calibrated to live
 * measurements on the real 114k-photo library, cold cache (2026-07-16):
 *
 *   browser pool          6 sockets, HTTP/1.1 (one origin: UI + /api)
 *   server sharp pool     4 workers (libuv default) — generates cold thumbnails
 *   cold thumbnail gen    ~100ms once it has a worker (observed 118–690ms)
 *   /api/feed             ~40ms, SQLite read, NO worker (not sharp)
 *
 * Model: a thumbnail request holds a socket for its whole life AND needs a worker
 * to generate; a feed request needs only a socket. That two-stage structure is
 * what lets prefetch compete with visible tiles (workers) and the feed (sockets).
 *
 * HEADLINE RESULT (see the experiment matrix): "reach the end" is driven by the
 * loadMore PAGE SIZE, not by prefetch — a fixed 60-item page is a few hundred px
 * at the smallest zoom, far less than a fling consumes. Scaling the page to the
 * pixel-runway fixes it. Prefetch's real value is on WARM libraries.
 */

const PRI = { feed: 3, visible: 2, warm: 2, warmLow: 1 };

function simulate(cfg, scn) {
  const FRAME = 16;
  const pxPerItem = scn.rowHeight / scn.cols;
  const SOCKETS = scn.connections;
  const WORKERS = scn.workers ?? 4;
  let now = 0,
    loadedItems = scn.initialItems,
    fetchingFeed = false;
  const contentH = () => (loadedItems / scn.cols) * scn.rowHeight;
  const pool = []; // in-flight: {kind,pri,item,page,hasWorker,finish|null,socketAt}
  const queue = [];
  const requested = new Set();
  const warmed = new Set();
  const doneAt = new Map();
  const visAt = new Map();
  let blankFrames = 0,
    frames = 0,
    warmsFired = 0;

  const enq = (kind, pri, item) => queue.push({ kind, pri, item, enq: now });
  const inFlightWarms = () =>
    pool.filter((p) => p.kind === "warm").length +
    queue.filter((q) => q.kind === "warm").length;
  const busyWorkers = () => pool.filter((p) => p.hasWorker).length;

  function pump() {
    if (queue.length > 1) queue.sort((a, b) => b.pri - a.pri || a.enq - b.enq);
    while (pool.length < SOCKETS && queue.length) {
      const r = queue.shift();
      if (r.kind === "feed") {
        fetchingFeed = true;
        pool.push({ ...r, hasWorker: false, finish: now + scn.feedCost });
      } else {
        pool.push({ ...r, hasWorker: false, finish: null, socketAt: now });
      }
    }
    let free = WORKERS - busyWorkers();
    if (free > 0) {
      const waiting = pool
        .filter((p) => p.kind !== "feed" && !p.hasWorker && p.finish === null)
        .sort((a, b) => b.pri - a.pri || a.socketAt - b.socketAt);
      for (const t of waiting) {
        if (free <= 0) break;
        t.hasWorker = true;
        t.finish = now + scn.thumbGen;
        free--;
      }
    }
  }
  function reap() {
    for (let i = pool.length - 1; i >= 0; i--)
      if (pool[i].finish !== null && pool[i].finish <= now) {
        const r = pool.splice(i, 1)[0];
        if (r.kind === "feed") {
          loadedItems += r.page ?? scn.pageSize;
          fetchingFeed = false;
        } else doneAt.set(r.item, now);
      }
  }

  for (now = 0; now <= scn.durationMs; now++) {
    reap();
    const wantBottom = scn.viewportH + scn.velocity * now;
    const maxBottom = contentH();
    const bottom = Math.min(wantBottom, maxBottom);
    const scrollTop = Math.max(0, bottom - scn.viewportH);

    if (now % FRAME === 0) {
      frames++;
      if (wantBottom > maxBottom + 1) blankFrames++; // out-scrolled the loader

      const firstVis = Math.max(0, Math.floor(scrollTop / pxPerItem));
      const lastVis = Math.floor(bottom / pxPerItem);
      for (let it = firstVis; it <= lastVis && it < loadedItems; it++) {
        if (!visAt.has(it)) visAt.set(it, now);
        if (!requested.has(it)) {
          requested.add(it);
          enq("visible", PRI.visible, it);
        }
      }

      const belowRunway = maxBottom - bottom;
      const runway = Math.max(scn.minRunway, scn.viewportH * 2);
      const feedNeeded =
        belowRunway < runway && !fetchingFeed && loadedItems < scn.totalItems;
      const doFeed = () => {
        if (!feedNeeded) return;
        // pageSizeMode 'runway': fetch enough to refill ~2× the runway in PIXELS.
        const page =
          scn.pageSizeMode === "runway"
            ? Math.max(scn.pageSize, Math.ceil((runway * 2) / pxPerItem))
            : scn.pageSize;
        queue.push({ kind: "feed", pri: PRI.feed, item: -1, enq: now, page });
      };
      const doWarm = () => {
        const plan = planPrefetch(
          {
            velocity: scn.velocity,
            direction: "down",
            fetchingFeed,
            belowRunwayPx: belowRunway,
            runwayPx: runway,
            inFlight: inFlightWarms(),
          },
          cfg
        );
        if (plan.maxRequests <= 0) return;
        const endAhead = Math.floor((bottom + plan.aheadPx) / pxPerItem);
        let fired = 0;
        for (
          let it = lastVis + 1;
          it <= endAhead && it < loadedItems && fired < plan.maxRequests;
          it++
        ) {
          if (warmed.has(it) || requested.has(it)) continue;
          warmed.add(it);
          requested.add(it);
          enq("warm", cfg.lowPriority ? PRI.warmLow : PRI.warm, it);
          fired++;
          warmsFired++;
        }
      };
      if (cfg.loadMoreFirst) (doFeed(), doWarm());
      else (doWarm(), doFeed());
    }
    pump();
  }

  const lat = [];
  let hits = 0;
  for (const [it, vt] of visAt) {
    const dt = doneAt.has(it) ? doneAt.get(it) : scn.durationMs;
    lat.push(Math.max(0, dt - vt));
    if (doneAt.has(it) && doneAt.get(it) <= vt) hits++;
  }
  lat.sort((a, b) => a - b);
  return {
    blankPct: Math.round((blankFrames / frames) * 100),
    visP90: lat.length
      ? Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))])
      : 0,
    warmHit: visAt.size ? +(hits / visAt.size).toFixed(2) : 0,
    warmsFired,
  };
}

// --- Scenarios (calibrated to the live measurements) ------------------------
const base = {
  connections: 6,
  workers: 4,
  thumbGen: 100,
  feedCost: 40,
  pageSize: 60,
  viewportH: 1000,
  minRunway: 1200,
  totalItems: 20000,
  durationMs: 4000,
};
// enough initial content that t=0 is not blank (contentH ≥ viewport + runway).
const withInit = (s) => ({
  ...s,
  initialItems: Math.ceil((3200 * s.cols) / s.rowHeight),
});
const SMALL_FAST = withInit({ ...base, rowHeight: 54, cols: 18, velocity: 6 }); // smallest thumbs
const MODERATE_FAST = withInit({
  ...base,
  rowHeight: 150,
  cols: 6,
  velocity: 9,
});
const WARM = withInit({
  ...base,
  thumbGen: 8,
  rowHeight: 200,
  cols: 5,
  velocity: 3,
});

describe("scroll-under-load benchmark", () => {
  it("experiment matrix (scored, logged)", () => {
    const strategies = { ...PREFETCH_PRESETS };
    const scenarios = { SMALL_FAST, MODERATE_FAST, WARM };
    const rows = [];
    for (const [name, cfg] of Object.entries(strategies)) {
      const row = { strategy: name };
      for (const [sn, scn] of Object.entries(scenarios)) {
        const m = simulate(cfg, scn);
        row[`${sn}·blank%`] = m.blankPct;
        row[`${sn}·warmHit`] = m.warmHit;
      }
      rows.push(row);
    }
    // Page-size experiment: fixed 60 vs runway-scaled, at the smallest zoom.
    const fixed = simulate(PREFETCH_CONFIG, SMALL_FAST).blankPct;
    const scaled = simulate(PREFETCH_CONFIG, {
      ...SMALL_FAST,
      pageSizeMode: "runway",
    }).blankPct;
    // eslint-disable-next-line no-console
    console.log(
      "\n[benchmark] strategy × scenario (blank% / warmHit):\n" +
        rows.map((r) => "  " + JSON.stringify(r)).join("\n") +
        `\n[benchmark] loadMore page size @ smallest zoom: fixed-60 blank=${fixed}%  →  runway-scaled blank=${scaled}%\n`
    );
    expect(rows.length).toBe(Object.keys(PREFETCH_PRESETS).length);
  });

  it("THE fix for 'reach the end': scaling loadMore page to the runway (not prefetch)", () => {
    // Same scenario, same prefetch — only the page-size policy differs.
    const fixed = simulate(PREFETCH_CONFIG, SMALL_FAST).blankPct;
    const scaled = simulate(PREFETCH_CONFIG, {
      ...SMALL_FAST,
      pageSizeMode: "runway",
    }).blankPct;
    expect(fixed).toBeGreaterThan(30); // fixed 60-item page starves at small zoom
    expect(scaled).toBeLessThan(3); // runway-scaled page keeps up
  });

  it("prefetch is NOT the cause of 'reach the end' (off ≈ baseline blank%)", () => {
    // Turning prefetch off does not fix the small-zoom starvation — proves the
    // page size is the culprit, not the warming.
    const off = simulate(PREFETCH_PRESETS.off, SMALL_FAST).blankPct;
    const base_ = simulate(PREFETCH_PRESETS.baseline, SMALL_FAST).blankPct;
    expect(Math.abs(off - base_)).toBeLessThan(5);
  });

  it("prefetch earns its keep on a WARM library (default beats off)", () => {
    const def = simulate(PREFETCH_CONFIG, WARM);
    const off = simulate(PREFETCH_PRESETS.off, WARM);
    expect(def.warmHit).toBeGreaterThan(off.warmHit);
    expect(def.warmHit).toBeGreaterThan(0.5);
  });

  it("the default is BOUNDED — it issues far fewer warms than unbounded baseline", () => {
    // The safety property: on a cold fast fling, the shipped policy caps
    // outstanding warms; baseline (2.16.4) fires without limit.
    const def = simulate(PREFETCH_CONFIG, MODERATE_FAST).warmsFired;
    const base_ = simulate(PREFETCH_PRESETS.baseline, MODERATE_FAST).warmsFired;
    expect(def).toBeLessThan(base_);
  });

  it("the shipped default is the benchmark-chosen preset", () => {
    expect(PREFETCH_CONFIG).toBe(PREFETCH_PRESETS.balanced);
  });
});
