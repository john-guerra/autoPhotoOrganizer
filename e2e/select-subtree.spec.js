import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, group, statusBar } from "./helpers.js";

/**
 * Selecting a folder means selecting what's IN it — including the folders under
 * it.
 *
 * The report: "I select a parent folder in the news feed, I want it to try to
 * select all the photos inside". It didn't. Two different halves of the app
 * disagreed about what a folder group contains: the CLICK unioned the subtree,
 * but the checkbox's own indicator counted only the folder's own photos. So a
 * parent could sit there reading "nothing selected" with every photo beneath it
 * selected — and a virtual ancestor, which owns no photos at all, counted zero of
 * zero and could never light up at all.
 *
 * This is e2e because the disagreement lives in the seam: the subtree comes from
 * the client-side folder trie, the ids come from the server, and the indicator is
 * derived from a cache shared by both. Every piece was individually right.
 */

// The fixture nests "…Cards/Cam 1" and "…Cards/Cam 10" under a Cards folder that
// holds NO photos of its own — a virtual ancestor, and the strongest case: if
// selection is scoped by equality on the folder's own path, this one matches
// nothing whatsoever.
const PARENT = "Cards";
const CHILD = "Cam 10";

test.describe("@p1 selecting a folder subtree", () => {
  test("clicking a parent folder selects the photos in the folders under it", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    expect(await statusBar.selectedCount(page)).toBe(0);

    const parent = group.folderHeader(page, PARENT);
    await group.selectBox(parent).click();

    // The parent owns no photos itself. Anything selected at all came from its
    // children, which is the whole point.
    await expect.poll(() => statusBar.selectedCount(page)).toBeGreaterThan(0);
    await expect.poll(() => group.selectStateOf(parent)).toBe("all");
  });

  test("a parent shows the PARTIAL state when only some of its subtree is selected", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    const child = group.folderHeader(page, CHILD);
    const parent = group.folderHeader(page, PARENT);

    // Select one child folder outright...
    await group.selectBox(child).click();
    await expect.poll(() => group.selectStateOf(child)).toBe("all");

    // ...and the parent must say "some". Reading "none" here was the bug: the
    // indicator was counting a set of photos that the click didn't act on.
    await expect.poll(() => group.selectStateOf(parent)).toBe("some");

    expect(errors).toEqual([]);
  });

  test("shift-click on a parent takes its whole subtree back OUT of the selection", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: ["folder"] });

    const parent = group.folderHeader(page, PARENT);
    const child = group.folderHeader(page, CHILD);

    await group.selectBox(child).click();
    await expect.poll(() => group.selectStateOf(parent)).toBe("some");
    const partial = await statusBar.selectedCount(page);
    expect(partial).toBeGreaterThan(0);

    // A plain click here would FILL the parent (it isn't fully selected yet), so
    // emptying a partially-selected folder used to take two clicks — the first of
    // them doing the opposite of what you wanted. Shift says "out", always.
    await group.selectBox(parent).click({ modifiers: ["Shift"] });

    await expect.poll(() => statusBar.selectedCount(page)).toBe(0);
    await expect.poll(() => group.selectStateOf(parent)).toBe("none");

    expect(errors).toEqual([]);
  });
});
