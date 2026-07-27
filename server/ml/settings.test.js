import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";

// Controllable writeFileSync/mkdirSync so a couple of tests can prove
// writeMlSettings distinguishes "you gave us something invalid" (a plain
// throw, 400 at the API layer) from "we couldn't save it"
// (MlSettingsPersistError, 500) — #161 fix round 1, Minor 4. Two DIFFERENT
// injection points matter here, not one: writeFileSync failing (ENOSPC —
// space exhaustion doesn't stop mkdirSync succeeding on an already-existing
// directory) and settingsFile()'s mkdirSync failing (EACCES/EROFS — a
// permissions or read-only-filesystem problem fails the mkdir BEFORE
// writeFileSync is ever reached, and readMlSettings() — called first, to
// read `current` — hits that exact same mkdirSync). #161 fix round 2 found
// that only wrapping writeFileSync left the mkdirSync path unguarded, so
// EACCES/EROFS — the review's own named targets — took the WRONG branch
// (a plain, unwrapped throw, misread by the route as a 400 validation
// failure) even though the ENOSPC-only test above was green. Everything
// else passes through to the real implementation, so every other test in
// this file still touches real files.
let failNextWrite = false;
let failNextMkdir = false;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdirSync: (...args) => {
      if (failNextMkdir) {
        failNextMkdir = false;
        throw Object.assign(new Error("EACCES: permission denied, mkdir"), {
          code: "EACCES",
        });
      }
      return actual.mkdirSync(...args);
    },
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
  effectiveThreshold,
  DEFAULT_NEAR_DUPE_WINDOW_MS,
  DEFAULT_REFINE_BELOW,
} from "./settings.js";
import { DEFAULT_MODEL_ID } from "./models.js";

let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "ag-mlset-"));
  process.env.AUTOGALLERY_HOME = cacheDir;
  failNextWrite = false;
  failNextMkdir = false;
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  delete process.env.AUTOGALLERY_HOME;
  failNextWrite = false;
  failNextMkdir = false;
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

  it("classifies an EACCES from settingsFile()'s mkdirSync as a persistence failure too, not a validation one (#161 fix round 2)", () => {
    // Unlike the ENOSPC/writeFileSync case above, this fails BEFORE
    // writeFileSync is ever reached — settingsFile()'s mkdirSync is called
    // first, by readMlSettings() (to read `current`), which has no try/catch
    // of its own around that specific call. A version of writeMlSettings
    // that only wraps writeFileSync would let this escape as a plain,
    // unwrapped Error — indistinguishable from the modelId validation
    // failure above, and misread by the API route as a 400.
    failNextMkdir = true;
    let thrown;
    try {
      writeMlSettings({ threads: 2 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MlSettingsPersistError);
    expect(thrown.message).toMatch(/EACCES|could not save/i);
  });
});

/**
 * The near-duplicate settings (#162). The one that matters is the null:
 * `nearDupeThreshold` stores "follow the active model" rather than a resolved
 * number, because SigLIP and CLIP disagree by ~0.05 on the case that decides
 * most groupings — so a number saved under one model and carried to the other
 * silently misses every re-framed duplicate.
 */
describe("near-duplicate settings", () => {
  it("defaults to the model's own threshold, not a stored number", () => {
    const s = readMlSettings();
    expect(s.nearDupeThreshold).toBeNull();
    expect(s.nearDupeWindowMs).toBe(DEFAULT_NEAR_DUPE_WINDOW_MS);
    // SigLIP is the default model, and 0.93 is its measured value.
    expect(effectiveThreshold(s)).toBe(0.93);
  });

  it("follows the new model when the model changes and no override is set", () => {
    // The whole reason null is stored instead of a number: this must become
    // CLIP's 0.88, not stay at SigLIP's 0.93.
    const s = writeMlSettings({ modelId: "Xenova/clip-vit-base-patch32" });
    expect(s.nearDupeThreshold).toBeNull();
    expect(effectiveThreshold(s)).toBe(0.88);
  });

  it("keeps an explicit override across a model switch", () => {
    writeMlSettings({ nearDupeThreshold: 0.8 });
    const s = writeMlSettings({ modelId: "Xenova/clip-vit-base-patch32" });
    expect(effectiveThreshold(s)).toBe(0.8);
  });

  it("takes null back as a reset to the model default", () => {
    writeMlSettings({ nearDupeThreshold: 0.8 });
    const s = writeMlSettings({ nearDupeThreshold: null });
    expect(s.nearDupeThreshold).toBeNull();
    expect(effectiveThreshold(s)).toBe(0.93);
  });

  it("clamps a threshold below the shared-genre band up to the floor", () => {
    // Two unrelated photos that merely share a genre already score 0.61-0.68,
    // so a threshold of 0 does not group "more aggressively" — every photo in
    // a window matches every other and whole minutes collapse into one stack.
    expect(writeMlSettings({ nearDupeThreshold: 0 }).nearDupeThreshold).toBe(
      0.5
    );
    expect(writeMlSettings({ nearDupeThreshold: 5 }).nearDupeThreshold).toBe(
      0.999
    );
  });

  it("clamps the window and survives a garbage value", () => {
    expect(writeMlSettings({ nearDupeWindowMs: 1 }).nearDupeWindowMs).toBe(
      3000
    );
    expect(
      writeMlSettings({ nearDupeWindowMs: 99_999_999 }).nearDupeWindowMs
    ).toBe(3_600_000);
    expect(writeMlSettings({ nearDupeWindowMs: "nope" }).nearDupeWindowMs).toBe(
      DEFAULT_NEAR_DUPE_WINDOW_MS
    );
  });
});

/**
 * The refiner bar (#216) — the threshold below which a pair the clock says
 * belongs together gets split apart instead.
 */
describe("the refiner threshold", () => {
  it("defaults to 0.6, well below the merge bar", () => {
    const s = readMlSettings();
    expect(s.refineBelow).toBe(DEFAULT_REFINE_BELOW);
    // The two bars ask opposite questions and must not converge: at the merge
    // bar (0.93) a refiner would split nearly every burst in the library.
    expect(s.refineBelow).toBeLessThan(effectiveThreshold(s));
  });

  it("accepts 0 as a real value — splitting off entirely", () => {
    // Not a falsy accident to be coerced back to the default: turning
    // splitting off is a legitimate choice, and the pre-#216 behaviour.
    expect(writeMlSettings({ refineBelow: 0 }).refineBelow).toBe(0);
  });

  it("caps well short of the merge bar", () => {
    expect(writeMlSettings({ refineBelow: 0.99 }).refineBelow).toBe(0.9);
    expect(writeMlSettings({ refineBelow: -1 }).refineBelow).toBe(0);
  });

  it("falls back to the default on a garbage value", () => {
    expect(writeMlSettings({ refineBelow: "loose" }).refineBelow).toBe(
      DEFAULT_REFINE_BELOW
    );
  });
});
