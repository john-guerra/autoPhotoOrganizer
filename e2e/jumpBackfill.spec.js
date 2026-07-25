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

test("earlier folders are reachable by scrolling up after a jump (not stuck)", async ({
  page,
}) => {
  // A tree jump lands the target at the top with the pin holding it, which
  // suppresses the earlier-folder backfill so the landing can't drift. "Not
  // stuck" is the guarantee that this suppression is temporary: the user's first
  // scroll UP clears the pin (the on:wheel handler fires on the gesture, even
  // with nothing above yet), the backfill resumes, and earlier folders load.
  await page.route("**/api/meta**", async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.continue();
  });

  await openApp(page, { groupBy: ["folder"] });

  // The first folder's first photo — the content that must become reachable.
  const firstOfEarlier = await group.firstPhotoId(page, path(FOLDERS[0]));

  await tree.label(page, FOLDERS[1]).click();

  // The landing holds at the top (drift fix).
  const target = await group.firstPhotoId(page, path(FOLDERS[1]));
  await expect(page.locator(`.thumb[data-id="${target}"]`)).toBeInViewport();
  await page.waitForTimeout(800); // let the landing settle under the pin

  // Scroll UP with a real wheel gesture (not a programmatic scrollTop write —
  // that fires 'scroll', but the pin clears on 'wheel'). The feed backfills one
  // page per upward scroll; keep wheeling until the first folder's first photo
  // appears. If backfill were truly stuck this loop would hit the top empty.
  const scroller = page.locator(".main-column");
  const wanted = page.locator(`.thumb[data-id="${firstOfEarlier}"]`);
  await scroller.hover();
  for (let i = 0; i < 25; i++) {
    if (await wanted.isVisible().catch(() => false)) break;
    await page.mouse.wheel(0, -600); // gesture up → clears pin, triggers backfill
    await page.waitForTimeout(200); // let the backfill page render
  }
  await expect(wanted).toBeVisible();
});
