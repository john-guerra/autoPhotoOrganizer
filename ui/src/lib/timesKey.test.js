import { describe, it, expect } from "vitest";
import { timesCacheKey } from "./timesKey.js";
import { scopeFilterKeys, idsScope } from "./scope.js";

describe("timesCacheKey — what the timeline is allowed to miss (#246)", () => {
  it("changes when the working set is replaced, even though the filter cannot tell", () => {
    // This is the whole bug, in three lines. Two DIFFERENT keep-only sets
    // project onto byte-identical filter keys, because the ids live
    // server-side and the filter carries only a flag.
    const a = scopeFilterKeys(idsScope([1, 2, 3]));
    const b = scopeFilterKeys(idsScope([9, 8, 7, 6]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // So the version counter is the only thing that can distinguish them.
    // Without it these two keys are equal and the timeline never refetches.
    expect(timesCacheKey(a, 0, 1)).not.toBe(timesCacheKey(b, 0, 2));
  });

  it("is stable when nothing has changed, so brushing never refetches", () => {
    // The other half of the contract, and the reason the key exists at all:
    // re-deriving with the same inputs must produce the same key, or the
    // histogram refetches while you are brushing inside it.
    const spec = { minRating: 3, keepScope: true };
    expect(timesCacheKey(spec, 4, 7)).toBe(timesCacheKey({ ...spec }, 4, 7));
  });

  it("changes when the library changes, with the scope untouched", () => {
    const spec = { keepScope: true };
    expect(timesCacheKey(spec, 1, 5)).not.toBe(timesCacheKey(spec, 2, 5));
  });

  it("does not confuse a library bump with a scope bump", () => {
    // Concatenating counters without a separator would make (12, 3) and
    // (1, 23) the same string. They are different states.
    const spec = {};
    expect(timesCacheKey(spec, 12, 3)).not.toBe(timesCacheKey(spec, 1, 23));
  });

  it("still distinguishes folder scopes, which vary on their own", () => {
    // A folder scope carries a path, so it never needed the counter. It goes
    // through the same code path regardless — the point is that adding the
    // counter did not break the case that already worked.
    const one = scopeFilterKeys({ kind: "folder", path: "/a" });
    const two = scopeFilterKeys({ kind: "folder", path: "/b" });
    expect(timesCacheKey(one, 0, 3)).not.toBe(timesCacheKey(two, 0, 3));
  });
});
