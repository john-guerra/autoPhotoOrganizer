import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { E2E_ROOT } from "./fixture.mjs";
import { openApp, tree, group } from "./helpers.js";

// SCRATCH reproduction for the tree-jump drift. PORTRAIT photos (ratio ~0.5) so
// the reflow from DEFAULT_RATIO 1.5 -> real is large, and /api/meta DELAYED so
// that reflow lands distinctly AFTER the jump settles — modelling a big library
// where dimensions arrive slowly. If the tree jump lacks a re-assert-on-reflow
// pin, the target drifts out of view once meta arrives.

const DIR = join(E2E_ROOT, "drift");
const FOLDERS = [
  "2027_01Jan One",
  "2027_02Feb Two",
  "2027_03Mar Three",
  "2027_04Apr Four",
];
const PER = 40;

test.beforeAll(async ({ request }) => {
  rmSync(DIR, { recursive: true, force: true });
  for (const [f, name] of FOLDERS.entries()) {
    const d = join(DIR, name);
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < PER; i++) {
      const mm = String(f + 1).padStart(2, "0");
      await sharp({
        // PORTRAIT: 80x200 (ratio 0.4) vs DEFAULT_RATIO 1.5 → big reflow.
        create: {
          width: 80,
          height: 200,
          channels: 3,
          background: { r: 30 + f * 50, g: 80, b: 200 - f * 40 },
        },
      })
        .withMetadata({
          exif: {
            IFD2: {
              DateTimeOriginal: `2027:${mm}:01 09:${String(i % 60).padStart(2, "0")}:00`,
            },
          },
        })
        .jpeg()
        .toFile(join(d, `p_${f}_${String(i).padStart(3, "0")}.jpg`));
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

test("tree jump holds through a delayed-metadata reflow", async ({ page }) => {
  // Delay every /api/meta so real dimensions arrive ~700ms AFTER the jump.
  await page.route("**/api/meta**", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });

  await openApp(page, { groupBy: ["folder"] });
  const id = await group.firstPhotoId(page, path(FOLDERS[2]));
  await tree.label(page, FOLDERS[2]).click();

  const tile = page.locator(`.thumb[data-id="${id}"]`);

  // Lands in view (at DEFAULT_RATIO, before the delayed metadata arrives).
  await expect(tile).toHaveClass(/\bselected\b/);
  await expect(tile).toBeInViewport();

  // The delayed metadata now arrives and the above-the-fold rows resize. The
  // landing must SURVIVE that reflow — it used to drift out of view a beat after
  // it looked right, which is what the pin fix prevents.
  await page.waitForTimeout(1500);
  await expect(
    tile,
    "the target drifted out of view after the metadata reflow"
  ).toBeInViewport();
});
