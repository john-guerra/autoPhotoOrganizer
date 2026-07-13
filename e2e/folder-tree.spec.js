import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors, tree } from "./helpers.js";

/**
 * The folder tree and its labels.
 *
 * Every test here is a bug that SHIPPED past a green unit suite and was caught
 * only by looking at the running app. That is the whole point of this tier: the
 * logic modules (folderTree.js, folderLabel.js) are unit-tested to death and were
 * all passing while the sidebar was rendering pure noise and two different groups
 * were drawing the same header.
 *
 * The fixture has a nested pair — Cards/Cam 1 and Cards/Cam 10 — under a parent
 * that holds no photos of its own. See e2e/fixture.mjs.
 */

/** The visible text of a label, with the greyed-out tokens removed — i.e. what
 * the eye actually lands on. `.part-keep` is the bright tier; `.part-dim` is
 * context. If a rule dims the wrong thing, this comes back empty or identical
 * between two rows, and that is precisely what shipped. */
async function emphasised(locator) {
  return (await locator.locator(".part-keep").allInnerTexts()).join("").trim();
}

test("the tree nests folders instead of listing full paths", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // The parent holds no photos — it exists only to hold its children — but it is
  // a row, and its children hang beneath it.
  await expect(tree.node(page, "Cards")).toBeVisible();
  await expect(tree.node(page, "Cam 1")).toBeVisible();
  await expect(tree.node(page, "Cam 10")).toBeVisible();

  // A leaf says only its own name. It does NOT restate its parent, let alone the
  // absolute path — that was the entire complaint, and the root row (which
  // legitimately shows the compacted chain down to the library) is the one place
  // a path may still appear.
  const leaf = await tree.label(page, "Cam 10").innerText();
  expect(leaf).toContain("Cam 10");
  expect(leaf).not.toContain("Cards");
  expect(leaf).not.toContain("/");

  expect(errors).toEqual([]);
});

test("the tree starts expanded when grouping by folder alone", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // Shipped bug: the auto-expand gate was `groupBy.length > 1`, which predates
  // folder being a hierarchy of its own — so the app's commonest grouping came up
  // collapsed and you had to unfold the library by hand.
  await expect(tree.node(page, "Cam 1")).toBeVisible();
  await expect(tree.node(page, "Cam 10")).toBeVisible();

  expect(errors).toEqual([]);
});

test("a folder's own name is what the eye lands on, not its path", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // Shipped bug: rarity alone lit up rare words in the middle of the PATH while
  // the folder's own name rendered entirely grey beneath them.
  const header = page.locator(".section-header", { hasText: "Cam 1" }).first();
  const bright = await emphasised(header.locator(".section-label"));

  expect(bright).not.toBe("");
  expect(bright).not.toContain("Cards"); // the path is context — it stays quiet

  expect(errors).toEqual([]);
});

test("two folders that differ by one character do not render identically", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  // Shipped bug: "Cam 1" and "Cam 10" share their date, their parent and the word
  // "Cam"; the ONLY difference is a bare number — which the date rule threw away.
  // Both headers rendered as the same string, and the feed showed two groups you
  // could not tell apart.
  const one = page.locator(".section-header", { hasText: "Cam 1" }).first();
  const ten = page.locator(".section-header", { hasText: "Cam 10" }).first();

  const brightOne = await emphasised(one.locator(".section-label"));
  const brightTen = await emphasised(ten.locator(".section-label"));

  expect(brightOne).not.toEqual(brightTen);

  expect(errors).toEqual([]);
});

test("a header keeps the folder's name when the path is too long to fit", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });
  // A narrow viewport forces the clip, which is the only way to see which END the
  // label sacrifices. Shipped bug: it cut the tail — dropping the folder's own
  // name and keeping the path, so sibling groups became indistinguishable.
  await page.setViewportSize({ width: 640, height: 800 });

  const label = page
    .locator(".section-header", { hasText: "Cam 10" })
    .first()
    .locator(".section-label");

  // Whatever is clipped, the name survives: the bright token is still on screen.
  await expect(label.locator(".part-keep").last()).toBeVisible();
  // And the full path is always one hover away.
  await expect(label).toHaveAttribute("title", /Cam 10/);

  expect(errors).toEqual([]);
});

test("a virtual ancestor folds every group beneath it", async ({ page }) => {
  const errors = trackPageErrors(page);
  await openApp(page, { groupBy: ["folder"] });

  const cardsIcon = tree.node(page, "Cards").locator(".tree-collapse-icon");
  await cardsIcon.click();

  // "Cards" has no photos of its own, so it has no group of its own to collapse —
  // it has to act on the groups beneath it, or the click is a no-op.
  for (const name of ["Cam 1", "Cam 10"]) {
    const header = page.locator(".section-header", { hasText: name }).first();
    const icon = await header
      .locator(".section-toggle-icon")
      .getAttribute("class");
    expect(icon).toContain("not-grid");
  }

  expect(errors).toEqual([]);
});
