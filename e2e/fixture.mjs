import { mkdirSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
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

// Each folder spans TWO days, so `folder > day` produces a genuinely nested
// feed (two children per parent) instead of one degenerate child.
export const FOLDERS = [
  {
    name: "2024_01Jan_10 Trip",
    count: 6,
    days: ["2024:01:10", "2024:01:11"],
  },
  {
    name: "2024_02Feb_20 Party",
    count: 5,
    days: ["2024:02:20", "2024:02:21"],
  },
  // A NESTED pair, under a parent that holds no photos of its own. This one
  // structure carries every folder-tree behaviour worth protecting:
  //  - the tree must nest these under "Cards" instead of listing two long paths
  //  - "Cards" is a VIRTUAL ancestor (no photos) — it must still count, fold and
  //    jump on behalf of its children
  //  - the two leaves differ ONLY by a number, and every label rule wants to throw
  //    that number away (it's a bare digit, so date-shaped; everything else in the
  //    name is shared). If it goes, the two rows render identically — which is
  //    exactly the bug this fixture exists to catch.
  {
    name: "2024_03Mar_05 Cards/2024_03Mar_05 Cam 1",
    count: 3,
    days: ["2024:03:05", "2024:03:06"],
  },
  {
    name: "2024_03Mar_05 Cards/2024_03Mar_05 Cam 10",
    count: 3,
    days: ["2024:03:05", "2024:03:06"],
  },
];

/** A video the BROWSER CANNOT PLAY: MPEG-4 Part 2 in an AVI, which is what an
 * old camcorder produces and what Chromium has no decoder for. Pointed straight
 * at a <video> it plays its audio and shows nothing, so the app must transcode
 * it before playback. Odd dimensions (65x49) on purpose: H.264 4:2:0 rejects an
 * odd width or height, and the first real file this met was 1200x675 — an
 * even-sized fixture would have missed it. */
export const VIDEO = {
  folder: FOLDERS[0].name,
  name: "clip.avi",
};

/** An HEVC clip — a modern iPhone/Android video, and the OPPOSITE problem to the
 * .avi above: it is not unplayable, it is unplayable HERE. Chromium ships no HEVC
 * software decoder and turns the codec on only where the OS/GPU has one, so the
 * same file plays natively on most Macs and cannot be decoded at all on a Windows
 * box without the HEVC Video Extension.
 *
 * Playwright's Chromium is one of the machines WITHOUT it — which is precisely
 * what makes it the right place to test this: the app offers the browser the
 * original, the browser's own decoder says no, and the app must notice and
 * convert instead of leaving a black rectangle. That is the Windows user's path,
 * reproduced exactly. */
export const HEVC_VIDEO = {
  folder: FOLDERS[0].name,
  name: "clip-hevc.mp4",
};

/** The HEVC clip's capture date — days away from the .avi, so the two videos
 *  can't burst-cluster into one stack (see buildHevcVideo). */
const HEVC_TAKEN_AT = new Date("2024-01-08T09:30:00Z");

/** Items in a folder — photos PLUS any video. A folder's `count` is its JPEGs;
 *  the grid, the selection and the tree all count the video too, so a spec that
 *  reads `count` where it means "everything here" is quietly wrong (and was:
 *  ⌘A took 7 and the spec expected 6). */
export function itemsIn(folder) {
  const videos = [VIDEO, HEVC_VIDEO].filter(
    (v) => v.folder === folder.name
  ).length;
  return folder.count + videos;
}

/** How many ITEMS the fixture library holds (photos + the video), derived —
 * never hand-counted.
 *
 * A spec that asserts "11 selected" is really asserting "the whole library", and
 * it silently becomes a lie the moment anyone adds a folder to the fixture (which
 * is exactly what happened when the nested pair landed). Import this instead. */
export const TOTAL_PHOTOS = FOLDERS.reduce((sum, f) => sum + itemsIn(f), 0);

/**
 * Deterministic, tiny, EXIF-dated JPEGs.
 *
 * DateTimeOriginal MUST go in `IFD2` (the Exif IFD). Writing it to `IFD0` is
 * silently useless: sharp accepts it, exifr never finds it, every photo scans
 * with no capture date, and every date-based group renders as "Unknown" — which
 * is exactly the bug this fixture shipped with.
 */
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
      // First half of the folder on day 1, the rest on day 2; the minute ticks
      // up so capture order is stable and total (no ties to sort around).
      const day = folder.days[i < Math.ceil(folder.count / 2) ? 0 : 1];
      const date = `${day} 09:${String(i).padStart(2, "0")}:00`;
      await sharp({
        create: {
          width: w,
          height: h,
          channels: 3,
          background: { r: 40 + i * 20, g: 90, b: 160 },
        },
      })
        .withMetadata({ exif: { IFD2: { DateTimeOriginal: date } } })
        .jpeg()
        .toFile(join(dir, `img_${String(i).padStart(2, "0")}.jpg`));
    }
  }

  await buildUnplayableVideo(join(PHOTOS_DIR, VIDEO.folder, VIDEO.name));

  const hevcPath = join(PHOTOS_DIR, HEVC_VIDEO.folder, HEVC_VIDEO.name);
  await buildHevcVideo(hevcPath);
  // Belt and braces on the clip's date (the container already carries one): the
  // two videos must land DAYS apart, not seconds. Written back-to-back they were
  // burst-clustered into a single stack, and the second one disappeared behind
  // the first one's cover — a spec looking for its tile scrolled the entire feed
  // and never found it.
  utimesSync(hevcPath, HEVC_TAKEN_AT, HEVC_TAKEN_AT);

  return { PHOTOS_DIR, HOME_DIR, FOLDERS, VIDEO, HEVC_VIDEO };
}

/** Generate the AVI/MPEG-4 clip described on VIDEO, with ffmpeg. */
async function buildUnplayableVideo(dest) {
  return runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=65x49:rate=10:duration=1",
    "-c:v",
    "mpeg4",
    "-y",
    dest,
  ]);
}

/** Generate the HEVC clip described on HEVC_VIDEO. `-tag:v hvc1` is the tag Apple
 *  and every phone write, and the one browsers expect in an MP4.
 *
 *  It carries a real `creation_time`, and that is not decoration. Without one, a
 *  video's date falls back to the FILE's timestamps — and macOS and Linux do not
 *  agree on which timestamp that is (birthtime exists on one and not the other).
 *  Both clips then landed on the same instant, burst-clustered into a stack, and
 *  the second one vanished behind the first one's cover: green on a Mac, red on
 *  CI, for a reason that has nothing to do with what the spec is testing. A date
 *  inside the container is the same on every machine. */
async function buildHevcVideo(dest) {
  return runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x48:rate=10:duration=1",
    "-c:v",
    "libx265",
    "-tag:v",
    "hvc1",
    "-pix_fmt",
    "yuv420p",
    "-metadata",
    `creation_time=${HEVC_TAKEN_AT.toISOString()}`,
    "-y",
    dest,
  ]);
}

async function runFfmpeg(args) {
  const { default: ffmpeg } = await import("ffmpeg-static");
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-nostdin", "-loglevel", "error", ...args]);
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))
    );
  });
}

export function fixtureExists() {
  return existsSync(PHOTOS_DIR);
}
