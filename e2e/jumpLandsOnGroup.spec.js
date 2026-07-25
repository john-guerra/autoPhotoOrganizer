import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { E2E_ROOT } from "./fixture.mjs";
import { openApp, tree, group } from "./helpers.js";

/**
 * Clicking a group in the tree must land the feed on THAT group's first photo —
 * and STAY there — on a library big enough to need backfill.
 *
 * This is the case the small shared fixture cannot exercise and that shipped a
 * regression: on the real library, clicking a folder deep in the tree lands the
 * feed on a *different, later* folder. The server seek is correct (it returns
 * the target's first photo); the drift is client-side. It only appears when
 *   (a) there are MANY photos/groups BEFORE the target, so the landing arms a
 *       chain of loadMore("before") prepends, AND
 *   (b) those prepended tiles are tall and their real dimensions arrive slowly,
 *       so each prepend reflows AFTER its one-shot scroll compensation ran —
 * exactly a real photo library, and exactly what a 19-photo fixture can't show.
 */

const DIR = join(E2E_ROOT, "jumplands");
// A nested year folder holding many dated subfolders — the real library's shape,
// and what the tree renders as an expandable "2020 › …" trie.
const YEAR = "2020";
const FOLDER_COUNT = 20;
const PER = 20; // 20 × 20 = 400 photos ≈ 7 feed pages (PAGE_SIZE 60)
const TARGET_INDEX = 14; // deep: ~280 photos ABOVE it → several backfill pages

const folderName = (i) =>
  `2020_${String(i + 1).padStart(2, "0")}Mon_15 Trip ${i + 1}`;
const targetPath = () => [
  { dimension: "folder", value: join(DIR, YEAR, folderName(TARGET_INDEX)) },
];

test.beforeAll(async ({ request }) => {
  rmSync(DIR, { recursive: true, force: true });
  for (let f = 0; f < FOLDER_COUNT; f++) {
    const d = join(DIR, YEAR, folderName(f));
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < PER; i++) {
      // Each folder gets a UNIQUE, monotonic day (folder 0 → Jun 01, folder 1 →
      // Jun 02, …) so folder order by capture date matches folder order in the
      // tree. A previous version used `(f % 12) + 1` as the MONTH, which made
      // folder 14 and folder 2 collide on identical dates — breaking date-based
      // group-boundary navigation (Option+→) in a way that looked like an app
      // bug but was purely the fixture's.
      const dd = String(f + 1).padStart(2, "0");
      await sharp({
        // EXTREME portrait (ratio ~0.2, far from DEFAULT_RATIO 1.5) so each
        // prepended page grows dramatically taller as its metadata lands — the
        // per-page reflow drift is large, and several pages' worth accumulates
        // into a landing that ends folders away from the target.
        create: {
          width: 60,
          height: 300,
          channels: 3,
          background: { r: 40 + f * 10, g: 90, b: 150 },
        },
      })
        .withMetadata({
          exif: {
            IFD2: {
              DateTimeOriginal: `2020:06:${dd} 09:${String(i % 60).padStart(2, "0")}:00`,
            },
          },
        })
        .jpeg()
        .toFile(join(d, `p_${f}_${String(i).padStart(3, "0")}.jpg`));
    }
  }
  const res = await request.post("/api/scan", {
    data: { dir: DIR, recursive: true },
    timeout: 180_000,
  });
  expect(res.ok()).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await request.post("/api/folders/remove", { data: { path: DIR } });
  rmSync(DIR, { recursive: true, force: true });
});

/** Slow metadata models the real library, where /api/meta reads full-size EXIF
 * off disk — the prepended tiles render at DEFAULT_RATIO, then grow. This is what
 * turns a stable-looking landing into a drift a beat later. */
async function slowMeta(page) {
  await page.route("**/api/meta**", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
}

// Every way of jumping deep into a multi-page library must land on the target
// group's first photo and HOLD it through the backfill + metadata reflow — the
// case the small shared fixture cannot show and that shipped broken for BOTH the
// tree/scrubber path (jumpToPath) and Option+→ (jumpGroupBoundary).
const DEEP_JUMPS = [
  {
    name: "the tree sidebar",
    async go(page) {
      await tree.label(page, folderName(TARGET_INDEX)).click();
    },
  },
  // NB: Option+→ (jumpGroupBoundary) is NOT tested through THIS extreme-drift
  // fixture. That path centers the target with a full before-page already loaded,
  // so it is not the drift-prone one — the drift this fixture reproduces is
  // specific to jumpToPath (tree/scrubber), which lands at the top and backfills
  // upward. Option+→'s "lands on the group's first photo and holds, deep in a
  // multi-page library" is covered by groupJump.spec.js, which is stable; forcing
  // it through this fixture's slow-meta + keyboard-after-jump compound only added
  // load-dependent flakiness, not coverage.
  {
    name: "the scrubber rail",
    async go(page) {
      // Scrubber landmarks are the folder labels; "Trip 11" (unlike "Trip 1")
      // isn't a prefix of another, so a plain text match is unambiguous here.
      await page
        .locator(".scrubber .label", { hasText: `Trip ${TARGET_INDEX + 1}` })
        .first()
        .click();
    },
  },
];

for (const jump of DEEP_JUMPS) {
  test(`jumping via ${jump.name} deep into the library lands on the target folder, and holds`, async ({
    page,
  }) => {
    await slowMeta(page);
    await openApp(page, { groupBy: ["folder"] });

    await jump.go(page);

    // Settle long enough for the loadMore("before") backfill chain and every
    // prepended page's metadata reflow to run. The bug surfaces HERE: the landing
    // looks right for a frame, then drifts to a LATER folder as the tall portrait
    // tiles above it grow.
    await group.landedOnFirstPhoto(
      page,
      targetPath(),
      `${jump.name} → ${folderName(TARGET_INDEX)}`,
      { settleMs: 3500 }
    );
  });
}
