import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { PHOTOS_DIR, E2E_ROOT, FOLDERS } from "./fixture.mjs";
import { openApp, trackPageErrors, tree, group, grid } from "./helpers.js";

/**
 * Every way of jumping to a group must land on that group's FIRST photo, with
 * that photo on screen.
 *
 * There are four entry points and only two implementations underneath
 * (`jumpToPath` for the tree/scrubber, `jumpGroupBoundary` for Option+arrow and
 * the header's ‹ › buttons), so a regression in either one silently takes
 * several of the user's routes with it. This app's jump bugs (#35, #36, #39)
 * were all of exactly this shape and all reached a user, because the specs that
 * touched jumping only ever asserted "nothing threw" — the scrubber spec still
 * says so in as many words. Asserting the LANDING is what makes them catch
 * anything.
 *
 * The shared assertion is `group.landedOnFirstPhoto` in helpers.js: add a new
 * jump method to the table below and it is covered on the same terms.
 */

const TRIP = FOLDERS[0].name; // "2024_01Jan_10 Trip" — first folder in the feed
const PARTY = FOLDERS[1].name; // "2024_02Feb_20 Party" — the one after it

/** A folder group's path, in the {dimension, value} shape the feed/server use. */
const folderPath = (name) => [
  { dimension: "folder", value: join(PHOTOS_DIR, name) },
];

/**
 * Page errors, minus the ONE 404 this app issues on purpose.
 *
 * `/api/preview/:id` refuses videos deliberately — a video has no embedded EXIF
 * preview, its poster frame IS its thumbnail — and the grid falls back to that
 * URL whenever a video's poster frame is slow to arrive (see the route in
 * server/api.js, and the CI-only 500 it was introduced to fix). The fixture's
 * two clips live in the first folder, so any spec that renders the top of the
 * feed on a loaded machine can see it. It is not a failure, but the browser
 * logs it anyway.
 *
 * Filtered by PATH rather than by "ignore 404s", so a genuine missing thumbnail
 * or feed request still fails the test.
 */
function trackErrors(page) {
  const errors = trackPageErrors(page);
  const notFound = [];
  page.on("response", (r) => {
    if (r.status() === 404) notFound.push(new URL(r.url()).pathname);
  });
  return {
    unexpected: () => [
      ...errors.filter((e) => !/Failed to load resource.*404/.test(e)),
      ...notFound.filter((p) => !p.startsWith("/api/preview/")),
    ],
  };
}

/**
 * Each jump method, as the user triggers it. Every one navigates from the top
 * of the feed (inside Trip) to the NEXT folder group, Party — the same
 * destination by four different routes, so the assertion is identical and any
 * difference in outcome is a real difference in behaviour.
 */
const JUMPS = [
  {
    name: "Option+→ (group boundary shortcut)",
    async go(page) {
      // Focus a tile first: the shortcut jumps from wherever focus is.
      await grid.focus(page, 0);
      await page.keyboard.press("Alt+ArrowRight");
    },
  },
  {
    name: "the tree sidebar",
    async go(page) {
      await tree.label(page, PARTY).click();
    },
  },
  {
    name: "the group header's › button",
    async go(page) {
      // Anchored on Trip's own header, so it means "the group after THIS one"
      // rather than "after wherever the keyboard happens to be".
      await group
        .folderHeaderExact(page, TRIP)
        .first()
        .locator('[aria-label="Jump to the next group"]')
        .click();
    },
  },
  {
    name: "the scrubber rail",
    async go(page) {
      await page
        .locator(".scrubber .label", { hasText: "Party" })
        .first()
        .click();
    },
  },
];

for (const jump of JUMPS) {
  test(`jumping via ${jump.name} lands on the group's first photo`, async ({
    page,
  }) => {
    const errs = trackErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await jump.go(page);

    await group.landedOnFirstPhoto(page, folderPath(PARTY), jump.name);

    expect(errs.unexpected()).toEqual([]);
  });
}

/**
 * The same promise, in a library BIGGER THAN ONE FEED PAGE.
 *
 * This is the case the shared fixture structurally cannot test. PAGE_SIZE is 60
 * and the whole fixture is 19 items, so the entire library arrives in the first
 * page: `hasMoreBefore` is never true, the automatic loadMore("before") that a
 * landing arms fetches nothing, and its scroll compensation never runs. Every
 * jump therefore "holds" trivially.
 *
 * A jump deep into a multi-page library is where the reported behaviour lives —
 * the landing looks right for a frame, then the backfill prepends a page above
 * it and moves the feed under the user.
 */
const BIG_DIR = join(E2E_ROOT, "jump-big");
const BIG_FOLDERS = [
  "2025_01Jan_01 One",
  "2025_02Feb_01 Two",
  "2025_03Mar_01 Three",
  "2025_04Apr_01 Four",
];
const PER_FOLDER = 40; // 160 items over a PAGE_SIZE of 60 → several pages

test.describe("a library larger than one feed page", () => {
  test.beforeAll(async ({ request }) => {
    rmSync(BIG_DIR, { recursive: true, force: true });
    for (const [f, name] of BIG_FOLDERS.entries()) {
      const dir = join(BIG_DIR, name);
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < PER_FOLDER; i++) {
        const mm = String(f + 1).padStart(2, "0");
        await sharp({
          create: {
            width: 120 + (i % 3) * 40,
            height: 90 + (i % 2) * 30,
            channels: 3,
            background: { r: 30 + f * 50, g: 80, b: 200 - f * 40 },
          },
        })
          .withMetadata({
            exif: {
              IFD2: {
                DateTimeOriginal: `2025:${mm}:01 09:${String(i % 60).padStart(2, "0")}:00`,
              },
            },
          })
          .jpeg()
          .toFile(join(dir, `big_${f}_${String(i).padStart(3, "0")}.jpg`));
      }
    }
    const res = await request.post("/api/scan", {
      data: { dir: BIG_DIR, recursive: true },
      timeout: 120_000,
    });
    expect(res.ok(), "the big fixture failed to scan").toBeTruthy();
  });

  // Index AND disk, so the shared library's totals are exactly as they were.
  test.afterAll(async ({ request }) => {
    await request.post("/api/folders/remove", { data: { path: BIG_DIR } });
    rmSync(BIG_DIR, { recursive: true, force: true });
  });

  const bigPath = (name) => [
    { dimension: "folder", value: join(BIG_DIR, name) },
  ];

  for (const target of [BIG_FOLDERS[2], BIG_FOLDERS[3]]) {
    test(`jumping deep into the library lands on ${target}'s first photo and stays`, async ({
      page,
    }) => {
      const errs = trackErrors(page);
      await openApp(page, { groupBy: ["folder"] });

      // Deep enough that there is more than a page of photos ABOVE the target,
      // so the landing's backfill has real work to do.
      await tree.label(page, target).click();

      await group.landedOnFirstPhoto(
        page,
        bigPath(target),
        `tree jump to ${target} in a multi-page library`
      );

      expect(errs.unexpected()).toEqual([]);
    });
  }

  test("Option+→ deep in the library lands on the next group and stays", async ({
    page,
  }) => {
    const errs = trackErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    await tree.label(page, BIG_FOLDERS[2]).click();
    await group.landedOnFirstPhoto(page, bigPath(BIG_FOLDERS[2]), "setup jump");

    // Now jump onward by keyboard, from deep in the feed rather than the top.
    await page.keyboard.press("Alt+ArrowRight");
    await group.landedOnFirstPhoto(
      page,
      bigPath(BIG_FOLDERS[3]),
      "Option+→ from deep in a multi-page library"
    );

    expect(errs.unexpected()).toEqual([]);
  });
});

test("a jump still lands correctly after the feed has been scrolled deep", async ({
  page,
}) => {
  // The regression that keeps coming back is a stale scroll offset: the jump is
  // computed against where the user WAS, so it only misbehaves when they are
  // somewhere other than the top. Jumping from the top can pass while this fails.
  const errs = trackErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  await page.locator(".main-column").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(400); // let the virtual window settle at the bottom

  await tree.label(page, TRIP).click();
  await group.landedOnFirstPhoto(
    page,
    folderPath(TRIP),
    "tree jump after a deep scroll"
  );

  expect(errs.unexpected()).toEqual([]);
});
