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

/** Thrown by thumbnail() for a RAW file — sharp can't decode most RAW
 * formats, so the full-resolution "slow tier" isn't available; a RAW
 * photo's embedded preview (see extractPreview) is its only available
 * image until a real RAW decoder is added as separate, future work. */
class RawDecodeUnavailableError extends Error {
  /** @param {string} file */
  constructor(file) {
    super(`full-resolution decode unavailable for RAW file: ${file}`);
    this.name = "RawDecodeUnavailableError";
  }
}

/**
 * Image extensions handled via the full sharp-decode path.
 */
export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

/**
 * RAW extensions discovered by scan() and given kind:"raw" — their only
 * available image is the embedded preview (extractPreview); a full decode
 * (thumbnail()) is intentionally unavailable until a real RAW decoder is
 * added as separate, future work.
 */
export const RAW_EXTS = new Set([
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".dng",
  ".orf",
  ".rw2",
  ".raf",
]);

/** A human camera label from EXIF Make/Model, de-duplicated (Model often
 * already includes the Make, e.g. Model "EOS R6" with Make "Canon", or Model
 * "Canon EOS R6"). Returns "" when neither is present. */
export function formatCamera(make, model) {
  const mk = (make ?? "").trim();
  const md = (model ?? "").trim();
  if (md && mk && !md.toLowerCase().startsWith(mk.toLowerCase())) return `${mk} ${md}`;
  return md || mk || "";
}

/**
 * NodeProcessingService — the MVP implementation (sharp + exifr).
 *
 * v0.2 scope: images + RAW (embedded preview only). `videoThumb` remains
 * unimplemented until the ffmpeg engine is wired.
 */
export class NodeProcessingService extends ProcessingService {
  /**
   * Non-recursive scan: readdir the directory, keep image/RAW files, stat
   * each for the incremental-rescan key (size + mtimeMs). Sorted by name.
   * @override
   * @param {string} dir
   * @returns {Promise<import("./ProcessingService.js").MediaFile[]>}
   */
  async scan(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      const isImage = IMAGE_EXTS.has(ext);
      const isRaw = RAW_EXTS.has(ext);
      if (!isImage && !isRaw) continue;
      const path = join(dir, entry.name);
      const st = await stat(path);
      files.push({
        path,
        name: entry.name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind: isRaw ? "raw" : "image",
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
  }

  /**
   * Resize to `size` px longest edge (fit inside, no enlargement), auto-rotate
   * for EXIF orientation, encode JPEG q78. Unavailable for RAW — see
   * RawDecodeUnavailableError.
   * @override
   * @param {string} file
   * @param {number} size
   * @returns {Promise<import("./ProcessingService.js").PreviewResult>}
   */
  async thumbnail(file, size) {
    if (RAW_EXTS.has(extname(file).toLowerCase())) {
      throw new RawDecodeUnavailableError(file);
    }
    const pipeline = sharp(file)
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, source: "decoded" };
  }

  /**
   * Embedded EXIF/JPEG preview — a few KB, read near the file header rather
   * than decoding the whole (possibly multi-megabyte, possibly RAW) source.
   * Works identically for JPEG and RAW inputs — exifr reads an embedded
   * preview the same way regardless of container format. Returns null when
   * the file has no embedded preview (some cameras/edited files strip it) —
   * a normal, expected outcome, not an error; genuine I/O failures still
   * throw.
   * @override
   * @param {string} file
   * @returns {Promise<import("./ProcessingService.js").PreviewResult|null>}
   */
  async extractPreview(file) {
    const data = await exifr.thumbnail(file);
    if (!data) return null;
    return { data, source: "embedded" };
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
   * Best-effort: fields are omitted for files that fail to parse (this
   * already covers RAW today, since sharp can't read most RAW headers —
   * unchanged by this task).
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
            pick: ["DateTimeOriginal", "CreateDate", "Make", "Model"],
          });
          const createDate = exif?.DateTimeOriginal || exif?.CreateDate;
          if (createDate) meta.createDate = createDate;
          meta.camera = formatCamera(exif?.Make, exif?.Model);
        } catch {
          /* no EXIF */
        }
        return meta;
      })
    );
  }
}
