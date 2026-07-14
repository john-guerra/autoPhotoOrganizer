import { describe, it, expect } from "vitest";
import {
  browserCanPlay,
  whyTranscode,
  playbackPlan,
  hevcMimeType,
} from "./videoPlayback.js";

describe("browserCanPlay", () => {
  it("plays the ordinary phone/camera video: MP4 + H.264 4:2:0", () => {
    expect(
      browserCanPlay({ ext: ".mp4", codec: "h264", pixFmt: "yuv420p" })
    ).toBe(true);
    // Full-range 4:2:0 is the same subsampling — it decodes fine, and it is what
    // most of the library actually is (437 of 1,173 files).
    expect(
      browserCanPlay({ ext: ".MP4", codec: "h264", pixFmt: "yuvj420p" })
    ).toBe(true);
    expect(
      browserCanPlay({ ext: ".mov", codec: "h264", pixFmt: "yuv420p" })
    ).toBe(true);
  });

  it("refuses the AVI/DivX file that plays sound but shows nothing", () => {
    // THE BUG. Chromium decodes the MP3 audio and has no MPEG-4 Part 2 video
    // decoder, so the user hears the clip and sees a black rectangle.
    expect(
      browserCanPlay({ ext: ".avi", codec: "mpeg4", pixFmt: "yuv420p" })
    ).toBe(false);
    expect(
      browserCanPlay({ ext: ".AVI", codec: "mjpeg", pixFmt: "yuvj422p" })
    ).toBe(false);
    // The container alone is disqualifying — Chromium won't even demux AVI.
    expect(
      browserCanPlay({ ext: ".avi", codec: "h264", pixFmt: "yuv420p" })
    ).toBe(false);
  });

  it("refuses 4:2:2 H.264 — it plays on macOS and shows black on Windows", () => {
    // The whole point of not guessing per platform: same file, same answer.
    expect(
      browserCanPlay({ ext: ".mp4", codec: "h264", pixFmt: "yuvj422p" })
    ).toBe(false);
    expect(
      browserCanPlay({ ext: ".mp4", codec: "h264", pixFmt: "yuv444p" })
    ).toBe(false);
  });

  it("refuses H.263, and any file we haven't probed yet", () => {
    expect(
      browserCanPlay({ ext: ".3gp", codec: "h263", pixFmt: "yuv420p" })
    ).toBe(false);
    // Un-probed must never be assumed playable: that assumption IS the black
    // frame. The caller probes instead.
    expect(browserCanPlay({ ext: ".mp4", codec: null, pixFmt: null })).toBe(
      false
    );
    expect(browserCanPlay({})).toBe(false);
  });

  it("does not care about chroma for codecs that have only one", () => {
    expect(browserCanPlay({ ext: ".webm", codec: "vp9", pixFmt: null })).toBe(
      true
    );
  });
});

describe("whyTranscode", () => {
  it("says nothing for a file that already plays", () => {
    expect(
      whyTranscode({ ext: ".mp4", codec: "h264", pixFmt: "yuv420p" })
    ).toBe("");
  });

  it("names the actual problem, so the UI can tell the user", () => {
    expect(whyTranscode({ ext: ".avi", codec: "mpeg4" })).toMatch(/\.avi/);
    expect(whyTranscode({ ext: ".mp4", codec: "mpeg4" })).toMatch(/mpeg4/);
    expect(
      whyTranscode({ ext: ".mp4", codec: "h264", pixFmt: "yuvj422p" })
    ).toMatch(/4:2:2/);
  });
});

describe("playbackPlan", () => {
  it("plays an ordinary MP4 straight from disk", () => {
    expect(
      playbackPlan({ ext: ".mp4", codec: "h264", pixFmt: "yuv420p" })
    ).toEqual({ mode: "direct" });
  });

  it("converts what no browser can decode, and says why", () => {
    const plan = playbackPlan({ ext: ".avi", codec: "mpeg4" });
    expect(plan.mode).toBe("transcode");
    expect(plan.reason).toMatch(/\.avi/);
  });

  it("hands HEVC back to the client to answer, instead of guessing for it", () => {
    // The point of the whole exercise: HEVC support belongs to the MACHINE, not
    // the file. Transcoding it everywhere burns CPU-minutes on every Mac that
    // decodes it in hardware; claiming it plays everywhere shows a black frame on
    // a Windows box without the codec. So: offer the original with the question
    // attached, and let the browser's own decoder settle it.
    const plan = playbackPlan({
      ext: ".mp4",
      codec: "hevc",
      pixFmt: "yuv420p",
    });
    expect(plan.mode).toBe("native-first");
    expect(plan.mimeType).toBe('video/mp4; codecs="hvc1.1.6.L93.B0"');
    expect(plan.reason).toMatch(/hevc/); // carried, for the fallback's job label
  });

  it("does not offer HEVC natively in a container the browser can't even open", () => {
    // No decoder can help you if the demuxer never gets there.
    expect(playbackPlan({ ext: ".mkv", codec: "hevc" }).mode).toBe("transcode");
  });
});

describe("hevcMimeType", () => {
  it("asks about the profile the file actually is — 8-bit Main vs 10-bit Main 10", () => {
    // Hardware that does one and not the other exists, so the profile is real
    // information and must not be faked.
    expect(hevcMimeType("yuv420p")).toBe('video/mp4; codecs="hvc1.1.6.L93.B0"');
    expect(hevcMimeType("yuv420p10le")).toBe(
      'video/mp4; codecs="hvc1.2.4.L93.B0"'
    );
  });

  it("is a full codec string — a bare 'hvc1' is answered EMPTY by Chromium", () => {
    // Verified in a real Chrome: canPlayType('video/mp4; codecs="hvc1"') → "" on
    // a machine that plays HEVC perfectly well. The parameters are mandatory, and
    // getting this wrong would silently transcode every HEVC file on every
    // machine — the exact waste this is meant to avoid, with no visible symptom.
    expect(hevcMimeType("yuv420p")).toMatch(/hvc1\.\d\.\d\.L\d+\.B\d+/);
  });
});
