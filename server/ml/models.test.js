import { describe, it, expect } from "vitest";
import { MODELS, DEFAULT_MODEL_ID, modelById } from "./models.js";

describe("the model registry", () => {
  it("defaults to SigLIP base patch16-224", () => {
    expect(DEFAULT_MODEL_ID).toBe("Xenova/siglip-base-patch16-224");
  });

  it("carries what the loader and the storage layer each need", () => {
    for (const m of MODELS) {
      expect(m.id).toMatch(/^Xenova\//);
      expect(typeof m.label).toBe("string");
      expect(m.dim).toBeGreaterThan(0);
      // SigLIP's pooled output IS its embedding; CLIP needs its projection
      // head. Getting this wrong yields plausible vectors of the wrong shape.
      expect(["pooler_output", "image_embeds"]).toContain(m.outputKey);
      expect(["SiglipVisionModel", "CLIPVisionModelWithProjection"]).toContain(
        m.loader
      );
      expect(m.approxDownloadMB).toBeGreaterThan(0);
      // The settings panel promises the licence is visible BEFORE the user
      // consents to the download — a blank one there would be an empty
      // promise, so it is a registry invariant, not a UI detail.
      expect(m.licence).toMatch(/\S/);
    }
  });

  it("offers CLIP ViT-B/32 as the fast alternative at 512 dims", () => {
    const clip = modelById("Xenova/clip-vit-base-patch32");
    expect(clip.dim).toBe(512);
    expect(clip.outputKey).toBe("image_embeds");
  });

  it("gives SigLIP 768 dims", () => {
    expect(modelById(DEFAULT_MODEL_ID).dim).toBe(768);
  });

  it("throws on an unknown id rather than silently defaulting", () => {
    // Silently falling back would write vectors under a model name that never
    // ran — the worst possible failure, since nothing downstream could detect it.
    expect(() => modelById("evil/model")).toThrow(/unknown model/i);
  });
});
