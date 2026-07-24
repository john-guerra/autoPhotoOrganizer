import { describe, it, expect } from "vitest";
import { groupSampleUrl } from "./api.js";

// fetchGroupSample itself just wraps `fetch(groupSampleUrl(...))` — the only
// logic worth a unit test is the URL it builds, in particular whether
// `&subtree=1` shows up (#142's aggregate snapshot strip). See
// server/api.js's `/api/group/sample` handler for the other half of this
// contract: it only widens a folder path to its whole subtree when
// `subtree=1` is present on the query string.
describe("groupSampleUrl", () => {
  const path = [{ dimension: "folder", value: "/L/Cards" }];

  it("has no subtree param by default", () => {
    const url = groupSampleUrl({ path, groupBy: ["folder"] });
    expect(url).not.toMatch(/subtree=/);
  });

  it("has no subtree param when explicitly false", () => {
    const url = groupSampleUrl({ path, groupBy: ["folder"], subtree: false });
    expect(url).not.toMatch(/subtree=/);
  });

  it("appends &subtree=1 when asked to sample the whole subtree", () => {
    const url = groupSampleUrl({ path, groupBy: ["folder"], subtree: true });
    expect(url).toMatch(/[?&]subtree=1(&|$)/);
  });

  it("still carries the rest of the query alongside subtree=1", () => {
    const url = groupSampleUrl({
      path,
      groupBy: ["folder"],
      slots: 8,
      subtree: true,
    });
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("groupBy")).toBe("folder");
    expect(params.get("slots")).toBe("8");
    expect(params.get("subtree")).toBe("1");
    expect(JSON.parse(params.get("path"))).toEqual(path);
  });
});
