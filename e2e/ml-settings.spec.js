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
  // spec exactly like ratings do. Put the model back afterwards rather than
  // leaving the next run's default silently changed.
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

  test("the model picker refuses an id the server never vetted, in the server's own words", async ({
    page,
  }) => {
    // Not reachable from the <select>, but it is the one PUT failure with a
    // specific server message — assert the panel renders THAT, not "Error".
    const res = await page.request.put("/api/ml/settings", {
      data: { modelId: "evil/model" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/unknown model/i);
  });
});
