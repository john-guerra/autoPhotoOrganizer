import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors } from "./helpers.js";

/**
 * Remove-from-library on a NON-folder group header (#135). A kind/day/camera
 * group has no folder to delete, so Remove sends the group's photo ids to
 * POST /api/photos/remove. We intercept that request (fulfilling with an error
 * so the shared fixture DB is never actually mutated) and assert the button
 * appears on a non-folder header, arms on the first click, and sends real ids.
 * The seam here — header button → dispatch → fetch the group's ids → remove —
 * is exactly what a unit test can't see.
 */
test("@p1 Remove on a non-folder group sends that group's photo ids", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  // Group by kind so the first header ("image") is a solid non-folder group
  // (a day group can lead with a dateless, empty bucket that has no photos).
  await openApp(page, { groupBy: ["kind"] });

  const header = page.locator(".section-header").first();
  await header.hover(); // reveal the hover-gated group actions
  const remove = header.locator(".section-act").filter({ hasText: /^Remove$/ });
  await expect(remove).toBeVisible();

  let payload = null;
  // Fulfil with a SUCCESS so nothing is actually deleted from the shared fixture
  // DB (the request never reaches the server) AND the browser logs no failed-
  // resource console error. The client's follow-on feed refresh just reloads the
  // untouched photos.
  await page.route("**/api/photos/remove", async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ removed: true, photos: 0, folders: 0 }),
    });
  });

  await remove.click(); // first click ARMS the confirm
  const confirm = header
    .locator(".section-act")
    .filter({ hasText: /Confirm remove/ });
  await expect(confirm).toBeVisible();
  await confirm.click(); // second click: fetch the group's ids, then remove

  await expect.poll(() => payload).not.toBeNull();
  expect(Array.isArray(payload.ids)).toBe(true);
  expect(payload.ids.length).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
