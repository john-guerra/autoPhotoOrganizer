import { describe, it, expect, beforeEach } from "vitest";
import {
  folderScope,
  idsScope,
  scopeFilterKeys,
  scopeChip,
  loadScope,
  persistScope,
  LS_SCOPE_PATH,
} from "./scope.js";

// This suite calls `localStorage` directly, as the plan specifies. The repo's
// vitest.config.js runs everything under `environment: "node"` (no DOM
// globals), and neither jsdom nor happy-dom is a repo dependency — see
// ui/src/lib/albumPrefs.js, which guards every access with
// `typeof localStorage !== "undefined"` for this exact reason. Rather than
// add a dependency or touch the shared vitest.config.js (out of scope for
// this task), stub a minimal in-memory localStorage here.
if (typeof localStorage === "undefined") {
  globalThis.localStorage = (() => {
    const store = new Map();
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  })();
}

describe("scope constructors", () => {
  it("builds a folder scope", () => {
    expect(folderScope("/photos/trip")).toEqual({
      kind: "folder",
      path: "/photos/trip",
    });
  });

  it("builds an ids scope", () => {
    expect(idsScope([3, 1, 2])).toEqual({ kind: "ids", ids: [3, 1, 2] });
  });

  it("treats an empty id list as no scope", () => {
    expect(idsScope([])).toBeNull();
    expect(idsScope(null)).toBeNull();
  });
});

describe("scopeFilterKeys", () => {
  it("is empty for no scope", () => {
    expect(scopeFilterKeys(null)).toEqual({});
  });

  it("projects a folder scope to the live folderPath predicate", () => {
    expect(scopeFilterKeys(folderScope("/photos/trip"))).toEqual({
      folderPath: "/photos/trip",
    });
  });

  it("projects an ids scope to the keepScope flag, never the ids themselves", () => {
    // The ids live server-side in keep_scope; the filter carries only a flag,
    // so the scope stays unbounded in size.
    expect(scopeFilterKeys(idsScope([1, 2, 3]))).toEqual({ keepScope: true });
  });
});

describe("scopeChip", () => {
  it("is null when unscoped", () => {
    expect(scopeChip(null)).toBeNull();
  });

  it("names the folder by its basename", () => {
    const chip = scopeChip(folderScope("/photos/2026-07-04 Trip"));
    expect(chip.text).toBe("2026-07-04 Trip");
    expect(chip.title).toContain("/photos/2026-07-04 Trip");
  });

  it("counts the photos for an ids scope", () => {
    const chip = scopeChip(idsScope([1, 2, 3]));
    expect(chip.text).toBe("3 photos");
  });

  it("says '1 photo', not '1 photos'", () => {
    expect(scopeChip(idsScope([7])).text).toBe("1 photo");
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a folder scope", () => {
    persistScope(folderScope("/photos/trip"));
    expect(loadScope()).toEqual({ kind: "folder", path: "/photos/trip" });
  });

  it("never persists an ids scope (session-only, as keepIds was)", () => {
    persistScope(idsScope([1, 2]));
    expect(loadScope()).toBeNull();
    expect(localStorage.getItem(LS_SCOPE_PATH)).toBeNull();
  });

  it("clears the stored scope when unscoped", () => {
    persistScope(folderScope("/photos/trip"));
    persistScope(null);
    expect(loadScope()).toBeNull();
  });
});
