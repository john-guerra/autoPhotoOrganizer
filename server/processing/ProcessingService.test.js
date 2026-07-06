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

  it("NodeProcessingService still throws on the not-yet-implemented engines", async () => {
    const svc = new NodeProcessingService();
    // RAW embedded-preview extraction and video poster frames come later.
    await expect(svc.extractPreview("/tmp/x.cr2")).rejects.toThrow(
      /not implemented/i
    );
    await expect(svc.videoThumb("/tmp/x.mov")).rejects.toThrow(
      /not implemented/i
    );
  });
});
