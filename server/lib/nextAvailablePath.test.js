import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextAvailablePath } from "./nextAvailablePath.js";

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ag-nextpath-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("nextAvailablePath", () => {
  it("returns the plain path when nothing collides", () => {
    expect(nextAvailablePath(dir, "photo.jpg")).toBe(join(dir, "photo.jpg"));
  });

  it("inserts ' (2)' before the extension when the name is taken", async () => {
    await writeFile(join(dir, "photo.jpg"), "x");
    expect(nextAvailablePath(dir, "photo.jpg")).toBe(
      join(dir, "photo (2).jpg")
    );
  });

  it("keeps incrementing past multiple existing collisions", async () => {
    await writeFile(join(dir, "photo.jpg"), "x");
    await writeFile(join(dir, "photo (2).jpg"), "x");
    await writeFile(join(dir, "photo (3).jpg"), "x");
    expect(nextAvailablePath(dir, "photo.jpg")).toBe(
      join(dir, "photo (4).jpg")
    );
  });

  it("handles filenames with no extension", async () => {
    await writeFile(join(dir, "IMG_0001"), "x");
    expect(nextAvailablePath(dir, "IMG_0001")).toBe(join(dir, "IMG_0001 (2)"));
  });

  it("handles filenames with multiple dots, preserving the final extension", async () => {
    await writeFile(join(dir, "trip.raw.cr2"), "x");
    expect(nextAvailablePath(dir, "trip.raw.cr2")).toBe(
      join(dir, "trip.raw (2).cr2")
    );
  });
});
