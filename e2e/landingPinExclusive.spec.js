import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { E2E_ROOT } from "./fixture.mjs";
import { openApp, trackPageErrors, tree, group } from "./helpers.js";

/**
 * Fold-then-jump lands cleanly (#189) — a SMOKE test, honestly labelled.
 *
 * #189 merged two independent landing flags — `jumpRevealPending` (hold the
 * selected tile) and `expandPin` (hold a collapsed group's header) — into one
 * `landing` state, so arming either kind now cancels the other. The two used to
 * be independent, and a tree CLICK (which doesn't pass through the keydown
 * handler that clears them) could leave BOTH armed: fold a group, then click a
 * different group to jump, and their two re-pin effects could both drive
 * `scrollTop`.
 *
 * ⚠️ This test does NOT go red on the pre-#189 code, and it is not claimed to.
 * The double-pin fight turned out to be genuinely latent: to make it visibly
 * misland you need the folded group mounted, inside the jump target's window,
 * AND captured at a wildly different offset than its post-jump position — and in
 * practice those reconcile, which is why the case was never a reported bug
 * (unlike the drift bugs #35/#36/#180, which ARE covered, red-first, by
 * jumpLandsOnGroup/groupJump). What this DOES guard is that the exact
 * fold-then-jump interaction the refactor touched still lands and holds on the
 * target — cheap insurance that the state merge didn't break the path, checked
 * the way a user experiences it. The real no-regression proof for #189 is the
 * existing 11 jump specs continuing to pass.
 */

const DIR = join(E2E_ROOT, "pinexclusive");
const FOLDER_COUNT = 5;
const PER = 10; // 5 × 10 = 50 photos < PAGE_SIZE (60): one page, every group mounted
const FOLD_INDEX = 2; // folded group, AFTER the target, inside its window
const TARGET_INDEX = 0; // jump target; the folded group sits below it

const folderName = (i) =>
  `2021_${String(i + 1).padStart(2, "0")}Mon_15 Trip ${i + 1}`;
const targetPath = () => [
  { dimension: "folder", value: join(DIR, folderName(TARGET_INDEX)) },
];

test.beforeAll(async ({ request }) => {
  rmSync(DIR, { recursive: true, force: true });
  for (let f = 0; f < FOLDER_COUNT; f++) {
    const d = join(DIR, folderName(f));
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < PER; i++) {
      const dd = String(f + 1).padStart(2, "0"); // unique monotonic day per folder
      await sharp({
        create: {
          width: 120,
          height: 300,
          channels: 3,
          background: { r: 50, g: 60 + f * 30, b: 160 },
        },
      })
        .withMetadata({
          exif: {
            IFD2: {
              DateTimeOriginal: `2021:06:${dd} 09:${String(i % 60).padStart(2, "0")}:00`,
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

test("folding a group then jumping to another via the tree lands on the target and holds", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // Fold a later group via its feed header (every group is mounted, so this
  // arms the group landing), then — without taking over — jump to an earlier
  // group via the tree, which arms the tile landing. Post-#189 the tile landing
  // replaces the group landing, so only the target is held.
  const foldHeader = group.folderHeader(page, folderName(FOLD_INDEX));
  await expect(foldHeader).toBeVisible();
  await group.toggle(foldHeader).click();
  await expect(group.toggle(foldHeader)).toHaveClass(/\bnot-grid\b/);

  await tree.label(page, folderName(TARGET_INDEX)).click();

  await group.landedOnFirstPhoto(
    page,
    targetPath(),
    `fold ${folderName(FOLD_INDEX)} then jump to ${folderName(TARGET_INDEX)}`,
    { settleMs: 1200 }
  );

  expect(errors).toEqual([]);
});
