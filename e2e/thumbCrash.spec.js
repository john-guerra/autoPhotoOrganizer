import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { E2E_ROOT } from "./fixture.mjs";
import { openApp, trackPageErrors } from "./helpers.js";

// Regression guard for #174: Thumb.svelte "Cannot read properties of undefined
// (reading 'y')".
//
// The crash is `boxes[i]` undefined for a rendered index. On clean code `boxes`
// and `displayEntries` derive from the same source in lock-step and the render
// range is refreshed in an `$effect.pre` before `visibleItems` is read, so a
// stale index can't strand `boxes[i]` on the steady path — the original crash
// was a cascade from the #172 tree crash (fired 5+ times right after it, same
// session), and #172 is fixed. This spec exists so a #172-style regression that
// desyncs state mid-render is caught HERE rather than by a user's white screen:
// it hammers the shrink-while-scrolled paths that would strand a render index —
// groupBy changes (incl. removing a dimension, #172's exact trigger) and in-place
// filter shrinks, with the feed flung deep — and fails on ANY page error.

const DIR = join(E2E_ROOT, "thumbcrash");
// Nested folders + varied dates/cameras so folder/day/camera groupings each
// reshape the feed differently — the reshaping is what can strand a render index.
const FOLDERS = [
  "2029_01Jan A/cam1",
  "2029_01Jan A/cam2",
  "2029_02Feb B/cam1",
  "2029_03Mar C",
];
const PER = 35;

test.beforeAll(async ({ request }) => {
  rmSync(DIR, { recursive: true, force: true });
  for (const [f, name] of FOLDERS.entries()) {
    const d = join(DIR, name);
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < PER; i++) {
      const mm = String((f % 3) + 1).padStart(2, "0");
      await sharp({
        create: {
          width: 100 + (i % 4) * 30,
          height: 80 + (i % 3) * 40,
          channels: 3,
          background: { r: 30 + f * 40, g: 70 + i, b: 180 },
        },
      })
        .withMetadata({
          exif: {
            IFD0: { Model: `Cam${(f % 2) + 1}` },
            IFD2: {
              DateTimeOriginal: `2029:${mm}:0${(i % 8) + 1} 09:${String(i % 60).padStart(2, "0")}:00`,
            },
          },
        })
        .jpeg()
        .toFile(join(d, `t_${f}_${String(i).padStart(3, "0")}.jpg`));
    }
  }
  const res = await request.post("/api/scan", {
    data: { dir: DIR, recursive: true },
    timeout: 120_000,
  });
  expect(res.ok()).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await request.post("/api/folders/remove", { data: { path: DIR } });
  rmSync(DIR, { recursive: true, force: true });
});

/** Seed groupBy via localStorage and reload (the app reads it on boot). */
async function regroup(page, dims) {
  await page.evaluate((d) => {
    window.localStorage.setItem("autogallery.groupBy", JSON.stringify(d));
  }, dims);
  await page.reload();
  await expect(page.locator(".thumb").first()).toBeVisible();
}

test("shrink-while-scrolled churn never crashes a tile", async ({ page }) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder", "day"] });

  const scroller = page.locator(".main-column");

  // Repeatedly: scroll deep (large render window), then reshape the feed so
  // displayEntries shrinks/reorders under that window.
  const shapes = [
    ["folder"],
    ["day"],
    ["camera"],
    ["folder", "day"],
    ["day", "camera"],
    ["camera"], // removing dimensions — #172's exact trigger
    ["folder"],
  ];
  for (const shape of shapes) {
    // Fling to the bottom so renderStart/renderEnd sit deep in the list.
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(150);
    await regroup(page, shape);
    // Immediately fling again before metadata settles, then let it settle.
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(300);
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(200);
    expect(errors, `after regrouping to ${shape.join(",")}`).toEqual([]);
  }

  expect(errors).toEqual([]);
});

test("in-place filter/fold shrink while scrolled deep never crashes a tile", async ({
  page,
}) => {
  // The sharper repro: reshape displayEntries IN PLACE (no reload), so
  // renderStart/renderEnd persist stale across the shrink — the exact state a
  // stale render index needs. A reload would reset them and hide the bug.
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder", "day"] });

  const scroller = page.locator(".main-column");
  const search = page.locator(".search-input");

  for (let round = 0; round < 4; round++) {
    // Deep scroll → large render window.
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(150);

    // In-place shrink to a handful of results (or none), THEN immediately try to
    // scroll — the render loop reads boxes[i] for the old window against the new,
    // shorter displayEntries in the same frame if the guard is imperfect.
    await search.fill("cam1");
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(120);
    await search.fill("no-such-photo-xyz"); // shrink to zero
    await page.waitForTimeout(120);
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await search.fill(""); // grow back
    await page.waitForTimeout(200);
    expect(errors, `round ${round}`).toEqual([]);
  }

  expect(errors).toEqual([]);
});
