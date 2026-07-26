import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";

// A controllable writeFileSync so ONE test can prove writeMlSettings
// distinguishes "you gave us something invalid" (a plain throw, 400 at the
// API layer) from "we couldn't save it" (MlSettingsPersistError, 500) —
// #161 fix round 1, Minor 4. Everything else passes through to the real
// implementation, so every other test in this file still touches real
// files.
let failNextWrite = false;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileSync: (...args) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw Object.assign(new Error("ENOSPC: no space left on device"), {
          code: "ENOSPC",
        });
      }
      return actual.writeFileSync(...args);
    },
  };
});

import {
  readMlSettings,
  writeMlSettings,
  defaultThreads,
  MlSettingsPersistError,
} from "./settings.js";
import { DEFAULT_MODEL_ID } from "./models.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-mlset-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  failNextWrite = false;
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
  failNextWrite = false;
});

describe("ML settings", () => {
  it("defaults to SigLIP at half the cores, embedding OFF", () => {
    const s = readMlSettings();
    expect(s.modelId).toBe(DEFAULT_MODEL_ID);
    expect(s.threads).toBe(defaultThreads());
    // #161 fix round 1 (Critical): opt-in, off by default. Models are
    // downloaded, never bundled — nothing may fetch one until the user has
    // explicitly turned this on.
    expect(s.enabled).toBe(false);
  });

  it("defaults threads to half the cores, never below 1", () => {
    expect(defaultThreads()).toBe(Math.max(1, Math.floor(cpus().length / 2)));
  });

  it("persists a change", () => {
    writeMlSettings({ threads: 3 });
    expect(readMlSettings().threads).toBe(3);
  });

  it("persists enabled, independently of the other fields", () => {
    writeMlSettings({ enabled: true });
    expect(readMlSettings()).toMatchObject({
      enabled: true,
      modelId: DEFAULT_MODEL_ID,
    });
    writeMlSettings({ enabled: false });
    expect(readMlSettings().enabled).toBe(false);
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

  it("treats a non-boolean stored enabled the same as a corrupt file: default, not crash", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(cacheDir, "ml.json"),
      JSON.stringify({ enabled: "yes please" })
    );
    expect(readMlSettings().enabled).toBe(false);
  });

  it("distinguishes a persistence failure (MlSettingsPersistError) from a validation failure (plain Error)", () => {
    // Validation failure — never reaches writeFileSync at all.
    expect(() => writeMlSettings({ modelId: "evil/model" })).toThrow(Error);
    try {
      writeMlSettings({ modelId: "evil/model" });
    } catch (err) {
      expect(err).not.toBeInstanceOf(MlSettingsPersistError);
    }

    // Persistence failure — validation passed, the disk write itself failed.
    failNextWrite = true;
    let thrown;
    try {
      writeMlSettings({ threads: 2 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MlSettingsPersistError);
    expect(thrown.message).toMatch(/ENOSPC|could not save/i);
  });
});
