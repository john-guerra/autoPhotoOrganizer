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

  it("NodeProcessingService is a ProcessingService whose methods throw NotImplemented", async () => {
    const svc = new NodeProcessingService();
    expect(svc).toBeInstanceOf(ProcessingService);
    await expect(svc.scan("/tmp")).rejects.toThrow(/not implemented/i);
    await expect(svc.metadata([])).rejects.toThrow(/not implemented/i);
  });
});
