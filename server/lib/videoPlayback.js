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

/** Codecs whose support DEPENDS ON THE MACHINE, so the server cannot answer for
 *  them (see playbackPlan). HEVC is the whole list: Chromium refuses to ship a
 *  software decoder for it, and enables it only where the OS/GPU can do it —
 *  present on most Macs, present on Windows only once the (free) HEVC Video
 *  Extension is installed, usually absent on Linux. Same app, same file, three
 *  answers. */
const MACHINE_DEPENDENT_CODECS = new Set(["hevc"]);

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

/**
 * The MIME type to ASK THE BROWSER about, for an HEVC stream.
 *
 * `canPlayType('video/mp4; codecs="hvc1"')` answers "" even on a machine with a
 * perfectly good HEVC decoder — Chromium only recognises a FULL codec string, so
 * the profile/compat/tier-level parameters are mandatory, not decoration.
 *
 * The level we claim is deliberately the LOWEST plausible one (L93 = 3.1) rather
 * than the file's real level, and that is the point: this string is not a
 * description of the file, it is the question "does this machine do HEVC at all?"
 * A decoder that can't manage 3.1 can't manage anything. Over-claiming the level
 * would make a capable machine answer "" and transcode a file it could have
 * played; under-claiming can only produce a false yes, and a false yes is caught
 * for free by the <video> element's own `error` event, which falls back to the
 * transcode. Wrong-and-recoverable beats right-and-pessimistic.
 *
 * The profile, on the other hand, is real: 8-bit is Main (profile 1, compat 6),
 * 10-bit is Main 10 (profile 2, compat 4), and hardware that does one but not
 * the other exists.
 *
 * @param {string|null} [pixFmt]
 * @returns {string}
 */
export function hevcMimeType(pixFmt) {
  const tenBit = /10/.test(String(pixFmt ?? ""));
  const profile = tenBit ? "2.4" : "1.6";
  return `video/mp4; codecs="hvc1.${profile}.L93.B0"`;
}

/**
 * What should the client do with this video?
 *
 *   { mode: "direct" }                  → play the original; the browser can decode it.
 *   { mode: "native-first", mimeType }  → ONLY THE CLIENT CAN SAY. Ask
 *                                         canPlayType(mimeType); play the original
 *                                         if it says yes, else ask us to transcode.
 *   { mode: "transcode", reason }       → the browser cannot decode it anywhere.
 *
 * The middle mode exists because the server is the wrong place to answer for
 * HEVC: a transcode is a CPU-minutes wait and a temporary copy of every clip, and
 * it is pure waste on the (many) machines whose GPU decodes HEVC natively and
 * instantly. But answering "yes" for all of them would show a black frame on the
 * machines that can't — the exact failure this module was written to kill. So we
 * hand the client the question and let it answer with its own decoder.
 *
 * @param {{ext?: string, codec?: string|null, pixFmt?: string|null}} info
 * @returns {{mode: "direct"} | {mode: "native-first", mimeType: string, reason: string} | {mode: "transcode", reason: string}}
 */
export function playbackPlan({ ext, codec, pixFmt } = {}) {
  if (browserCanPlay({ ext, codec, pixFmt })) return { mode: "direct" };
  const e = String(ext ?? "").toLowerCase();
  if (PLAYABLE_CONTAINERS.has(e) && MACHINE_DEPENDENT_CODECS.has(codec)) {
    return {
      mode: "native-first",
      mimeType: hevcMimeType(pixFmt),
      // Carried along so that IF the client falls back, the transcode it asks
      // for can explain itself in the same words as any other conversion.
      reason: whyTranscode({ ext, codec, pixFmt }),
    };
  }
  return { mode: "transcode", reason: whyTranscode({ ext, codec, pixFmt }) };
}
