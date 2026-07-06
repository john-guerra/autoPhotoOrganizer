import { ProcessingService } from "./ProcessingService.js";

class NotImplementedError extends Error {
  /** @param {string} method */
  constructor(method) {
    super(`NodeProcessingService.${method} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

/**
 * NodeProcessingService — the MVP implementation.
 *
 * Intended libraries (added during the MVP build, not in the scaffold):
 *   - exiftool-vendored : daemon mode for batched EXIF reads AND embedded
 *                         preview / thumbnail extraction (the RAW fast path).
 *   - sharp (libvips)   : fast thumbnail generation from previews/JPEGs.
 *   - ffmpeg-static     : extract a poster frame for video thumbnails.
 *
 * Every method throws NotImplementedError until wired up.
 */
export class NodeProcessingService extends ProcessingService {
  /** @override */
  async scan(_dir) {
    // TODO: readdir + stat, classify by extension, emit MediaFile[].
    // Incremental rescan keys on path + mtimeMs + size.
    throw new NotImplementedError("scan");
  }

  /** @override */
  async extractPreview(_file) {
    // TODO: exiftool-vendored — extract embedded JPEG preview from RAW,
    // or the EXIF/embedded preview from JPEG. Never full-decode a RAW here.
    throw new NotImplementedError("extractPreview");
  }

  /** @override */
  async thumbnail(_file, _size) {
    // TODO: sharp — resize a preview/JPEG to `size` longest edge.
    throw new NotImplementedError("thumbnail");
  }

  /** @override */
  async videoThumb(_file) {
    // TODO: ffmpeg-static — grab a poster frame.
    throw new NotImplementedError("videoThumb");
  }

  /** @override */
  async metadata(_files) {
    // TODO: exiftool-vendored daemon — batched metadata read.
    throw new NotImplementedError("metadata");
  }
}
