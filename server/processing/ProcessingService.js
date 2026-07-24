/**
 * ProcessingService — the interface for all image/video processing.
 *
 * Everything that decodes, extracts, or measures a media file lives behind this
 * boundary so the engine can be swapped without touching the scanner, index, or
 * UI. Planned adapters:
 *   - NodeProcessingService  (current: exifr + sharp/libvips + ffmpeg — NOT
 *                             exiftool; an earlier docstring said exiftool-vendored
 *                             and that was never a dependency of the shipped code)
 *   - WasmProcessingService  (future: browser / mobile, no native deps)
 *   - PythonProcessingService (future: ML sidecar for Phase 2 ranking/embeddings)
 *
 * Core performance rule the implementations are MEANT to enforce: NEVER fully
 * decode a RAW during culling — extract the camera's embedded JPEG preview
 * instead. NOTE: this is not yet implemented (exifr.thumbnail() returns only the
 * ~160px EXIF thumbnail and throws for many RAWs; no PreviewImage/JpgFromRaw
 * extractor is wired up). See docs/AI-CODING-REVIEW-2026-07-24.md (Rec 8).
 *
 * This file documents the contract with JSDoc typedefs. Implementations should
 * `extends ProcessingService`.
 */

/**
 * @typedef {Object} MediaFile
 * @property {string} path      Absolute path on disk.
 * @property {number} size      Bytes.
 * @property {number} mtimeMs   Last-modified time (ms) — part of the incremental scan key.
 * @property {number} btimeMs   File creation (birth) time (ms). Falls back near mtime on filesystems without it.
 * @property {"image"|"raw"|"video"} kind
 */

/**
 * @typedef {Object} MediaMetadata
 * @property {string} path
 * @property {Date=} createDate     From EXIF DateTimeOriginal, else filename, else mtime.
 * @property {number=} width
 * @property {number=} height
 * @property {string=} camera
 * @property {number=} aperture     EXIF FNumber (ƒ-stop), image files only.
 * @property {number=} shutter      EXIF ExposureTime (seconds), image files only.
 * @property {number=} iso          EXIF ISO, image files only.
 * @property {number=} focalLength  EXIF FocalLength (mm), image files only.
 * @property {string=} lens         EXIF LensModel ("" = none found / attempted).
 * @property {string=} orientation
 * @property {number=} duration   Video length in seconds (videos only; via ffprobe).
 */

/**
 * @typedef {Object} PreviewResult
 * @property {Buffer} data          Encoded JPEG bytes.
 * @property {number} width
 * @property {number} height
 * @property {"embedded"|"decoded"} source  How the preview was obtained.
 */

/**
 * Abstract processing interface. Do not instantiate directly.
 */
export class ProcessingService {
  /**
   * Scan a directory for media files (non-recursive contract is up to the
   * implementation to document). Should be able to report progress so the grid
   * can render while scanning continues.
   * @param {string} _dir
   * @returns {Promise<MediaFile[]>}
   */
  async scan(_dir) {
    throw new Error("ProcessingService.scan is abstract");
  }

  /**
   * Extract a full-size preview WITHOUT fully decoding RAW: use the camera's
   * embedded JPEG preview (RAW) or the EXIF thumbnail/embedded preview (JPEG).
   * @param {string} _file
   * @returns {Promise<PreviewResult>}
   */
  async extractPreview(_file) {
    throw new Error("ProcessingService.extractPreview is abstract");
  }

  /**
   * Produce a grid thumbnail of the given longest-edge size.
   * @param {string} _file
   * @param {number} _size
   * @returns {Promise<PreviewResult>}
   */
  async thumbnail(_file, _size) {
    throw new Error("ProcessingService.thumbnail is abstract");
  }

  /**
   * Produce a poster-frame thumbnail for a video, bounded to `_size` px on the
   * longest edge (symmetric with thumbnail()).
   * @param {string} _file
   * @param {number} _size
   * @returns {Promise<PreviewResult>}
   */
  async videoThumb(_file, _size) {
    throw new Error("ProcessingService.videoThumb is abstract");
  }

  /**
   * Read metadata for a batch of files (batched for exiftool daemon efficiency).
   * @param {string[]} _files
   * @returns {Promise<MediaMetadata[]>}
   */
  async metadata(_files) {
    throw new Error("ProcessingService.metadata is abstract");
  }

  /**
   * Transcode a video the browser cannot decode (see lib/videoPlayback.js) into
   * an H.264 4:2:0 + AAC MP4 at `_dest`. Must write atomically: a canceled or
   * crashed transcode may not leave a partial file behind, or it would be served
   * later as a valid cached proxy.
   * @param {string} _file
   * @param {string} _dest
   * @param {{signal?: AbortSignal, maxHeight?: number}} [_opts]
   * @returns {Promise<void>}
   */
  async transcodeForPlayback(_file, _dest, _opts) {
    throw new Error("ProcessingService.transcodeForPlayback is abstract");
  }
}
