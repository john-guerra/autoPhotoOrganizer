import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors, grid, loupe, video } from "./helpers.js";
import { VIDEO, HEVC_VIDEO } from "./fixture.mjs";

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
 *  depends on dates, so no spec should assume a tile is at a fixed position.
 *
 *  SCROLLS, because the grid is virtualized: a tile below the fold has no DOM
 *  node at all, so scanning what is rendered right now only ever searches the
 *  first screenful. (This spec's first video happened to sit inside it; the
 *  second one didn't, and "no tile matched (searched 7)" in a 19-photo library is
 *  what that looks like.) */
async function firstTileMatching(page, pred) {
  const tiles = page.locator(".thumb");
  // The feed scrolls the COLUMN, not the grid — scrolling `.grid` is a silent
  // no-op that leaves you re-reading the same first screenful forever.
  const scroller = page.locator(".main-column");
  let lastTop = -1;
  for (;;) {
    const names = await tiles.evaluateAll((els) =>
      els.map((e) => e.getAttribute("title") ?? "")
    );
    const hit = names.findIndex(pred);
    if (hit !== -1) return hit;

    // Nothing here: page down and look again, until the feed stops moving.
    const top = await scroller.evaluate((el) => {
      el.scrollTop += el.clientHeight;
      return el.scrollTop;
    });
    if (top === lastTop) throw new Error("no tile matched (searched the feed)");
    lastTop = top;
    // Let the virtual window re-render before looking again — two frames, not a
    // sleep: the grid renders on rAF, so this waits for exactly the thing we need
    // and no longer.
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r))
        )
    );
  }
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

  test("the video NEXT to the one you're looking at starts converting before you get there", async ({
    page,
  }) => {
    // The wait was the complaint: an .avi can't be handed to a browser at all, so
    // it must be converted first — seconds for a small clip, MINUTES for a big
    // camcorder file — and we only started that work once the user had already
    // arrived and was staring at a spinner. The work is entirely predictable, it
    // was just started too late. Standing on the photo before it, we now ask the
    // server to get it ready.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: "folder" });

    // Every /api/video/:id the page asks for. The photo we open is NOT a video, so
    // the only way one of these can appear is the prefetch.
    const prepared = [];
    page.on("request", (r) => {
      const m = new URL(r.url()).pathname.match(/^\/api\/video\/(\d+)$/);
      if (m) prepared.push(m[1]);
    });

    // Stand on the JPEG immediately before the .avi.
    const aviIndex = await firstTileMatching(page, (n) =>
      n.includes(VIDEO.name)
    );
    const titles = await page
      .locator(".thumb")
      .evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
    const neighbour = aviIndex - 1;
    expect(
      titles[neighbour]?.endsWith(".jpg"),
      "the spec needs a PHOTO next to the video, so any /api/video call is the prefetch"
    ).toBe(true);

    await loupe.open(page, neighbour);
    await expect(page.locator(".loupe img").first()).toBeVisible();

    // We are looking at a photo — and the video beside it is already being made
    // ready. Nothing about the current photo would ever request this.
    await expect.poll(() => prepared.length).toBeGreaterThan(0);

    expect(errors).toEqual([]);
  });

  test("an HEVC clip this browser cannot decode is converted, and plays anyway", async ({
    page,
  }) => {
    // HEVC is not unplayable — it is unplayable ON SOME MACHINES. Chromium ships
    // no software decoder and enables the codec only where the OS/GPU has one, so
    // the same file plays natively on most Macs and shows NOTHING on a Windows box
    // without the HEVC Video Extension. We now offer the browser the original
    // rather than transcoding it everywhere (a transcode is CPU-minutes and a
    // second copy of every clip, wasted on every machine that could just play it).
    //
    // The safety net is what this spec pins: the app must ASK ITS OWN DECODER, and
    // convert when the answer is no. Playwright's Chromium HAS no HEVC — so this
    // browser IS the Windows user, and if we ever start trusting the server's
    // guess instead of the decoder's answer, this goes black right here.
    const errors = trackPageErrors(page);
    await openApp(page, { groupBy: "folder" });

    // Assert the premise, or the test could pass by playing HEVC natively and
    // prove nothing at all.
    const hasHevc = await page.evaluate(
      () =>
        document
          .createElement("video")
          .canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== ""
    );
    expect(
      hasHevc,
      "this browser must NOT decode HEVC for this spec to mean anything"
    ).toBe(false);

    const index = await firstTileMatching(page, (n) =>
      n.includes(HEVC_VIDEO.name)
    );
    await loupe.open(page, index);

    const player = video.player(page);
    await expect(player).toBeVisible({ timeout: 60000 });
    // The converted proxy — NOT /api/image/:id, which is the original the browser
    // just told us it cannot decode.
    await expect(player).toHaveAttribute("src", /\/api\/video\/\d+\/file/, {
      timeout: 60000,
    });

    // And it DECODES. videoWidth stays 0 for a file the browser can't render,
    // which is exactly what a black rectangle is.
    await expect
      .poll(() => player.evaluate((v) => v.videoWidth), {
        timeout: 30000,
        message: "the converted HEVC video should decode frames",
      })
      .toBeGreaterThan(0);

    expect(errors).toEqual([]);
  });
});
