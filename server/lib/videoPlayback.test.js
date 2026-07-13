import { describe, it, expect } from "vitest";
import { browserCanPlay, whyTranscode } from "./videoPlayback.js";

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
