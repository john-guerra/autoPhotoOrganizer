import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

/**
 * A hermetic library for the e2e run: generated JPEGs in a temp folder, indexed
 * into a temp AUTOGALLERY_HOME. It NEVER touches the user's real photos or
 * ~/.autogallery — the read-only-photo-folder rule in CLAUDE.md applies to tests
 * as much as to the app.
 *
 * Two folders with different capture dates, so grouping by folder AND by date
 * both produce more than one group — the nesting/collapse behaviour we keep
 * breaking only shows up with >1 grouping level.
 */
export const E2E_ROOT = join(process.cwd(), "e2e", ".tmp");
export const PHOTOS_DIR = join(E2E_ROOT, "photos");
export const HOME_DIR = join(E2E_ROOT, "home");

const FOLDERS = [
  { name: "2024_01Jan_10 Trip", count: 6, date: "2024:01:10 09:00:00" },
  { name: "2024_02Feb_20 Party", count: 5, date: "2024:02:20 18:30:00" },
];

/** Deterministic, tiny, EXIF-dated JPEGs. */
export async function buildFixture() {
  rmSync(E2E_ROOT, { recursive: true, force: true });
  mkdirSync(PHOTOS_DIR, { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });

  for (const folder of FOLDERS) {
    const dir = join(PHOTOS_DIR, folder.name);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < folder.count; i++) {
      // Vary the aspect ratio so the justified layout has real work to do.
      const w = 120 + (i % 3) * 40;
      const h = 90 + (i % 2) * 30;
      await sharp({
        create: {
          width: w,
          height: h,
          channels: 3,
          background: { r: 40 + i * 20, g: 90, b: 160 },
        },
      })
        .withMetadata({ exif: { IFD0: { DateTimeOriginal: folder.date } } })
        .jpeg()
        .toFile(join(dir, `img_${String(i).padStart(2, "0")}.jpg`));
    }
  }
  return { PHOTOS_DIR, HOME_DIR, FOLDERS };
}

export function fixtureExists() {
  return existsSync(PHOTOS_DIR);
}
