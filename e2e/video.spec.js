import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors, grid, loupe, video } from "./helpers.js";
import { VIDEO } from "./fixture.mjs";

/**
 * The reported bug: "videos still don't reproduce in windows. the audio plays
 * but nothing can be seen."
 *
 * Chromium has no MPEG-4 Part 2 decoder and won't demux AVI at all, so an old
 * camcorder .avi (MPEG-4 video + MP3 audio) hands it an audio track it CAN play
 * and a video track it can't. The clip plays sound and shows a black rectangle —
 * which reads as a corrupt FILE rather than a missing codec, so the user blames
 * their photos. The app must transcode it and then play it.
 *
 * This lives in e2e because every part of it is a seam: the codec probe is in the
 * server, the decision is in a pure module, the transcode is a background job, and
 * the thing that actually broke while building it was a <progress> element in a
 * COMPLETELY UNRELATED component (JobsPanel), whose crash froze the loupe
 * mid-render. Only the browser sees that.
 */
/** Index of the first tile whose filename satisfies `pred`. The feed's order
 *  depends on dates, so no spec should assume a tile is at a fixed position. */
async function firstTileMatching(page, pred) {
  const tiles = page.locator(".thumb");
  const count = await tiles.count();
  for (let i = 0; i < count; i++) {
    const name = (await tiles.nth(i).getAttribute("title")) ?? "";
    if (pred(name)) return i;
  }
  throw new Error(`no tile matched (searched ${count})`);
}

test.describe("@p0 video playback", () => {
  test("an AVI the browser cannot decode is converted, then plays", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: "folder" });

    const index = await firstTileMatching(page, (n) => n.includes(VIDEO.name));
    await loupe.open(page, index);

    // While it converts, the user is TOLD so — not shown a black box.
    // (It may already be done by the time we look; either state is fine, an
    // empty loupe is not.)
    await expect(
      video.message(page).or(video.player(page)).first()
    ).toBeVisible();

    // And then it plays: a real <video>, pointed at the transcoded proxy.
    const player = video.player(page);
    await expect(player).toBeVisible({ timeout: 60000 });
    await expect(player).toHaveAttribute("src", /\/api\/video\/\d+\/file/);

    // It must actually DECODE — the whole point. videoWidth is 0 for a file the
    // browser can't render (which is exactly what the .avi did).
    await expect
      .poll(() => player.evaluate((v) => v.videoWidth), {
        timeout: 30000,
        message: "the converted video should decode frames",
      })
      .toBeGreaterThan(0);

    // The JobsPanel <progress> crash (a transcode job has no countable total, and
    // `progress.value = undefined` throws inside Svelte's flush) surfaced ONLY as
    // a page error — it froze the loupe without failing any assertion above.
    expect(errors).toEqual([]);
  });

  test("an ordinary photo still opens in the loupe with no video machinery", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: "folder" });

    // NOT tile 0: the video has no EXIF date, so it takes its file-creation date
    // (2.12.3) and can sort anywhere — including first. Pick a real .jpg.
    const index = await firstTileMatching(page, (name) =>
      name.endsWith(".jpg")
    );
    await loupe.open(page, index);

    await expect(page.locator(".loupe img").first()).toBeVisible();
    await expect(video.player(page)).toHaveCount(0);
    await expect(video.message(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
