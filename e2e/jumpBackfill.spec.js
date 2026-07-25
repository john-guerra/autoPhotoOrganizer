import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { E2E_ROOT } from "./fixture.mjs";
import { openApp, tree, group } from "./helpers.js";

// After the drift-fix pin auto-releases, earlier folders must backfill on their
// own — the historical "stuck at top" worry. Jump to the SECOND folder (which
// has content before it) and, WITHOUT any user scroll, confirm the first
// folder's photos eventually mount above the landing.

const DIR = join(E2E_ROOT, "backfill");
const FOLDERS = ["2028_01Jan One", "2028_02Feb Two", "2028_03Mar Three"];
const PER = 40;

test.beforeAll(async ({ request }) => {
  rmSync(DIR, { recursive: true, force: true });
  for (const [f, name] of FOLDERS.entries()) {
    const d = join(DIR, name);
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < PER; i++) {
      const mm = String(f + 1).padStart(2, "0");
      await sharp({
        create: {
          width: 80,
          height: 200,
          channels: 3,
          background: { r: 30 + f * 60, g: 80, b: 200 - f * 40 },
        },
      })
        .withMetadata({
          exif: {
            IFD2: {
              DateTimeOriginal: `2028:${mm}:01 09:${String(i % 60).padStart(2, "0")}:00`,
            },
          },
        })
        .jpeg()
        .toFile(join(d, `b_${f}_${String(i).padStart(3, "0")}.jpg`));
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

const path = (name) => [{ dimension: "folder", value: join(DIR, name) }];

test("earlier folders backfill after a jump, with no user scroll", async ({
  page,
}) => {
  await page.route("**/api/meta**", async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });

  await openApp(page, { groupBy: ["folder"] });

  // The first folder's first photo — the content that must become reachable.
  const firstOfEarlier = await group.firstPhotoId(page, path(FOLDERS[0]));

  await tree.label(page, FOLDERS[1]).click();

  // The landing holds (drift fix).
  const target = await group.firstPhotoId(page, path(FOLDERS[1]));
  await expect(page.locator(`.thumb[data-id="${target}"]`)).toBeInViewport();

  await page.waitForTimeout(1200); // let the pin release + backfill run

  // "Not stuck" = earlier content is REACHABLE. Scroll up progressively (the
  // feed backfills incrementally, one page per upward scroll) until the first
  // folder's first photo appears. If backfill were truly stuck there would be
  // nothing above the landing and this loop would hit the top empty-handed.
  const scroller = page.locator(".main-column");
  const wanted = page.locator(`.thumb[data-id="${firstOfEarlier}"]`);
  let lastTop = Infinity;
  for (let i = 0; i < 20; i++) {
    if (await wanted.isVisible().catch(() => false)) break;
    const top = await scroller.evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight);
      return el.scrollTop;
    });
    await page.waitForTimeout(250); // let the backfill page render
    if (top === 0 && lastTop === 0) break; // parked at the top, no more to load
    lastTop = top;
  }
  await expect(wanted).toBeVisible();
});
