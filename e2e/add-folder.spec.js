import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { PHOTOS_DIR } from "./fixture.mjs";
import { openApp, trackPageErrors, tree, statusBar, group } from "./helpers.js";

/**
 * Adding a folder must SHOW you it worked (#170).
 *
 * A scan that succeeded and a scan that silently did nothing looked identical:
 * the tree kept its old shape, the feed kept its old scroll position, and the
 * status line said the same "N photos loaded" it says after any ordinary load.
 * Per CLAUDE.md's usability invariant, a user-triggered action has to tell the
 * user what happened.
 *
 * The new folder is a SIBLING inside the fixture root, which is the case the
 * tree gets wrong: its ancestor is already in the trie and is not expanded, so
 * a newly-arrived child can exist in the data and still be invisible.
 */

const NEW_FOLDER = "2024_05May_01 NewCard";
const NEW_DIR = join(PHOTOS_DIR, NEW_FOLDER);
const NEW_COUNT = 4;

/** Fixture-style dated JPEGs, so the added folder sorts as a real group. */
async function buildNewFolder() {
  mkdirSync(NEW_DIR, { recursive: true });
  for (let i = 0; i < NEW_COUNT; i++) {
    await sharp({
      create: {
        width: 120 + (i % 3) * 40,
        height: 90 + (i % 2) * 30,
        channels: 3,
        background: { r: 200, g: 60 + i * 20, b: 40 },
      },
    })
      .withMetadata({
        exif: {
          IFD2: {
            DateTimeOriginal: `2024:05:01 09:${String(i).padStart(2, "0")}:00`,
          },
        },
      })
      .jpeg()
      .toFile(join(NEW_DIR, `new_${String(i).padStart(2, "0")}.jpg`));
  }
}

test.beforeEach(async () => {
  await buildNewFolder();
});

// The e2e library is SHARED and specs assert totals against it (TOTAL_PHOTOS),
// so this folder must leave no trace: out of the index, off the disk. Index-only
// removal — /api/folders/remove never touches real files.
test.afterEach(async ({ request }) => {
  await request.post("/api/folders/remove", { data: { path: NEW_DIR } });
  rmSync(NEW_DIR, { recursive: true, force: true });
});

/** Drive the ＋ → Add folder… panel for `path` and commit it. */
async function addFolder(page, path) {
  await page.locator(".topbar .add-toggle").click();
  await page
    .locator(".source-menu")
    .getByRole("menuitem", { name: "Add folder…", exact: true })
    .click();
  const panel = page.locator(".add-panel");
  await expect(panel).toBeVisible();
  await panel.locator("input.dir").fill(path);
  await panel.locator("button.scan").click();
}

test("adding a folder shows it in the tree, the feed, and the status line", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  const before = await statusBar.showingCount(page);
  await addFolder(page, NEW_DIR);

  // 1. The status line confirms the scan, specifically — not the generic
  //    "N photos loaded" that any ordinary feed load prints.
  await expect(statusBar.root(page)).toContainText(NEW_FOLDER, {
    timeout: 30_000,
  });

  // 2. The library actually grew.
  await expect
    .poll(() => statusBar.showingCount(page), { timeout: 30_000 })
    .toBe(before + NEW_COUNT);

  // 3. The tree shows the folder that was just added.
  await expect(tree.node(page, NEW_FOLDER)).toBeVisible();

  // 4. And so does the feed.
  await expect(group.folderHeaderExact(page, NEW_FOLDER).first()).toBeVisible();

  expect(errors).toEqual([]);
});

test("a grouping with no folder groups says where the photos went", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  // Grouped by day there is no folder group to scroll to, so jumpToFolder can't
  // move the feed. That used to be a silent no-op: the scan succeeded, nothing
  // on screen changed, and the status line printed its usual "N photos loaded".
  await openApp(page, { groupBy: ["day"] });

  const before = await statusBar.showingCount(page);
  await addFolder(page, NEW_DIR);

  await expect
    .poll(() => statusBar.showingCount(page), { timeout: 30_000 })
    .toBe(before + NEW_COUNT);

  // It still names what landed, AND tells the user how to go see it.
  await expect(statusBar.root(page)).toContainText(NEW_FOLDER);
  await expect(statusBar.root(page)).toContainText("Group by folder");

  expect(errors).toEqual([]);
});

test("rescanning an already-indexed folder says 'Rescanned', not 'Added'", async ({
  page,
}) => {
  // `count` from a scan is the folder's CURRENT total, never a delta — the server
  // re-lists every file each scan. So the FIRST import can honestly say "Added N",
  // but a later rescan of the same folder must not: "Added N" would overstate what
  // happened (claiming the whole folder was just added again). This is the case
  // the new-folder test can't cover, because there N added == N total.
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // First import: "Added".
  await addFolder(page, NEW_DIR);
  await expect(statusBar.root(page)).toContainText(`Added ${NEW_FOLDER}`, {
    timeout: 30_000,
  });

  // Rescan the same, now-indexed folder (no new files on disk).
  await addFolder(page, NEW_DIR);
  await expect(statusBar.root(page)).toContainText(`Rescanned ${NEW_FOLDER}`, {
    timeout: 30_000,
  });
  // ...and it must NOT claim it just added the whole folder again.
  await expect(statusBar.root(page)).not.toContainText(`Added ${NEW_FOLDER}`);

  expect(errors).toEqual([]);
});
