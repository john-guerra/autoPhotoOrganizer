/**
 * A fixture LARGER THAN ONE FEED PAGE, for the bugs the 19-photo one cannot
 * show.
 *
 * `PAGE_SIZE` is 60 (`ui/src/App.svelte`), and the standard fixture is 19
 * photos — so the loaded feed window and the filter's whole result set are the
 * SAME SET there. Three separate pieces of work need them to differ:
 *
 *  - **#245**: "Visible" took its count from `items` (the loaded window) while
 *    meaning "what the filter matches". Reverting that fix does not turn the
 *    normal suite red, because at 19 photos both numbers are 19.
 *  - **#248**: returning to the feed from another view renders nothing until
 *    you scroll — a virtualization symptom, invisible when everything fits.
 *  - **Stage 2 of the pipeline plan**: decision D2 says the unified scan must
 *    be at least as fast as today's separate passes, which is unenforceable
 *    without a baseline measured on a library worth measuring.
 *
 * ## How to use it
 *
 *     node e2e/bigFixture.mjs 500        # build it (default 500)
 *     E2E_KEEP_FIXTURE=1 npm run test:e2e -- e2e/scale.spec.js
 *
 * `E2E_KEEP_FIXTURE=1` makes `global-setup.mjs` reuse whatever is already in
 * `e2e/.tmp/photos` instead of regenerating the small one. Without it your
 * bulk folder is deleted before the first spec runs.
 *
 * ## It builds the STANDARD fixture too, on purpose
 *
 * Not just the bulk folder. Every existing spec asserts on Trip / Party /
 * Cards, so a photos directory containing only the bulk folder would turn the
 * whole suite red for reasons that have nothing to do with scale. This adds
 * to the fixture rather than replacing it.
 *
 * ## The two traps, both already paid for once
 *
 * `docs/TESTING.md` records them from #97's measurement, and both produced a
 * meaningless result the first time:
 *
 *  - **Every photo gets a DISTINCT timestamp.** Identical capture times make
 *    burst clustering collapse a folder into a single ×N stack, so the grid
 *    renders ~7 tiles and there is no per-tile cost left to measure — and no
 *    window/result-set divergence either, which would silently defeat the
 *    whole point here.
 *  - **Wait for the grid to settle** before asserting or timing. Measuring
 *    while 7 of 80 tiles have painted tells you nothing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { buildFixture, PHOTOS_DIR } from "./fixture.mjs";

/** Named and dated like the other fixture folders so grouping treats it the
 *  same way. Sorts last, which keeps it out of the way of specs that assume
 *  the first group is Trip. */
export const BIG_FOLDER = "2025_06Jun_01 Bulk";

/** Enough to exceed PAGE_SIZE (60) several times over without costing a
 *  minute to generate. Override with the CLI argument. */
export const DEFAULT_BIG_COUNT = 500;

/**
 * Add `count` photos in one folder to the existing fixture.
 *
 * Deliberately NOT calling buildFixture itself — the caller decides, because
 * buildFixture wipes the photos directory and doing that implicitly from here
 * would delete a bulk folder someone just spent a minute generating.
 *
 * @param {number} count
 * @returns {Promise<{dir: string, count: number}>}
 */
export async function addBulkFolder(count = DEFAULT_BIG_COUNT) {
  const dir = join(PHOTOS_DIR, BIG_FOLDER);
  mkdirSync(dir, { recursive: true });

  // One photo per minute from a fixed start. Distinct to the minute across the
  // whole run (500 photos ≈ 8 hours), so nothing bursts and the sort is total.
  const start = new Date("2025-06-01T00:00:00Z");
  for (let i = 0; i < count; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    const date =
      `${t.getUTCFullYear()}:${pad(t.getUTCMonth() + 1)}:${pad(t.getUTCDate())} ` +
      `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
    // Tiny, and varied enough that the justified layout has real work to do.
    const w = 60 + (i % 4) * 10;
    const h = 45 + (i % 3) * 10;
    await sharp({
      create: {
        width: w,
        height: h,
        channels: 3,
        background: { r: (i * 7) % 256, g: (i * 13) % 256, b: 160 },
      },
    })
      // IFD2 — the Exif IFD. In IFD0 sharp accepts it, exifr never finds it,
      // and every photo scans with no capture date (docs/TESTING.md).
      .withMetadata({ exif: { IFD2: { DateTimeOriginal: date } } })
      .jpeg({ quality: 60 })
      .toFile(join(dir, `bulk_${String(i).padStart(5, "0")}.jpg`));
  }
  return { dir, count };
}

const pad = (n) => String(n).padStart(2, "0");

// Run directly: rebuild the standard fixture, then pile the bulk folder on it.
if (process.argv[1] && process.argv[1].endsWith("bigFixture.mjs")) {
  const count = Number(process.argv[2]) || DEFAULT_BIG_COUNT;
  const t0 = Date.now();
  await buildFixture();
  const { dir } = await addBulkFolder(count);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`built the standard fixture + ${count} photos in ${dir}`);
  console.log(`took ${secs}s`);
  console.log("");
  console.log("Now run the suite WITHOUT regenerating it:");
  console.log("  E2E_KEEP_FIXTURE=1 npm run test:e2e -- e2e/scale.spec.js");
  writeFileSync(join(PHOTOS_DIR, ".bulk-count"), String(count), "utf8");
}
