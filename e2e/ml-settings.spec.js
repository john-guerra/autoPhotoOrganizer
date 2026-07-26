import { test, expect } from "@playwright/test";
import {
  trackPageErrors,
  openApp,
  openManageLibrary,
  mlSettings,
} from "./helpers.js";

/**
 * The ML settings panel (#161) — the only user-facing surface of image
 * embeddings.
 *
 * These specs NEVER turn embedding on. It is opt-in precisely because enabling
 * it downloads ~90 MB of model, and a test suite that fetches that against a
 * real host is a test suite that fails on a plane. Everything asserted here is
 * readable with the feature off, which is also the state every new user sees
 * first.
 */
test.describe("ML settings", () => {
  // The settings live in a JSON file under AUTOGALLERY_HOME, so they outlive a
  // spec exactly like ratings do — set them BEFORE as well as after. Before,
  // because `enabled` left true by a previous run or a manual dev session is
  // what would let a click here start a real 94 MB download; after, so the
  // next run's default isn't silently changed.
  test.beforeEach(async ({ page }) => {
    await page.request.put("/api/ml/settings", {
      data: { modelId: "Xenova/siglip-base-patch16-224", enabled: false },
    });
  });

  test.afterEach(async ({ page }) => {
    await page.request.put("/api/ml/settings", {
      data: { modelId: "Xenova/siglip-base-patch16-224", enabled: false },
    });
  });

  test("shows counts, model choice and the active provider", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await openManageLibrary(page);

    const panel = mlSettings.root(page);
    await expect(panel).toBeVisible();

    // "Not computed yet" and "cannot be computed" are different answers.
    // Collapsing them is how pre-2.17.14 backupCoverage misled a user.
    const counts = mlSettings.counts(page);
    await expect(counts).toContainText(/embedded/i);
    await expect(counts).toContainText(/failed/i);
    await expect(counts).toContainText(/not computed yet/i);

    await expect(mlSettings.provider(page)).not.toBeEmpty();
    await expect(mlSettings.model(page)).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("names the download size and licence before the enable toggle", async ({
    page,
  }) => {
    // Turning it on IS the consent to a ~90 MB download, so what is being
    // fetched and under what licence has to be readable BEFORE the click, not
    // after it.
    const errors = trackPageErrors(page);
    await openApp(page);
    await openManageLibrary(page);

    await expect(mlSettings.enable(page)).not.toBeChecked();

    const consent = mlSettings.consent(page);
    await expect(consent).toContainText(/MB/);
    await expect(consent).toContainText(/Licence:/);
    // The card is always one click away, because a licence line the user has
    // to take our word for is not much of a consent notice — and for some
    // models the honest answer is "the card declares nothing".
    await expect(
      consent.getByRole("link", { name: /model card/i })
    ).toHaveAttribute("href", /^https:\/\/huggingface\.co\//);

    expect(errors).toEqual([]);
  });

  test("never claims a licence the model's card does not declare", async ({
    page,
  }) => {
    // openai/clip-vit-base-patch32 declares NO licence: no `license` key in
    // its card metadata, none in the README body. (MIT belongs to the CLIP
    // *code* repo, which is a different artifact.) The panel says so, in the
    // one place where a confident guess would be worst — the moment the user
    // decides whether to download it.
    const errors = trackPageErrors(page);
    await openApp(page);
    await openManageLibrary(page);

    await mlSettings.model(page).selectOption("Xenova/clip-vit-base-patch32");

    const consent = mlSettings.consent(page);
    await expect(consent).toContainText(/not stated/i);
    await expect(consent).not.toContainText(/MIT/);
    await expect(
      consent.getByRole("link", { name: /model card/i })
    ).toHaveAttribute(
      "href",
      "https://huggingface.co/openai/clip-vit-base-patch32"
    );

    expect(errors).toEqual([]);
  });

  test("“Embed now” asks before spending the download while the feature is off", async ({
    page,
  }) => {
    // The endpoint force-starts a sweep even when embedding is switched off,
    // so this button is the one place a user who never opted in could still
    // trigger ~90 MB of download. It has to say so first. (Dismissing the
    // dialog is also what keeps this suite from ever fetching a model.)
    const errors = trackPageErrors(page);
    await openApp(page);
    await openManageLibrary(page);

    // This whole spec rests on the feature being OFF: that is what makes the
    // confirm fire, and dismissing the confirm is what stops the POST. If a
    // stray dev session left `enabled: true` in a shared AUTOGALLERY_HOME, no
    // dialog would appear, the click would POST with force:true, and the suite
    // would download 94 MB before failing. Assert the precondition instead of
    // assuming it.
    await expect(mlSettings.enable(page)).not.toBeChecked();

    let asked = null;
    page.on("dialog", (d) => {
      asked = d.message();
      d.dismiss();
    });
    await mlSettings.embedNow(page).click();

    expect(asked).toMatch(/MB/);
    await expect(mlSettings.message(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("switching the model warns about the fresh backfill and persists", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page);
    await openManageLibrary(page);

    await mlSettings.model(page).selectOption("Xenova/clip-vit-base-patch32");
    // The warning is the point: vectors from two models are not comparable, so
    // this starts a fresh backfill — and switching back is free.
    await expect(mlSettings.message(page)).toContainText(/backfill/i);

    await page.reload();
    await expect(page.locator(".thumb").first()).toBeVisible();
    await openManageLibrary(page);

    await expect(mlSettings.model(page)).toHaveValue(
      "Xenova/clip-vit-base-patch32"
    );
    expect(errors).toEqual([]);
  });

  test("a refused save is rendered in the server's own words, and the control goes back", async ({
    page,
  }) => {
    // The failure this covers is real and unreachable from a test machine:
    // ~/.autogallery read-only or full, which is the entire reason
    // MlSettingsPersistError exists. Two things have to happen, and the second
    // is the one that silently didn't: the user reads the EACCES message, AND
    // the checkbox goes back to OFF. A one-way `checked={settings.enabled}`
    // leaves it visibly ON — Svelte skips the DOM write because `false` is
    // already the value it cached — so the panel would claim a setting the
    // server never stored.
    const errors = trackPageErrors(page);
    await openApp(page);
    await openManageLibrary(page);
    await expect(mlSettings.enable(page)).not.toBeChecked();

    const eacces =
      "could not save ML settings: EACCES: permission denied, open '/Users/nobody/.autogallery/ml.json'";
    await page.route("**/api/ml/settings", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await route.fulfill({ status: 500, json: { error: eacces } });
    });

    await mlSettings.enable(page).click();

    await expect(mlSettings.message(page)).toContainText("EACCES");
    await expect(mlSettings.message(page)).toContainText(/permission denied/i);
    await expect(mlSettings.enable(page)).not.toBeChecked();

    // The stubbed 500 is the point of the spec, so it is the one response
    // trackPageErrors is allowed to have seen.
    expect(errors.filter((e) => !/500/.test(e))).toEqual([]);
  });

  test("the model picker refuses an id the server never vetted, in the server's own words", async ({
    page,
  }) => {
    // Not reachable from the <select> — this is the API-level half, asserting
    // the 400 carries a specific message at all. The spec above is what proves
    // the panel RENDERS such a message.
    const res = await page.request.put("/api/ml/settings", {
      data: { modelId: "evil/model" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/unknown model/i);
  });
});
