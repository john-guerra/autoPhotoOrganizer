import { existsSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { thumbCachePath } from "../lib/cachePaths.js";

/**
 * The bucket the embedding sweep reads.
 *
 * 320, not a new 224 bucket, even though the vision encoder wants 224. 320 is
 * what the grid already requests, so the write we pay for on a miss is a write
 * the USER benefits from — after a full backfill the grid is warm across the
 * whole library. A dedicated 224 bucket would fragment the cache and warm
 * nothing. The processor downscales 320 -> 224, which is the correct direction.
 */
export const EMBED_THUMB_SIZE = 320;

/**
 * The embedding input for one photo: its 320px cached thumbnail, generated and
 * cached if it isn't there yet.
 *
 * #161 assumed this cache was already warm ("the cache already holds a 320 px
 * JPEG"). It is not: thumbsDir() is written from exactly one place, GET
 * /api/thumb/:id, so it holds only what the user has scrolled past. A sweep
 * that merely READS the cache could never drain to zero pending, which is the
 * issue's own acceptance criterion. So this is a producer, not a consumer.
 *
 * Reading the 320px thumb instead of the original is also the only workable
 * path for RAW — extractPreview throws for RAW and the full decode path was
 * never built (CLAUDE.md, "Performance thesis").
 *
 * Errors are deliberately NOT caught. runSweep owns the permanent/transient
 * classification (a missing folder pauses; EIO pauses; a genuinely unreadable
 * file gets a sentinel), and swallowing the error here would rob it of the
 * `code` it classifies on.
 *
 * @param {{path: string, mtime: number, size: number, kind: string}} photo
 * @param {{thumbnail: Function, videoThumb: Function}} processing the ProcessingService
 * @returns {Promise<Buffer>} JPEG bytes
 */
export async function thumbBytes(photo, processing) {
  const cachePath = thumbCachePath(photo, EMBED_THUMB_SIZE);
  if (existsSync(cachePath)) return readFile(cachePath);

  const { data } =
    photo.kind === "video"
      ? await processing.videoThumb(photo.path, EMBED_THUMB_SIZE)
      : await processing.thumbnail(photo.path, EMBED_THUMB_SIZE);

  // Same tmp + rename dance as the thumb endpoint: a torn file in the cache
  // would be served to the grid as a corrupt image forever after.
  const tmp = `${cachePath}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, cachePath);
  } catch {
    // A cache write failure (disk full, permissions) must not fail the
    // embedding — we already HAVE the bytes. Drop the temp file and move on.
    await unlink(tmp).catch(() => {});
  }
  return data;
}
