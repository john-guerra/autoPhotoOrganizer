import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";

describe("applySchema — EXIF columns", () => {
  it("adds the EXIF columns and is idempotent", () => {
    const db = new Database(":memory:");
    applySchema(db);
    applySchema(db); // second run must not throw (idempotent ADD COLUMN)
    const cols = db
      .prepare("PRAGMA table_info(photos)")
      .all()
      .map((c) => c.name);
    for (const c of ["aperture", "shutter", "iso", "focal_length", "lens"]) {
      expect(cols).toContain(c);
    }
  });
});
