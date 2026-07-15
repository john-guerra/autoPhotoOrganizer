import { test, expect } from "@playwright/test";
import { trackPageErrors, openApp, toolbar } from "./helpers.js";

test("@p1 the missing-files review pane opens from the Library menu and renders", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await openApp(page);

  // Open the ＋/Library menu, then the review entry.
  await toolbar.plus(page).click();
  await toolbar.menuItem(page, "Review missing files…").click();

  // The pane mounts and shows its heading + the empty state (the fixture
  // library has nothing missing — every scanned file is present on disk).
  const dialog = page.locator(".modal");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Missing files");
  await expect(dialog).toContainText(/nothing.s missing/i);

  expect(errors).toEqual([]);
});
