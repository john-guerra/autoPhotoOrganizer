import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";
import { readMlSettings, writeMlSettings, defaultThreads } from "./settings.js";
import { DEFAULT_MODEL_ID } from "./models.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-mlset-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
});

describe("ML settings", () => {
  it("defaults to SigLIP at half the cores", () => {
    const s = readMlSettings();
    expect(s.modelId).toBe(DEFAULT_MODEL_ID);
    expect(s.threads).toBe(defaultThreads());
  });

  it("defaults threads to half the cores, never below 1", () => {
    expect(defaultThreads()).toBe(Math.max(1, Math.floor(cpus().length / 2)));
  });

  it("persists a change", () => {
    writeMlSettings({ threads: 3 });
    expect(readMlSettings().threads).toBe(3);
  });

  it("rejects an unknown model rather than persisting it", () => {
    expect(() => writeMlSettings({ modelId: "evil/model" })).toThrow(
      /unknown model/i
    );
    expect(readMlSettings().modelId).toBe(DEFAULT_MODEL_ID);
  });

  it("clamps threads to the machine's core count", () => {
    writeMlSettings({ threads: 9999 });
    expect(readMlSettings().threads).toBeLessThanOrEqual(cpus().length);
    writeMlSettings({ threads: 0 });
    expect(readMlSettings().threads).toBe(1);
  });

  it("survives a corrupt settings file rather than crashing the server", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(cacheDir, "ml.json"), "{ not json");
    expect(readMlSettings().modelId).toBe(DEFAULT_MODEL_ID);
  });
});
