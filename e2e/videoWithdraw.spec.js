import { test, expect } from "@playwright/test";
import {
  openApp,
  trackPageErrors,
  grid,
  loupe,
  clearVideoProxies,
} from "./helpers.js";
import { VIDEO } from "./fixture.mjs";

/**
 * Leaving a video withdraws its conversion (#305).
 *
 * > "if I try to see the videos on a folder with many videos in the loupe, it
 * > seems like I overflow the loading when I try to navigate to a video say 20
 * > videos ahead"
 *
 * A transcode is started by ARRIVING on a clip, and arriving is not wanting to
 * watch it. `loadVideo` fires from an `$effect` on every index change, so
 * scrubbing past twenty videos started twenty ffmpeg processes — and not
 * queued: the route's only gate is a per-photo dedup, so they ran CONCURRENTLY
 * and starved the clip the user actually stopped on.
 *
 * ## Why this asserts on the cancel REQUEST, not on ffmpeg
 *
 * The honest end-state assertion — "the encode stopped" — races the fixture:
 * `clip.avi` is small and can finish converting before a test can navigate
 * away, which would make the spec pass for the wrong reason on a fast machine
 * and fail on a slow one. The withdrawal itself is deterministic and is the
 * behaviour that was missing, so that is what is asserted.
 *
 * The fixture has two videos, not twenty. One is enough: twenty concurrent
 * conversions is what ONE un-withdrawn conversion looks like, twenty times.
 *
 * ## What this does NOT isolate, stated plainly
 *
 * Two code paths withdraw a conversion — `loadVideo`'s (the clip you opened)
 * and the prefetch's (its ±1 neighbour) — and when you STEP away one clip at a
 * time, the clip you opened passes through the ±1 window, so either path alone
 * satisfies this spec. Removing just one of them leaves it green; verified,
 * twice. Removing withdrawal entirely turns it red, so what is covered is the
 * BEHAVIOUR ("everything you left is withdrawn"), not each path.
 *
 * `loadVideo`'s own tracking is still load-bearing and is the reason it stays:
 * a JUMP (filmstrip, jump-to-group) moves past a clip without it ever being a
 * ±1 neighbour, so the prefetch path never sees it. Covering that wants a
 * fixture with a jump target and is not covered here.
 */
test("@p1 navigating away from a converting video withdraws the conversion", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await clearVideoProxies();

  // STUB the prepare response so the conversion never finishes.
  //
  // Letting the real one run made this vacuous and I watched it happen:
  // `clip.avi` converted in well under the time it takes to press a key, so
  // the job was already done, already untracked, and there was correctly
  // nothing to withdraw. The spec passed for the wrong reason on a fast
  // machine and would fail on a slow one.
  //
  // A 202 that never completes is what a big camcorder AVI looks like, and it
  // is the state the bug lives in. 2xx, so it does not trip `trackPageErrors`.
  //
  // A DISTINCT job id per photo, and that detail is the whole test. A single
  // shared id made this spec pass with the bug reinstated: the ±1 prefetch
  // withdraws its NEIGHBOUR's conversion, and with one id that is
  // indistinguishable from withdrawing the clip you actually left. Verified —
  // it did exactly that.
  const jobFor = (id) => `job-stub-305-${id}`;
  await page.route(/\/api\/video\/\d+(\?|$)/, (route) => {
    const id = route
      .request()
      .url()
      .match(/\/api\/video\/(\d+)/)[1];
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        preparing: true,
        jobId: jobFor(id),
        reason: ".avi isn't playable in the browser",
      }),
    });
  });

  /** @type {string[]} */
  const cancels = [];
  /** @type {string[]} */
  const prepares = [];
  // Registered BEFORE the app opens, and recorded into arrays rather than
  // awaited with `waitForRequest`: that only catches requests fired AFTER it
  // is called, and the prepare goes out during `loupe.open`. Whether it was
  // caught came down to scheduling — this spec timed out on exactly that.
  page.on("request", (r) => {
    if (/\/api\/video\/\d+(\?|$)/.test(r.url())) prepares.push(r.url());
    const m = r.url().match(/\/api\/jobs\/([^/]+)\/cancel/);
    if (m && r.method() === "POST") cancels.push(m[1]);
  });

  await openApp(page, { groupBy: "folder" });
  const index = await grid.tileMatching(page, (n) => n.includes(VIDEO.name));
  await loupe.open(page, index);

  // The loupe asked the server to prepare it. We do NOT wait for the
  // conversion — the whole point is to leave while it is still running.
  await expect
    .poll(() => prepares.length, {
      timeout: 15000,
      message: "opening a video should ask the server to prepare it",
    })
    .toBeGreaterThan(0);

  // Walk away — THREE steps, not one, and that distinction is the design.
  // Moving one step leaves the clip at ±1, which is exactly the prefetch
  // window: the app deliberately keeps the neighbour you might come back to.
  // Withdrawal is for clips you have genuinely left behind. (This spec asserted
  // one step first and failed, which is the window working as intended.)
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");

  // The conversion for the clip we left is withdrawn. Before #305 nothing ever
  // issued this: `loadVideo`'s `if (item?.id !== id) return` stopped the UI
  // being written and left the encode running to completion.
  await expect
    .poll(() => cancels.length, {
      timeout: 15000,
      message: "leaving a converting video should cancel its transcode job",
    })
    .toBeGreaterThan(0);

  // EVERY clip that was prepared and then left behind, not just one of them.
  //
  // "Something was cancelled" is too weak and I proved it: two conversions are
  // started here — the one you OPENED (by `loadVideo`, the broken path) and its
  // ±1 NEIGHBOUR (by the prefetch, which already withdrew correctly). Asserting
  // on a single id let the neighbour's withdrawal satisfy the test, so it stayed
  // green with the bug reinstated. Which request arrives first is not something
  // to reason about either — both are in flight.
  //
  // After walking three clips away, nothing prepared here is still in the ±1
  // window, so all of it must have been withdrawn.
  const preparedIds = [
    ...new Set(prepares.map((u) => u.match(/\/api\/video\/(\d+)/)[1])),
  ];
  expect(preparedIds.length).toBeGreaterThan(0);
  for (const id of preparedIds) {
    expect(cancels, `conversion for photo ${id} was left running`).toContain(
      jobFor(id)
    );
  }

  // The 404 is OURS: the withdrawal cancels `job-stub-305`, which the server
  // has never heard of because this spec invented it. Chromium logs every
  // non-2xx as a console error, so asserting a bare [] here would fail the
  // test for doing exactly what it set out to prove (AGENT-NOTES: "never
  // assert a bare [] in a test that stubs a failure").
  expect(errors.filter((e) => !/404/.test(e))).toEqual([]);
});

/**
 * Leaving a video RELEASES ITS CONNECTION, not just its picture (#305).
 *
 * The withdrawal above stops the ffmpeg process. It does nothing for the case
 * John actually reported, because his lecture folder is `.mov / h264 / yuv420p`
 * — `playbackPlan` returns `direct`, so **no conversion ever runs** and there
 * is nothing to withdraw. The loupe points `<video>` at the original file and
 * the browser streams it.
 *
 * `{#key item.id}` then tears the element down on navigation, and its comment
 * claimed that stopped playback. It stops the PICTURE. A detached element goes
 * on holding its connection until garbage collection, and Chrome allows six
 * per origin — so ten arrow presses fill the pool with abandoned loaders. The
 * clip you are on cannot get a connection (black frame, `readyState` 0), and
 * `/api/health` cannot be SENT, times out at 4 s, and the app reports the
 * server lost while the server answers everyone else in 1 ms.
 *
 * Measured on the reported folder, ten arrows, same build:
 *
 * | | released | not released |
 * |---|---|---|
 * | `/api/health` | 2 ms | 2116 ms |
 * | current clip | playing, `readyState` 4 | stuck at 0:00, `readyState` 0 |
 *
 * ## Why this asserts on the ELEMENT and not on that measurement
 *
 * The e2e fixture's videos are a few kilobytes. They finish instantly, hold no
 * connection, and cannot saturate anything — so the honest end-state assertion
 * ("health still answers") is green here whether or not the fix exists. Rather
 * than build a multi-hundred-megabyte fixture to make the suite slow AND
 * flaky, this holds a handle to the element Svelte has thrown away and asks
 * whether it was released. That is deterministic, it is the fix's actual
 * contract, and `ui/src/lib/releaseVideo.test.js` pins the three calls that
 * make it work.
 */
test("@p1 navigating away from a video releases the element, not just the picture", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await clearVideoProxies();
  await openApp(page, { groupBy: "folder" });

  const index = await grid.tileMatching(page, (n) => n.includes(VIDEO.name));
  await loupe.open(page, index);

  // A handle SURVIVES the element leaving the DOM, which is the only way to
  // ask a question about something Svelte has already destroyed.
  const video = await page
    .locator(".stage video")
    .elementHandle({ timeout: 20000 });
  expect(video).toBeTruthy();
  expect(await video.evaluate((v) => v.getAttribute("src"))).toBeTruthy();

  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => video.evaluate((v) => v.getAttribute("src")), {
      timeout: 10000,
      message:
        "the abandoned <video> kept its src, so it is still holding a connection",
    })
    .toBe(null);

  // Paused too — a decoder left running is CPU nobody asked for, on a clip
  // nobody is looking at.
  expect(await video.evaluate((v) => v.paused)).toBe(true);

  expect(errors.filter((e) => !/404/.test(e))).toEqual([]);
});
