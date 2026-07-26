import { describe, it, expect } from "vitest";
import { candidateDevices } from "./devices.js";

describe("candidateDevices", () => {
  it("leads with CPU on darwin — a MEASURED result, not the usual default", () => {
    // THE ONE EMPIRICAL FINDING IN #161, pinned so it cannot be quietly
    // "corrected" back to an accelerator-first order. On darwin/arm64,
    // 2026-07-25, at the real production configuration (SigLIP base
    // patch16-224, batch=16, threads=2): cpu 38.93 ms/photo vs webgpu 60.98
    // ms/photo, and coreml threw on every batch above size 1. Full tables in
    // devices.js's own doc and in the spec's "Superseded 2026-07-25"
    // section. If you are changing this line, re-run
    // `ML_INTEGRATION=1 npx vitest run server/ml/OnnxMLService.test.js` on
    // the hardware in front of you and update BOTH with the new numbers.
    expect(candidateDevices("darwin", "arm64")).toEqual([
      "cpu",
      "webgpu",
      "coreml",
    ]);
  });

  it("still offers the accelerators on darwin, so a future fix can win them back", () => {
    // Order reflects today's measurement; REMOVING them would foreclose a
    // future model, a fixed onnxruntime-node/CoreML, or different hardware.
    const darwin = candidateDevices("darwin", "arm64");
    expect(darwin).toContain("webgpu");
    expect(darwin).toContain("coreml");
  });

  it("keeps win32/linux accelerator-first, which is an ASSUMPTION nobody has measured", () => {
    expect(candidateDevices("win32", "x64")).toEqual(["dml", "webgpu", "cpu"]);
    expect(candidateDevices("linux", "x64")).toEqual(["cuda", "webgpu", "cpu"]);
  });

  it("never tries CUDA on linux/arm64 — onnxruntime-node's prebuilt has no aarch64 CUDA", () => {
    expect(candidateDevices("linux", "arm64")).toEqual(["webgpu", "cpu"]);
  });

  it("guesses no accelerator name on an unknown platform", () => {
    expect(candidateDevices("freebsd", "x64")).toEqual(["cpu"]);
  });

  it("always ends somewhere that cannot fall through further: cpu is in every list", () => {
    // loadWithBestDevice throws for real if the LAST candidate fails, so
    // every platform's list must end in the guaranteed floor.
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["win32", "x64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["sunos", "x64"],
    ]) {
      expect(candidateDevices(platform, arch)).toContain("cpu");
    }
  });
});
