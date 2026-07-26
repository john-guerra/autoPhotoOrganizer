import { existsSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { thumbCachePath, tmpCachePath } from "../lib/cachePaths.js";

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
 * RAW IS NOT HANDLED HERE, and must not reach this function. An older version
 * of this comment claimed the 320px thumb was "the only workable path for
 * RAW" — it is the opposite: there IS no 320px thumb for a RAW file. The only
 * two branches below are videoThumb (ffmpeg poster frame) and thumbnail(),
 * and thumbnail() throws RawDecodeUnavailableError for RAW by design — no RAW
 * decoder is wired up, and the embedded-preview path CLAUDE.md's "Performance
 * thesis" describes was never built. A RAW row arriving here would therefore
 * be classified as a permanently unreadable PHOTO and sentinel-marked
 * forever. pendingEmbedRows excludes `kind = 'raw'` for exactly that reason
 * (server/db/embeddings.js), so this function never sees one; the day a RAW
 * preview path exists, that clause comes out and this comment with it.
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
  // would be served to the grid as a corrupt image forever after. The temp
  // name is unique per WRITE, not per process — this sweep and GET
  // /api/thumb/:id are two unserialized writers of the same bucket in the
  // same process, so a pid-keyed name is a collision the moment the user
  // scrolls onto the photo being embedded (see tmpCachePath's doc).
  const tmp = tmpCachePath(cachePath);
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
