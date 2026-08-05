import { describe, it, expect } from "vitest";
import { faceCropUrl, CROP_CACHE_EPOCH } from "./faceCropUrl.js";

/**
 * The epoch is the only reason this module exists (#302).
 *
 * The server fix — keying the crop cache on the box rather than a reusable
 * face id — was correct and could not reach the user. A response already in
 * the browser's disk cache under
 * `Cache-Control: public, max-age=31536000, immutable` is served WITHOUT
 * contacting the server, and `immutable` suppresses revalidation even on a
 * reload. John was still seeing pre-reset faces on a build that contained the
 * server fix.
 *
 * Changing the URL is the only thing that escapes an entry already cached.
 */
describe("faceCropUrl", () => {
  it("carries a cache epoch, so a poisoned entry cannot be reused", () => {
    const url = faceCropUrl(7);
    expect(url).toContain(`v=${CROP_CACHE_EPOCH}`);
    // The pre-fix URL, byte for byte. Emitting it again would hit the very
    // cache entry this exists to step around.
    expect(url).not.toBe("/api/ml/faces/7/crop?size=160");
  });

  it("still addresses the right face at the right size", () => {
    expect(faceCropUrl(7)).toContain("/api/ml/faces/7/crop");
    expect(faceCropUrl(7, 320)).toContain("size=320");
  });

  it("returns null with no cover face, so the caller renders initials", () => {
    // A broken <img> is the failure mode this avoids: PeopleView shows the
    // person's initials instead.
    expect(faceCropUrl(null)).toBeNull();
    expect(faceCropUrl(undefined)).toBeNull();
    expect(faceCropUrl(0)).toBeNull();
  });
});
