/**
 * Can the BROWSER play this video, or must we transcode it first?
 *
 * The loupe hands the file straight to a <video> element, so playback is limited
 * to what Chromium's bundled ffmpeg can decode — which is far less than what
 * ffmpeg-the-project can. Chromium has NO MPEG-4 Part 2 (DivX/Xvid) decoder, no
 * MJPEG-in-AVI, no H.263, and it won't demux an AVI container at all
 * (`canPlayType('video/x-msvideo')` → ""). What it DOES have is MP3, AAC and PCM
 * audio.
 *
 * That combination is the bug this module exists for: an old camcorder .avi
 * (MPEG-4 video + MP3 audio) hands the browser an audio track it can decode and
 * a video track it cannot, so **the sound plays and the picture never appears**.
 * On a real 114k library that was 275 files; another 32 were MJPEG/H.263.
 *
 * 4:2:2 H.264 is the subtle one. Chromium's software decoder is 4:2:0-only, but
 * macOS can hand the frame to VideoToolbox, which does 4:2:2 — so the same file
 * plays on the Mac and shows a black frame on Windows. We don't guess per
 * platform: if it isn't plain 4:2:0, we transcode it, everywhere. A file that
 * plays identically on every machine is worth more than a saved transcode.
 */

/** Containers the browser will demux. Note the absence of .avi — that alone
 *  sinks a DivX file no matter what's inside it. */
const PLAYABLE_CONTAINERS = new Set([".mp4", ".m4v", ".mov", ".webm"]);

/** Video codecs Chromium can decode (given a playable container). */
const PLAYABLE_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);

/** Chroma subsamplings its H.264 decoder handles. 4:2:2/4:4:4 are out; the "j"
 *  variants are the same subsampling at full range, and decode fine. */
const PLAYABLE_PIX_FMTS = new Set(["yuv420p", "yuvj420p"]);

/**
 * @param {{ext?: string, codec?: string|null, pixFmt?: string|null}} info
 *   ext: file extension INCLUDING the dot, any case (".AVI").
 *   codec/pixFmt: from ffprobe. null/undefined = we haven't probed it yet.
 * @returns {boolean} true if the file can go straight to a <video> element.
 */
export function browserCanPlay({ ext, codec, pixFmt } = {}) {
  if (!PLAYABLE_CONTAINERS.has(String(ext ?? "").toLowerCase())) return false;
  // Un-probed: we know nothing about the streams. Say no and let the caller
  // probe — claiming "playable" here is what produces a silent black frame.
  if (!codec) return false;
  if (!PLAYABLE_CODECS.has(codec)) return false;
  // Only H.264 is picky about chroma; VP8/VP9/AV1 are 4:2:0 by definition.
  if (codec === "h264" && !PLAYABLE_PIX_FMTS.has(String(pixFmt ?? "")))
    return false;
  return true;
}

/** Human-readable reason a file needs transcoding, for the UI and the logs.
 * @param {{ext?: string, codec?: string|null, pixFmt?: string|null}} info
 * @returns {string} "" when it plays as-is. */
export function whyTranscode({ ext, codec, pixFmt } = {}) {
  if (browserCanPlay({ ext, codec, pixFmt })) return "";
  const e = String(ext ?? "").toLowerCase();
  if (!PLAYABLE_CONTAINERS.has(e)) {
    return `${e || "this container"} isn't playable in the browser`;
  }
  if (!codec) return "unknown video format";
  if (!PLAYABLE_CODECS.has(codec)) return `${codec} video isn't playable`;
  return `${pixFmt} colour (4:2:2/4:4:4) isn't playable`;
}
