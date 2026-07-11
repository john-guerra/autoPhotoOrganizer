import { describe, it, expect } from "vitest";
import { ProcessingService } from "./ProcessingService.js";
import { NodeProcessingService } from "./NodeProcessingService.js";

describe("ProcessingService (smoke)", () => {
  it("exposes the interface methods", () => {
    const svc = new ProcessingService();
    for (const method of [
      "scan",
      "extractPreview",
      "thumbnail",
      "videoThumb",
      "metadata",
    ]) {
      expect(typeof svc[method]).toBe("function");
    }
  });

  it("NodeProcessingService is a ProcessingService", () => {
    const svc = new NodeProcessingService();
    expect(svc).toBeInstanceOf(ProcessingService);
  });

  it("videoThumb rejects (not silently resolves) for a nonexistent/undecodable file", async () => {
    const svc = new NodeProcessingService();
    // videoThumb is implemented (ffmpeg); a missing file must reject with the
    // VideoDecodeError surface, not hang or resolve. Real poster-frame behavior
    // is exercised in NodeProcessingService.test.js against a generated clip.
    await expect(
      svc.videoThumb("/tmp/does-not-exist.mov", 100)
    ).rejects.toMatchObject({ name: "VideoDecodeError" });
  });
});
