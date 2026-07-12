import { describe, it, expect } from "vitest";
import {
  GROUP_RENDERERS,
  DEFAULT_RENDERER_ID,
  getRenderer,
  nextRendererId,
  isServerCollapsed,
} from "./groupRenderers.js";

describe("groupRenderers registry", () => {
  it("defaults to the grid, and falls back to it for an unknown id", () => {
    expect(DEFAULT_RENDERER_ID).toBe("grid");
    expect(getRenderer(undefined).id).toBe("grid");
    expect(getRenderer("nope").id).toBe("grid");
  });

  it("cycles grid → snapshot → collapsed → grid", () => {
    expect(nextRendererId("grid")).toBe("snapshot");
    expect(nextRendererId("snapshot")).toBe("collapsed");
    expect(nextRendererId("collapsed")).toBe("grid");
    expect(nextRendererId(undefined)).toBe("snapshot"); // undefined = grid
  });

  it("only the grid streams the group's photos into the feed", () => {
    expect(isServerCollapsed("grid")).toBe(false);
    expect(isServerCollapsed("snapshot")).toBe(true);
    expect(isServerCollapsed("collapsed")).toBe(true);
  });

  it("a collapsed group reserves NO band — the header alone represents it", () => {
    const ctx = { snapshotRowHeight: 148 };
    expect(getRenderer("collapsed").bandHeight(ctx)).toBe(0);
    expect(getRenderer("collapsed").component).toBeNull();
    expect(getRenderer("grid").bandHeight(ctx)).toBe(0);
    expect(getRenderer("snapshot").bandHeight(ctx)).toBe(148);
    expect(getRenderer("snapshot").component).not.toBeNull();
  });

  it("every renderer declares the fields the header/layout rely on", () => {
    for (const r of GROUP_RENDERERS) {
      expect(typeof r.id).toBe("string");
      expect(["grid", "strip", "bar"]).toContain(r.icon);
      expect(typeof r.needsFeedPhotos).toBe("boolean");
      expect(typeof r.bandHeight).toBe("function");
    }
    // ids are unique — the cycle and the lookup both assume it
    const ids = GROUP_RENDERERS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
