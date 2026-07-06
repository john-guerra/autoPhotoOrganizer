import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import { ProcessingService } from "./ProcessingService.js";

class NotImplementedError extends Error {
  /** @param {string} method */
  constructor(method) {
    super(`NodeProcessingService.${method} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

/**
 * Image extensions handled in v0.1. RAW/HEIC/video come later (they need the
 * embedded-preview / ffmpeg paths described in the design doc).
 */
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/**
 * NodeProcessingService — the MVP implementation (sharp + exifr).
 *
 * v0.1 scope: images only. `extractPreview` (RAW embedded JPEG) and `videoThumb`
 * remain unimplemented until the exiftool/ffmpeg engines are wired.
 */
export class NodeProcessingService extends ProcessingService {
  /**
   * Non-recursive scan: readdir the directory, keep image files, stat each for
   * the incremental-rescan key (size + mtimeMs). Sorted by name.
   * @override
   * @param {string} dir
   * @returns {Promise<import("./ProcessingService.js").MediaFile[]>}
   */
  async scan(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!IMAGE_EXTS.has(extname(entry.name).toLowerCase())) continue;
      const path = join(dir, entry.name);
      const st = await stat(path);
      files.push({
        path,
        name: entry.name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind: "image",
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
  }

  /**
   * Resize to `size` px longest edge (fit inside, no enlargement), auto-rotate
   * for EXIF orientation, encode JPEG q78.
   * @override
   * @param {string} file
   * @param {number} size
   * @returns {Promise<import("./ProcessingService.js").PreviewResult>}
   */
  async thumbnail(file, size) {
    const pipeline = sharp(file)
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, source: "decoded" };
  }

  /**
   * RAW embedded-preview extraction — the exiftool engine lands later.
   * @override
   */
  async extractPreview(_file) {
    throw new NotImplementedError("extractPreview");
  }

  /**
   * Video poster frames — the ffmpeg engine lands later.
   * @override
   */
  async videoThumb(_file) {
    throw new NotImplementedError("videoThumb");
  }

  /**
   * Read capture metadata for a batch of files: pixel dimensions via a sharp
   * header read (~0.2 ms/file, works for every supported format) and capture
   * date via exifr. Width/height are swapped for rotated EXIF orientations so
   * they describe the image as DISPLAYED — what the justified layout needs.
   * Best-effort: fields are omitted for files that fail to parse.
   * @override
   * @param {string[]} files
   * @returns {Promise<import("./ProcessingService.js").MediaMetadata[]>}
   */
  async metadata(files) {
    return Promise.all(
      files.map(async (path) => {
        /** @type {import("./ProcessingService.js").MediaMetadata} */
        const meta = { path };
        try {
          const info = await sharp(path).metadata();
          // Orientations 5-8 are 90°/270° rotations: displayed dims are swapped.
          const rotated = (info.orientation ?? 1) >= 5;
          meta.width = rotated ? info.height : info.width;
          meta.height = rotated ? info.width : info.height;
        } catch {
          /* dimensions unavailable */
        }
        try {
          const exif = await exifr.parse(path, {
            pick: ["DateTimeOriginal", "CreateDate"],
          });
          const createDate = exif?.DateTimeOriginal || exif?.CreateDate;
          if (createDate) meta.createDate = createDate;
        } catch {
          /* no EXIF */
        }
        return meta;
      })
    );
  }
}
