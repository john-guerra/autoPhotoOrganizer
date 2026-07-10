import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, join } from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { ProcessingService } from "./ProcessingService.js";

class NotImplementedError extends Error {
  /** @param {string} method */
  constructor(method) {
    super(`NodeProcessingService.${method} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

/** Thrown when ffmpeg can't produce a poster frame (unsupported/corrupt codec,
 * empty output, or a spawn failure). Mirrors RawDecodeUnavailableError so the
 * thumbnail endpoint can surface it as a normal per-item failure rather than a
 * crash. */
class VideoDecodeError extends Error {
  /** @param {string} file @param {string} [detail] */
  constructor(file, detail) {
    super(`video poster-frame decode failed for ${file}${detail ? `: ${detail}` : ""}`);
    this.name = "VideoDecodeError";
  }
}

/** Hard ceiling on a single ffmpeg/ffprobe invocation. A wedged decode must not
 * hang the request the way the client's own STALL_MS guards a stuck <img>. */
const FFMPEG_TIMEOUT_MS = 15000;

/**
 * Spawn a binary, feed it no stdin, and resolve with its stdout Buffer. Rejects
 * on non-zero exit, spawn error (e.g. ENOENT if the static binary is missing),
 * or timeout. stderr is captured for the rejection message.
 * @param {string} bin @param {string[]} args
 * @returns {Promise<Buffer>}
 */
function runBinary(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(reject, new Error(`timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => done(reject, e));
    child.on("close", (code) => {
      if (code === 0) return done(resolve, Buffer.concat(out));
      const msg = Buffer.concat(err).toString().trim().split("\n").pop() || `exit ${code}`;
      done(reject, new Error(msg));
    });
  });
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

/**
 * Video extensions discovered by scan() and given kind:"video". Their grid
 * thumbnail is an ffmpeg poster frame (videoThumb) and their metadata (duration,
 * displayed dimensions, capture date) comes from ffprobe — sharp/exifr can't
 * demux any of these. A full ffmpeg build (ffmpeg-static) decodes them all;
 * whether a given container plays back natively in the loupe's <video> element
 * is a separate, browser-dependent concern (mkv/avi/mts and HEVC may not).
 */
export const VIDEO_EXTS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".avi",
  ".mkv",
  ".3gp",
  ".mts",
  ".m2ts",
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
      const isVideo = VIDEO_EXTS.has(ext);
      if (!isImage && !isRaw && !isVideo) continue;
      const path = join(dir, entry.name);
      const st = await stat(path);
      files.push({
        path,
        name: entry.name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        btimeMs: st.birthtimeMs,
        kind: isVideo ? "video" : isRaw ? "raw" : "image",
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
   * Video poster frame: grab a single frame with ffmpeg and hand it to the same
   * sharp resize/encode as thumbnail(), so a video poster is byte-for-byte a
   * peer of an image thumbnail (JPEG q78, `size` px longest edge) and shares the
   * endpoint's size-keyed cache.
   *
   * `-ss 1` BEFORE `-i` is an input seek (fast, keyframe-accurate) that skips the
   * black/fade-in frames many clips open on. Sub-second or truncated clips seek
   * past EOF and yield no frame, so we retry once at `-ss 0` (the very first
   * frame). ffmpeg autorotates by default, so the frame is already display-
   * oriented — do not pass -noautorotate.
   * @override
   * @param {string} file
   * @param {number} size
   * @returns {Promise<import("./ProcessingService.js").PreviewResult>}
   */
  async videoThumb(file, size) {
    const grab = (seek) =>
      runBinary(ffmpegPath, [
        "-nostdin",
        "-loglevel",
        "error",
        "-ss",
        String(seek),
        "-i",
        file,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ]);

    let frame;
    try {
      frame = await grab(1);
      if (!frame.length) frame = await grab(0); // clip shorter than the 1s seek
    } catch (e) {
      // A seek past EOF can fail rather than return empty — fall back to frame 0.
      try {
        frame = await grab(0);
      } catch (e2) {
        throw new VideoDecodeError(file, e2.message || e.message);
      }
    }
    if (!frame || !frame.length) {
      throw new VideoDecodeError(file, "ffmpeg produced no frame");
    }

    const { data, info } = await sharp(frame)
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, source: "decoded" };
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
        if (VIDEO_EXTS.has(extname(path).toLowerCase())) {
          return this.#videoMetadata(path);
        }
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

  /**
   * Video metadata via ffprobe: duration (seconds), DISPLAYED dimensions
   * (coded dims swapped for a 90°/270° rotation, mirroring the EXIF-orientation
   * swap above so the orientation filter and justified layout stay correct), and
   * capture date from the container's creation_time (absent on many clips — then
   * the date falls back to mtime downstream, same as an undated photo). Camera is
   * set to "" so the meta re-try sentinel is satisfied and it isn't re-probed.
   * Best-effort: any failure leaves fields unset, matching the image branch.
   * @param {string} path
   * @returns {Promise<import("./ProcessingService.js").MediaMetadata>}
   */
  async #videoMetadata(path) {
    /** @type {import("./ProcessingService.js").MediaMetadata} */
    const meta = { path, camera: "" };
    try {
      const out = await runBinary(ffprobeStatic.path, [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path,
      ]);
      const probe = JSON.parse(out.toString());
      const stream = (probe.streams || []).find((s) => s.codec_type === "video");

      const durationStr = probe.format?.duration ?? stream?.duration;
      const duration = Number(durationStr);
      if (Number.isFinite(duration) && duration > 0) meta.duration = duration;

      if (stream && stream.width > 0 && stream.height > 0) {
        const rotation = videoRotation(stream);
        const swap = rotation === 90 || rotation === 270;
        meta.width = swap ? stream.height : stream.width;
        meta.height = swap ? stream.width : stream.height;
      }

      const created = probe.format?.tags?.creation_time;
      if (created) {
        const d = new Date(created);
        if (!Number.isNaN(d.getTime())) meta.createDate = d;
      }
    } catch {
      /* ffprobe unavailable / unparseable — leave fields unset */
    }
    return meta;
  }
}

/** Normalize a video stream's rotation to 0/90/180/270 degrees. Modern ffprobe
 * exposes it as a (possibly negative) `side_data_list[].rotation`; older builds
 * as a `tags.rotate` string. */
function videoRotation(stream) {
  const sideData = (stream.side_data_list || []).find(
    (s) => s.rotation !== undefined
  );
  const raw = sideData?.rotation ?? stream.tags?.rotate;
  const deg = Number(raw);
  if (!Number.isFinite(deg)) return 0;
  return ((Math.round(deg) % 360) + 360) % 360;
}
