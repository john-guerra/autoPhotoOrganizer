import { describe, it, expect } from "vitest";
import { extractVectors } from "./embedOutput.js";

/** A minimal stand-in for an onnxruntime/transformers.js Tensor. */
function tensor(dims, data) {
  return { dims, data };
}

describe("extractVectors", () => {
  const ctx = {
    modelId: "Xenova/clip-vit-base-patch32",
    outputKey: "image_embeds",
    dim: 4,
    batchSize: 2,
  };

  it("slices a well-formed [n, dim] tensor into one vector per image", () => {
    const t = tensor([2, 4], [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(extractVectors(t, ctx)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it(
    "rejects a 3-D tensor — e.g. SigLIP's last_hidden_state [n, 196, 768] " +
      "instead of the pooled pooler_output this app expects",
    () => {
      const t = tensor([2, 196, 768], new Array(2 * 196 * 768).fill(0));
      expect(() =>
        extractVectors(t, { ...ctx, outputKey: "pooler_output", dim: 768 })
      ).toThrow(/unexpected output shape/i);
    }
  );

  it("rejects a vector-width mismatch against the registry's dim", () => {
    const t = tensor([2, 512], new Array(1024).fill(0));
    expect(() => extractVectors(t, ctx)).toThrow(/unexpected output shape/i);
  });

  it("rejects a batch-size mismatch — closes mis-attribution, not just shape", () => {
    const t = tensor([3, 4], new Array(12).fill(0));
    expect(() => extractVectors(t, ctx)).toThrow(/unexpected output shape/i);
  });

  it("names the model id, output key, expected shape, and actual shape in the error", () => {
    const t = tensor([3, 4], new Array(12).fill(0));
    expect(() => extractVectors(t, ctx)).toThrow(
      /Xenova\/clip-vit-base-patch32.*image_embeds.*expected \[2, 4\].*got \[3, 4\]/
    );
  });

  it("rejects NaN rather than letting JSON.stringify silently turn it into null->0", () => {
    const t = tensor([2, 4], [1, 2, 3, NaN, 5, 6, 7, 8]);
    expect(() => extractVectors(t, ctx)).toThrow(/non-finite/i);
  });

  it("rejects Infinity the same way", () => {
    const t = tensor([2, 4], [1, 2, 3, Infinity, 5, 6, 7, 8]);
    expect(() => extractVectors(t, ctx)).toThrow(/non-finite/i);
  });
});
